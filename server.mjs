// server.mjs — 浏览器桥接服务（HTTP 长轮询，零依赖）
// 运行在 DSH 侧；Edge 扩展以长轮询方式取任务、回结果。
import http from 'node:http';

const PORT = Number(process.env.BRIDGE_PORT || 7233);
const HOST = process.env.BRIDGE_HOST || '127.0.0.1';
const RPC_TIMEOUT = Number(process.env.BRIDGE_RPC_TIMEOUT || 30000);
const POLL_HOLD = 20000;
const EXT_LIVE_MS = 30000;
const DEBUG = !!process.env.BRIDGE_DEBUG;

const queue = [];
const inflight = new Map();
let pollers = [];
let seq = 0;
const ext = { lastSeen: 0, client: null, hello: null };
const startedAt = Date.now();

const now = () => Date.now();
const extLive = () => now() - ext.lastSeen < EXT_LIVE_MS;
const wire = (job) => ({ id: job.id, op: job.op, args: job.args });
const dbg = (...a) => { if (DEBUG) console.log('[dbg]', ...a); };

function send(res, code, obj, headers = {}) {
  if (res.writableEnded) return;
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(body);
}

function noContent(res) {
  if (res.writableEnded) return;
  res.writeHead(204, { 'cache-control': 'no-store' });
  res.end();
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.setEncoding('utf8');
    req.on('data', (c) => {
      buf += c;
      if (buf.length > 8e6) {
        reject(new Error('body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(buf ? JSON.parse(buf) : {});
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function dropPoller(p) {
  const i = pollers.indexOf(p);
  if (i >= 0) pollers.splice(i, 1);
  clearTimeout(p.timer);
}

// 有任务时唤醒挂起的长轮询
function wakePoller() {
  dbg(`wake pollers=${pollers.length} queue=${queue.length}`);
  while (pollers.length) {
    const p = pollers[0];
    if (p.res.writableEnded) {
      dbg('drop ended poller');
      dropPoller(p);
      continue;
    }
    const job = queue.shift();
    if (!job) return;
    dropPoller(p);
    try {
      send(p.res, 200, wire(job));
      dbg(`delivered #${job.id} ${job.op}`);
    } catch (e) {
      dbg('deliver failed:', (e && e.message) || e);
      queue.unshift(job);
      return;
    }
    return;
  }
  dbg('no pollers to wake');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  // 只记录来自浏览器（非 node CLI）的请求，便于判断扩展是否真的连上来了
  const ua = String(req.headers['user-agent'] || '');
  if (!/node/i.test(ua)) console.log(`[bridge] ${req.method} ${url.pathname} ua="${ua.slice(0, 50)}"`);
  try {
    if (req.method === 'GET' && url.pathname === '/') {
      const body = `<meta charset="utf-8"><h3>DSH 浏览器桥</h3>
<p>扩展连接: <b>${extLive() ? '在线' : '离线'}</b> · 队列 ${queue.length} · 等待结果 ${inflight.size}</p>
<p><a href="/status">/status</a></p>`;
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(body);
    }

    if (req.method === 'GET' && url.pathname === '/status') {
      return send(res, 200, {
        ok: true,
        extLive: extLive(),
        client: ext.client,
        hello: ext.hello,
        queued: queue.length,
        inflight: inflight.size,
        pollers: pollers.length,
        uptimeSec: Math.round((now() - startedAt) / 1000),
      });
    }

    // 扩展注册/心跳
    if (req.method === 'POST' && url.pathname === '/hello') {
      const body = await readBody(req);
      ext.lastSeen = now();
      ext.client = String(body.client || 'edge-ext');
      ext.hello = { version: body.version || null, ua: body.ua || null, at: ext.lastSeen };
      return send(res, 200, { ok: true });
    }

    // 扩展长轮询取任务
    if (req.method === 'GET' && url.pathname === '/next') {
      ext.lastSeen = now();
      ext.client = String(url.searchParams.get('client') || 'edge-ext');
      const job = queue.shift();
      if (job) return send(res, 200, wire(job));

      const holder = { res, timer: null };
      holder.timer = setTimeout(() => {
        dropPoller(holder);
        noContent(res);
      }, POLL_HOLD);
      pollers.push(holder);
      dbg(`park poller total=${pollers.length} client=${ext.client}`);
      // 注意：不能用 req.on('close')——无 body 的 GET 读完请求体就会触发，挂起项会被立刻删掉。
      res.on('close', () => {
        dbg('parked res close, ended=' + res.writableEnded);
        dropPoller(holder);
      });
      res.on('error', () => dropPoller(holder));
      return;
    }

    // 扩展回结果
    if (req.method === 'POST' && url.pathname === '/result') {
      const body = await readBody(req);
      ext.lastSeen = now();
      const id = Number(body.id);
      const job = inflight.get(id);
      if (!job) return send(res, 200, { ok: false, error: 'unknown job id' });
      clearTimeout(job.timer);
      inflight.delete(id);
      job.settle(
        body.ok
          ? { ok: true, data: body.data === undefined ? null : body.data }
          : { ok: false, error: body.error || '操作失败' }
      );
      dbg(`result #${id} ${body.ok ? 'ok' : 'ERR'}`);
      return send(res, 200, { ok: true });
    }

    // CLI 发起调用
    if (req.method === 'POST' && url.pathname === '/rpc') {
      const body = await readBody(req);
      const op = String(body.op || '');
      const args = body.args || {};
      if (!op) return send(res, 400, { ok: false, error: 'missing op' });
      if (!extLive()) {
        return send(res, 503, {
          ok: false,
          error: '浏览器扩展未连接：请确认 Edge 已加载「DSH Browser Bridge」扩展，且桥接服务正在运行',
        });
      }
      const job = { id: ++seq, op, args };
      // resolve-only：任何路径都不会产生未处理的 rejection
      const outcome = new Promise((resolve) => {
        job.settle = resolve;
        job.timer = setTimeout(() => {
          inflight.delete(job.id);
          const qi = queue.indexOf(job);
          if (qi >= 0) queue.splice(qi, 1);
          resolve({ ok: false, error: `操作超时 ${RPC_TIMEOUT}ms: ${op}` });
        }, RPC_TIMEOUT);
        inflight.set(job.id, job);
      });
      queue.push(job);
      dbg(`queued #${job.id} ${op}`);
      wakePoller();
      const out = await outcome;
      return send(res, 200, out);
    }

    return send(res, 404, { ok: false, error: 'not found', path: url.pathname });
  } catch (e) {
    return send(res, 500, { ok: false, error: String((e && e.message) || e) });
  }
});

server.on('error', (e) => {
  if (e && e.code === 'EADDRINUSE') {
    console.log(`[bridge] 端口 ${PORT} 已被占用，说明服务已在运行，本次启动跳过`);
    process.exit(0);
  }
  console.error('[bridge] 服务启动失败:', (e && e.message) || e);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`[bridge] listening http://${HOST}:${PORT}  (rpc 超时 ${RPC_TIMEOUT}ms)`);
});

// 兜底：任何漏网的异步错误都不许打挂服务
process.on('unhandledRejection', (e) => {
  console.error('[bridge] unhandledRejection:', (e && e.message) || e);
});
process.on('uncaughtException', (e) => {
  console.error('[bridge] uncaughtException:', (e && e.stack) || e);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`[bridge] ${sig} 退出`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500);
  });
}

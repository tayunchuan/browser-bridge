// offscreen.js — 常驻文档，负责与本地桥接服务保持长轮询连接。
// 注意：offscreen 文档只拿得到 chrome.runtime，chrome.storage 之类是不可用的，
// 所以端口不能从 storage 读，只能写死或用 URL 参数传。

const params = new URLSearchParams(location.search);
const PORT = Number(params.get('port') || 7233);
const VERSION = (() => {
  try {
    return chrome.runtime.getManifest().version;
  } catch {
    return '';
  }
})();

let backoff = 400;

async function hello() {
  try {
    await fetch(`http://127.0.0.1:${PORT}/hello`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client: 'edge-ext', version: VERSION, ua: navigator.userAgent }),
      signal: AbortSignal.timeout(3000),
    });
  } catch {}
}

async function loop() {
  await hello();
  for (;;) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/next?client=edge-ext`, {
        signal: AbortSignal.timeout(30000),
      });
      backoff = 400;
      if (r.status === 204) continue;
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const job = await r.json();

      let payload;
      try {
        const out = await chrome.runtime.sendMessage({ type: 'op', op: job.op, args: job.args || {} });
        payload =
          out && out.ok
            ? { id: job.id, ok: true, data: out.data === undefined ? null : out.data }
            : { id: job.id, ok: false, error: (out && out.error) || '服务工作线程无响应' };
      } catch (e) {
        payload = { id: job.id, ok: false, error: '服务工作线程异常: ' + ((e && e.message) || e) };
      }

      await fetch(`http://127.0.0.1:${PORT}/result`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(8000),
      });
    } catch (e) {
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 5000);
      hello();
    }
  }
}

loop();

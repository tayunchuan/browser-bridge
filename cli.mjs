// cli.mjs — DSH 侧浏览器操作命令行
// 用法: node cli.mjs <command> [args] [--tab <id>]
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.BRIDGE_PORT || 7233);
const BASE = `http://127.0.0.1:${PORT}`;
const STATE_FILE = join(__dirname, '.state.json');
const SHOT_DIR = join(__dirname, 'shots');

const argv = process.argv.slice(2);
const cmd = argv[0];
const pos = [];
const opt = {};
for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const eq = a.indexOf('=');
    if (eq > 0) opt[a.slice(2, eq)] = a.slice(eq + 1);
    else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) opt[a.slice(2)] = argv[++i];
    else opt[a.slice(2)] = true;
  } else pos.push(a);
}

function readState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}
function writeState(patch) {
  const next = { ...readState(), ...patch };
  writeFileSync(STATE_FILE, JSON.stringify(next, null, 2));
}

async function rpc(op, args = {}, timeoutMs = 35000) {
  let r;
  try {
    r = await fetch(`${BASE}/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op, args }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    if (String(e).includes('timeout') || e.name === 'TimeoutError') throw new Error(`桥接服务无响应（${op}）`);
    throw new Error(`连不上桥接服务 ${BASE}：先启动 server.mjs`);
  }
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || '操作失败');
  return j.data;
}

async function resolveTab() {
  const tabs = await rpc('tabs.list').catch(() => []);
  const shared = (tabs || []).filter((t) => t.shared);

  if (opt.tab !== undefined) {
    const id = Number(opt.tab);
    if (!Number.isFinite(id)) throw new Error('--tab 需要数字');
    writeState({ tabId: id });
    return id;
  }

  const st = readState();
  if (Number.isFinite(st.tabId) && shared.some((t) => t.id === st.tabId)) return st.tabId;
  if (shared.length) {
    writeState({ tabId: shared[0].id });
    return shared[0].id;
  }
  if (Number.isFinite(st.tabId)) writeState({ tabId: undefined });
  throw new Error('没有共享的标签页：用 `open <url>` 新开，或在扩展弹窗里点「共享当前标签页」');
}

function pad(s, n) {
  s = String(s);
  let w = 0;
  for (const ch of s) w += ch.charCodeAt(0) > 255 ? 2 : 1;
  return s + ' '.repeat(Math.max(0, n - w));
}

function fmtSnapshot(s) {
  const L = [];
  L.push(`# ${s.title || '(无标题)'}`);
  L.push(s.url);
  L.push(`viewport ${s.vw}x${s.vh}  scroll ${s.sy}/${s.dh}${s.truncated ? '  (列表已截断)' : ''}`);
  if (s.text) {
    L.push('', '[text]', s.text);
  }
  L.push('', '[elements]');
  for (const it of s.items || []) {
    L.push(`${pad(it.ref, 5)}${pad(it.role, 11)}${JSON.stringify(it.name)}${it.extra ? '  ' + it.extra : ''}`);
  }
  if (!s.items || !s.items.length) L.push('(无可见可交互元素)');
  return L.join('\n');
}

function j(v) {
  return JSON.stringify(v);
}

async function main() {
  if (!cmd) {
    console.log(`用法: node cli.mjs <command> [--tab <id>]

  status                 桥接/扩展状态
  tabs                   列标签页（含是否已共享）
  open <url>             新开标签页并共享（自动成为当前 tab）
  share [tabId]          共享当前标签页
  unshare [tabId]        取消共享
  close [tabId]          关闭标签页
  goto <url>             跳转
  back | forward | reload
  snap [--max N] [--no-text]     页面快照（可交互元素 + 文本）
  text [--limit N]       页面纯文本
  click <ref|css|text=..>
  fill <ref|css> <text>
  type <ref|css> <text>
  press <Enter|Tab|Escape|...>
  select <ref|css> <value|选项文本>
  scroll [--to top|bottom] [--dy px] [--spec sel]
  eval <js表达式>
  wait <毫秒> | wait --spec <css>
  shot [文件名]          截图到 shots/`);
    return;
  }

  switch (cmd) {
    case 'status': {
      let st;
      try {
        st = await fetch(`${BASE}/status`, { signal: AbortSignal.timeout(3000) }).then((r) => r.json());
      } catch {
        throw new Error(`连不上桥接服务 ${BASE}：先启动 server.mjs`);
      }
      console.log(`桥接服务 http://127.0.0.1:${PORT}  已运行 ${st.uptimeSec}s`);
      console.log(`扩展连接: ${st.extLive ? '在线' : '离线'}${st.hello && st.hello.version ? `  v${st.hello.version}` : ''}`);
      if (st.hello && st.hello.ua) console.log(`UA: ${String(st.hello.ua).slice(0, 90)}`);
      console.log(`队列 ${st.queued} / 进行中 ${st.inflight}`);
      if (st.extLive) {
        try {
          const p = await rpc('ping', {}, 5000);
          console.log(`扩展自检: ok ${p && p.version ? 'v' + p.version : ''}`);
        } catch (e) {
          console.log(`扩展自检失败: ${e.message}`);
        }
      }
      return;
    }

    case 'tabs': {
      const tabs = await rpc('tabs.list');
      const st = readState();
      for (const t of tabs || []) {
        const cur = t.id === st.tabId ? '*' : ' ';
        const desc = t.shared ? `${j(t.title || '')}  ${t.url || ''}` : '(未共享)';
        console.log(`${cur} ${pad(t.id, 8)} ${t.active ? 'ACTIVE' : '      '} ${t.shared ? 'SHARED' : '      '} ${desc}`);
      }
      if (!(tabs || []).length) console.log('(无标签页)');
      return;
    }

    case 'open': {
      const url = pos[0];
      if (!url) throw new Error('需要 url');
      const r = await rpc('tabs.open', { url, active: opt.background ? false : true });
      writeState({ tabId: r.tabId });
      console.log(`已打开 tab ${r.tabId}  ${r.url || url}`);
      return;
    }

    case 'share': {
      const id = pos[0] ? Number(pos[0]) : (await rpc('tabs.current')).tabId;
      await rpc('tabs.share', { tabId: id });
      writeState({ tabId: id });
      console.log(`已共享 tab ${id}`);
      return;
    }

    case 'unshare': {
      const id = pos[0] ? Number(pos[0]) : (await resolveTab());
      await rpc('tabs.unshare', { tabId: id });
      console.log(`已取消共享 tab ${id}`);
      return;
    }

    case 'close': {
      const id = pos[0] ? Number(pos[0]) : (await resolveTab());
      await rpc('tabs.close', { tabId: id });
      const st = readState();
      if (st.tabId === id) writeState({ tabId: undefined });
      console.log(`已关闭 tab ${id}`);
      return;
    }

    case 'goto': {
      const url = pos[0];
      if (!url) throw new Error('需要 url');
      const tabId = await resolveTab();
      const r = await rpc('nav.goto', { tabId, url });
      console.log(`tab ${tabId} -> ${r.url || url}  ${j(r.title || '')}`);
      return;
    }

    case 'back':
    case 'forward':
    case 'reload': {
      const tabId = await resolveTab();
      const r = await rpc(`nav.${cmd}`, { tabId });
      console.log(`tab ${tabId} ${cmd} -> ${r.url || ''}  ${j(r.title || '')}`);
      return;
    }

    case 'snap': {
      const tabId = await resolveTab();
      const s = await rpc('page.snapshot', {
        tabId,
        max: opt.max ? Number(opt.max) : 150,
        noText: !!opt['no-text'],
        limit: opt.limit ? Number(opt.limit) : 900,
      });
      console.log(fmtSnapshot(s));
      return;
    }

    case 'text': {
      const tabId = await resolveTab();
      const s = await rpc('page.text', { tabId, limit: opt.limit ? Number(opt.limit) : 6000 });
      console.log(s.text || '(空)');
      return;
    }

    case 'click': {
      const tabId = await resolveTab();
      const spec = pos[0];
      if (!spec) throw new Error('需要元素 ref / css / text=...');
      const r = await rpc('page.click', { tabId, spec });
      console.log(`clicked ${j(r.clicked.name || '')} <${r.clicked.tag}>`);
      if (r.newTabId) {
        writeState({ tabId: r.newTabId });
        console.log(`新标签页已打开并自动共享: tab ${r.newTabId}`);
      } else if (r.url) {
        console.log(`当前页 -> ${r.url}`);
      }
      return;
    }

    case 'fill':
    case 'type': {
      const tabId = await resolveTab();
      const spec = pos[0];
      const text = pos.slice(1).join(' ');
      if (!spec) throw new Error('需要元素 ref / css');
      const r = await rpc(`page.${cmd}`, { tabId, spec, text });
      console.log(`${cmd === 'fill' ? 'filled' : 'typed'} ${j(spec)} value=${j(r.value === undefined ? '' : r.value)}`);
      return;
    }

    case 'press': {
      const tabId = await resolveTab();
      const key = pos[0] || 'Enter';
      const r = await rpc('page.press', { tabId, key, spec: pos[1] });
      console.log(`pressed ${key}${r.active ? `  (focus: ${j(r.active.name || r.active.tag)})` : ''}`);
      return;
    }

    case 'select': {
      const tabId = await resolveTab();
      const spec = pos[0];
      const value = pos.slice(1).join(' ');
      const r = await rpc('page.select', { tabId, spec, value });
      console.log(`selected ${j(r.label)} value=${j(r.selected)}`);
      return;
    }

    case 'scroll': {
      const tabId = await resolveTab();
      const r = await rpc('page.scroll', {
        tabId,
        to: opt.to,
        dy: opt.dy ? Number(opt.dy) : undefined,
        spec: opt.spec || pos[0],
      });
      console.log(`scrollY ${r.scrollY}/${r.docH}`);
      return;
    }

    case 'eval': {
      const tabId = await resolveTab();
      const js = pos.join(' ');
      if (!js) throw new Error('需要 JS 表达式');
      const r = await rpc('page.eval', { tabId, js });
      console.log(typeof r.value === 'string' ? r.value : JSON.stringify(r.value, null, 2));
      return;
    }

    case 'wait': {
      const tabId = await resolveTab();
      const r = await rpc('page.wait', {
        tabId,
        ms: opt.spec ? undefined : Number(pos[0] || 1000),
        spec: opt.spec || undefined,
        timeout: opt.timeout ? Number(opt.timeout) : 10000,
      });
      console.log(r.found !== undefined ? `found after ${r.found}ms` : `waited ${r.waited}ms`);
      return;
    }

    case 'shot': {
      const tabId = await resolveTab();
      const r = await rpc('page.shot', { tabId });
      mkdirSync(SHOT_DIR, { recursive: true });
      const name = pos[0] || `shot-${Date.now()}.png`;
      const file = join(SHOT_DIR, name.endsWith('.png') ? name : name + '.png');
      writeFileSync(file, Buffer.from(String(r.dataUrl).split(',')[1] || '', 'base64'));
      console.log(file);
      return;
    }

    default:
      throw new Error(`未知命令: ${cmd}`);
  }
}

main().catch((e) => {
  console.error('错误: ' + String((e && e.message) || e));
  process.exit(1);
});

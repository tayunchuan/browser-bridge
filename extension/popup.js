// popup.js — 极简控制面板：共享/取消共享、查看连接状态
const PORT = 7233;
const $ = (id) => document.getElementById(id);

const op = (cmd, args = {}) => chrome.runtime.sendMessage({ type: 'op', op: cmd, args });

let currentTab = null;
let sharedIds = [];

function shortUrl(u) {
  if (!u) return '—';
  try {
    const x = new URL(u);
    return x.host + (x.pathname === '/' ? '' : x.pathname);
  } catch {
    return u.slice(0, 60);
  }
}

async function refreshStatus() {
  let live = false;
  let hello = null;
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/status`, { signal: AbortSignal.timeout(1200) });
    const j = await r.json();
    live = !!j.extLive;
    hello = j.hello;
  } catch {}
  const dot = $('dot');
  dot.className = 'dot ' + (live ? 'on' : 'warn');
  $('linkText').textContent = live ? '已连接' : '未连接';
  $('linkText').title = hello && hello.ua ? hello.ua : '';
}

async function refreshTabs() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTab = tab || null;
  if (currentTab) {
    $('curName').textContent = currentTab.title || '(无标题)';
    $('curUrl').textContent = shortUrl(currentTab.url);
  }

  let list = [];
  try {
    const res = await op('tabs.list');
    if (res && res.ok) list = res.data || [];
  } catch (e) {}

  sharedIds = list.filter((t) => t.shared).map((t) => t.id);
  $('count').textContent = String(sharedIds.length);

  const isShared = currentTab && sharedIds.includes(currentTab.id);
  const btn = $('toggleBtn');
  btn.textContent = isShared ? '取消共享当前标签页' : '共享当前标签页';
  btn.className = isShared ? 'primary danger' : 'primary';
  btn.classList.add('primary');
  btn.style.background = isShared ? '' : '#2ea043';
  btn.style.borderColor = isShared ? '#5b2b2b' : '#2ea043';
  btn.style.color = isShared ? '#ff9b9b' : '#fff';

  const ul = $('list');
  ul.innerHTML = '';
  const shared = list.filter((t) => t.shared);
  $('empty').style.display = shared.length ? 'none' : 'block';
  for (const t of shared) {
    const li = document.createElement('li');
    const info = document.createElement('div');
    info.className = 'info';
    const n = document.createElement('div');
    n.className = 'name';
    n.textContent = t.title || `标签页 ${t.id}`;
    const u = document.createElement('div');
    u.className = 'u';
    u.textContent = shortUrl(t.url);
    info.append(n, u);
    const kill = document.createElement('button');
    kill.textContent = '取消';
    kill.className = 'danger';
    kill.onclick = async () => {
      await op('tabs.unshare', { tabId: t.id });
      refreshTabs();
    };
    li.append(info, kill);
    ul.append(li);
  }
}

$('toggleBtn').onclick = async () => {
  if (!currentTab) return;
  if (sharedIds.includes(currentTab.id)) await op('tabs.unshare', { tabId: currentTab.id });
  else await op('tabs.share', { tabId: currentTab.id });
  refreshTabs();
};

$('clearBtn').onclick = async () => {
  for (const id of [...sharedIds]) await op('tabs.unshare', { tabId: id });
  refreshTabs();
};

refreshStatus();
refreshTabs();
setInterval(refreshStatus, 2000);

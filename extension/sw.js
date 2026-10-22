// sw.js — 服务工作线程：执行所有浏览器操作
// 权限模型：只对「已共享」的标签页做任何读写。

const VERSION = chrome.runtime.getManifest().version;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- 共享标签页状态 ---------------- */

async function getShared() {
  const { shared = [] } = await chrome.storage.local.get('shared');
  return shared;
}
async function setShared(list) {
  await chrome.storage.local.set({ shared: list });
  try {
    await chrome.action.setBadgeBackgroundColor({ color: '#2ea043' });
    await chrome.action.setBadgeText({ text: list.length ? String(list.length) : '' });
  } catch {}
}
async function addShared(tabId) {
  const s = await getShared();
  if (!s.includes(tabId)) await setShared([...s, tabId]);
}
async function removeShared(tabId) {
  const s = await getShared();
  await setShared(s.filter((x) => x !== tabId));
}
async function requireShared(tabId) {
  const s = await getShared();
  if (!s.includes(tabId)) throw new Error(`标签页 ${tabId} 没有被共享，拒绝操作`);
}

/* ---------------- offscreen 保活 ---------------- */

async function ensureOffscreen() {
  try {
    if (chrome.offscreen.hasDocument && (await chrome.offscreen.hasDocument())) return;
  } catch {}
  try {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['WORKERS'],
      justification: '维持与本地 DSH 桥接服务的长连接',
    });
  } catch (e) {
    if (!String(e && e.message).includes('single offscreen')) console.warn('[桥] offscreen:', e);
  }
}

chrome.runtime.onInstalled.addListener(() => { ensureOffscreen(); });
chrome.runtime.onStartup.addListener(() => { ensureOffscreen(); });
ensureOffscreen();

// 从已共享的标签页里点出来的新标签页（target=_blank、window.open）自动纳入共享，
// 否则点一个结果链接就点进了"我碰不到"的新页面。
chrome.tabs.onCreated.addListener(async (tab) => {
  if (!tab || !tab.id || !tab.openerTabId) return;
  try {
    const shared = await getShared();
    if (shared.includes(tab.openerTabId)) await addShared(tab.id);
  } catch {}
});

// 标签页关闭时清理共享状态
chrome.tabs.onRemoved.addListener(async (tabId) => {
  try {
    const shared = await getShared();
    if (shared.includes(tabId)) await setShared(shared.filter((x) => x !== tabId));
  } catch {}
});

/* ---------------- 与 offscreen 的 RPC 通路 ---------------- */

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== 'op') return;
  runOp(msg.op, msg.args || {})
    .then((data) => sendResponse({ ok: true, data: data === undefined ? null : data }))
    .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
  return true;
});

async function runOp(op, a) {
  switch (op) {
    case 'ping':
      return { pong: true, version: VERSION, at: Date.now() };

    case 'tabs.list':
      return tabsList();
    case 'tabs.current': {
      const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (!t) throw new Error('找不到当前标签页');
      return { tabId: t.id, windowId: t.windowId };
    }
    case 'tabs.open': {
      const tab = await openTab(a.url || 'about:blank');
      await addShared(tab.id);
      await waitReady(tab.id, 20000);
      const info = await pageInfo(tab.id).catch(() => ({}));
      return { tabId: tab.id, url: info.url || a.url, title: info.title || '', windowId: tab.windowId };
    }
    case 'tabs.close': {
      await requireShared(a.tabId);
      await chrome.tabs.remove(a.tabId);
      await removeShared(a.tabId);
      return { closed: a.tabId };
    }
    case 'tabs.share':
      await addShared(a.tabId);
      return { tabId: a.tabId, shared: true };
    case 'tabs.unshare':
      await removeShared(a.tabId);
      return { tabId: a.tabId, shared: false };
    case 'tabs.activate': {
      await requireShared(a.tabId);
      await chrome.tabs.update(a.tabId, { active: true });
      return { tabId: a.tabId };
    }

    case 'nav.goto': {
      await requireShared(a.tabId);
      await chrome.tabs.update(a.tabId, { url: a.url });
      await waitReady(a.tabId, 20000);
      return pageInfo(a.tabId).catch(() => ({ url: a.url }));
    }
    case 'nav.back': {
      await requireShared(a.tabId);
      await chrome.tabs.goBack(a.tabId).catch(() => {});
      await waitReady(a.tabId, 15000);
      return pageInfo(a.tabId).catch(() => ({}));
    }
    case 'nav.forward': {
      await requireShared(a.tabId);
      await chrome.tabs.goForward(a.tabId).catch(() => {});
      await waitReady(a.tabId, 15000);
      return pageInfo(a.tabId).catch(() => ({}));
    }
    case 'nav.reload': {
      await requireShared(a.tabId);
      await chrome.tabs.reload(a.tabId);
      await waitReady(a.tabId, 20000);
      return pageInfo(a.tabId).catch(() => ({}));
    }

    // 点击要额外处理：可能弹出新标签页
    case 'page.click': {
      await requireShared(a.tabId);
      const before = new Set((await chrome.tabs.query({})).map((t) => t.id));
      let res;
      try {
        res = await exec(a.tabId, { ...a, action: 'click' });
      } catch (e) {
        // 点击触发了跳转，脚本上下文被销毁，属于正常情况
        if (/context|frame|destroyed|closed/i.test(String((e && e.message) || e))) {
          res = { clicked: { name: '(页面已跳转)', tag: '?', x: 0, y: 0 } };
        } else {
          throw e;
        }
      }
      await sleep(600);
      const fresh = (await chrome.tabs.query({})).map((t) => t.id).filter((id) => !before.has(id));
      if (fresh.length) {
        for (const id of fresh) await addShared(id);
        return { ...res, newTabId: fresh[0], newTabCount: fresh.length };
      }
      const info = await pageInfo(a.tabId).catch(() => null);
      return { ...res, url: info ? info.url : undefined };
    }

    case 'page.snapshot':
    case 'page.text':
    case 'page.fill':
    case 'page.type':
    case 'page.press':
    case 'page.select':
    case 'page.scroll':
    case 'page.eval':
    case 'page.query': {
      await requireShared(a.tabId);
      const payload = { ...a, action: op.slice(5) };
      return exec(a.tabId, payload);
    }

    case 'page.wait': {
      await requireShared(a.tabId);
      if (a.spec) {
        const t0 = Date.now();
        const timeout = a.timeout || 10000;
        while (Date.now() - t0 < timeout) {
          const r = await exec(a.tabId, { action: 'query', sel: a.spec }).catch(() => null);
          if (r && r.exists) return { found: Date.now() - t0 };
          await sleep(200);
        }
        throw new Error(`等待元素超时: ${a.spec}`);
      }
      const ms = Math.min(Number(a.ms || 1000), 60000);
      await sleep(ms);
      return { waited: ms };
    }

    case 'page.shot': {
      await requireShared(a.tabId);
      const tab = await chrome.tabs.get(a.tabId);
      if (!tab.active) {
        await chrome.tabs.update(a.tabId, { active: true });
        await sleep(250);
      }
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
      return { dataUrl, at: Date.now() };
    }

    case 'page.upload':
      throw new Error('文件选择框需要用户手动操作（浏览器安全限制）');

    default:
      throw new Error(`未知操作: ${op}`);
  }
}

/* ---------------- 标签页 ---------------- */

async function tabsList() {
  const shared = await getShared();
  const all = await chrome.tabs.query({});
  const out = [];
  for (const t of all) {
    const item = { id: t.id, windowId: t.windowId, active: !!t.active, shared: shared.includes(t.id) };
    if (item.shared) {
      const info = await pageInfo(t.id).catch(() => null);
      if (info) {
        item.title = info.title;
        item.url = info.url;
      }
    }
    out.push(item);
  }
  const focused = out.filter((t) => t.active);
  return out.sort((x, y) => (y.active - x.active) || (x.id - y.id));
}

// 新开标签页：没有窗口时（例如用户把所有 Edge 窗口都关了，只剩后台进程）
// chrome.tabs.create 会报 "No current window"，这时先建一个窗口。
async function openTab(url) {
  let winId = null;
  try {
    const wins = await chrome.windows.getAll({});
    if (wins && wins.length) {
      const last = await chrome.windows.getLastFocused({}).catch(() => null);
      winId = (last || wins[0]).id;
    }
  } catch {}
  if (winId == null) {
    const win = await chrome.windows.create({ url: 'about:blank', focused: true });
    winId = win.id;
  }
  try {
    return await chrome.tabs.create({ url, active: true, windowId: winId });
  } catch (e) {
    // 窗口在中间被关掉之类的极端情况，退回默认行为
    return await chrome.tabs.create({ url, active: true });
  }
}

function waitReady(tabId, timeout = 15000) {  return new Promise((resolve) => {
    let done = false;
    const fin = () => {
      if (done) return;
      done = true;
      try { chrome.tabs.onUpdated.removeListener(onUpd); } catch {}
      resolve();
    };
    const onUpd = (id, info) => {
      if (id === tabId && info.status === 'complete') fin();
    };
    chrome.tabs.onUpdated.addListener(onUpd);
    setTimeout(fin, timeout);
    chrome.tabs.get(tabId).then((t) => { if (t && t.status === 'complete') fin(); }).catch(fin);
  });
}

async function pageInfo(tabId) {
  const r = await exec(tabId, { action: 'info' });
  return r;
}

/* ---------------- 注入执行 ---------------- */

function explainInjectError(e) {
  const m = String((e && e.message) || e);
  if (m.includes('Cannot access') || m.includes('The extensions gallery cannot be scripted')) {
    return '当前页面不允许扩展注入脚本（edge:// / Chrome 应用商店 / PDF 阅读器等）';
  }
  if (m.includes('No tab with id') || m.includes('Invalid tab ID')) {
    return '标签页已关闭或不存在，请重新 `tabs` 查看';
  }
  if (m.includes('Frame with ID 0 is showing error page')) return '页面加载失败（错误页）';
  return m;
}

async function exec(tabId, payload) {
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const [entry] = await chrome.scripting.executeScript({
        target: { tabId },
        func: pageAgent,
        args: [payload],
      });
      if (!entry) throw new Error('注入无返回');
      if (entry.error) throw new Error(typeof entry.error === 'string' ? entry.error : entry.error.message || '页面脚本异常');
      return entry.result;
    } catch (e) {
      lastErr = e;
      const m = String((e && e.message) || e);
      if (/Cannot access|no tab|Frame with ID|readyState/i.test(m) && attempt < 2) {
        await sleep(350);
        continue;
      }
      throw new Error(explainInjectError(e));
    }
  }
  throw new Error(explainInjectError(lastErr));
}

/* ---------------- 页面侧代理（会被序列化注入页面） ---------------- */

function pageAgent(p) {
  const A = p.action;
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();

  function visible(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) return false;
    if (el.closest('[aria-hidden="true"]')) return false;
    if (el.closest('[inert]')) return false;
    return true;
  }

  function nameOf(el) {
    const attr = (a) => (el.getAttribute(a) || '').trim();
    let s = attr('aria-label') || attr('placeholder') || attr('title') || attr('alt') || '';
    if (!s && el.tagName === 'INPUT' && /^(submit|button|reset)$/i.test(el.type || '')) s = el.value || '';
    if (!s) s = norm(el.innerText || '');
    if (!s && el.id) {
      try {
        const lab = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
        if (lab) s = norm(lab.innerText);
      } catch {}
    }
    if (!s) {
      const lab = el.closest('label');
      if (lab) s = norm(lab.innerText);
    }
    if (!s && el.getAttribute('name')) s = el.getAttribute('name');
    return s.slice(0, 80);
  }

  function roleOf(el) {
    const r = el.getAttribute('role');
    if (r) return r;
    const t = el.tagName;
    if (t === 'A') return 'link';
    if (t === 'BUTTON') return 'button';
    if (t === 'SELECT') return 'combobox';
    if (t === 'TEXTAREA') return 'textbox';
    if (t === 'SUMMARY') return 'button';
    if (t === 'INPUT') {
      const ty = (el.type || 'text').toLowerCase();
      if (ty === 'checkbox') return 'checkbox';
      if (ty === 'radio') return 'radio';
      if (ty === 'submit' || ty === 'button' || ty === 'reset') return 'button';
      if (ty === 'search') return 'searchbox';
      if (ty === 'file') return 'file';
      return 'textbox';
    }
    if (el.isContentEditable) return 'textbox';
    return t.toLowerCase();
  }

  function extraOf(el) {
    const parts = [];
    const t = el.tagName;
    if (t === 'INPUT') {
      const ty = (el.type || 'text').toLowerCase();
      if (ty && ty !== 'text') parts.push('type=' + ty);
      if (el.value && ty !== 'checkbox' && ty !== 'radio' && ty !== 'password') parts.push('value=' + JSON.stringify(String(el.value).slice(0, 40)));
      if (ty === 'checkbox' || ty === 'radio') parts.push(el.checked ? '[x]' : '[ ]');
    }
    if (t === 'TEXTAREA' && el.value) parts.push('value=' + JSON.stringify(String(el.value).slice(0, 40)));
    if (t === 'A' && el.href) parts.push('-> ' + String(el.href).slice(0, 90));
    if (el.disabled) parts.push('[disabled]');
    const ex = el.getAttribute('aria-expanded');
    if (ex) parts.push('expanded=' + ex);
    const ck = el.getAttribute('aria-checked');
    if (ck) parts.push('aria-checked=' + ck);
    return parts.join(' ');
  }

  function resolve(spec) {
    if (!spec) throw new Error('缺少元素标识');
    spec = String(spec).trim();
    if (/^@?e\d+$/.test(spec)) {
      const ref = spec.replace(/^@/, '');
      const el = document.querySelector('[data-dsh-ref="' + ref + '"]');
      if (!el) throw new Error('找不到 ' + ref + '（页面可能已变化，请重新 snap）');
      return el;
    }
    if (spec.indexOf('text=') === 0) {
      const q = norm(spec.slice(5)).toLowerCase();
      const cands = Array.from(document.querySelectorAll('a,button,[role="button"],[role="link"],[role="tab"],summary,input[type="submit"],input[type="button"],label,li,span,div,p,h1,h2,h3,td,th'));
      const withText = cands.map((e) => ({ e, t: norm(e.innerText).toLowerCase() })).filter((x) => x.t);
      const exact = withText.filter((x) => x.t === q).sort((a, b) => a.t.length - b.t.length);
      const inc = withText.filter((x) => x.t.indexOf(q) >= 0).sort((a, b) => a.t.length - b.t.length);
      const hit = exact[0] || inc[0];
      if (!hit) throw new Error('没有文本为「' + spec.slice(5) + '」的元素');
      return hit.e;
    }
    const sel = spec.indexOf('css=') === 0 ? spec.slice(4) : spec;
    let el = null;
    try {
      el = document.querySelector(sel);
    } catch (e) {
      throw new Error('选择器语法错误: ' + sel);
    }
    if (!el) throw new Error('选择器无匹配: ' + sel);
    return el;
  }

  function firePointer(el, x, y) {
    const base = { bubbles: true, cancelable: true, view: window, button: 0, clientX: x, clientY: y };
    const seq = [
      ['pointerdown', typeof PointerEvent !== 'undefined' ? PointerEvent : MouseEvent],
      ['mousedown', MouseEvent],
      ['pointerup', typeof PointerEvent !== 'undefined' ? PointerEvent : MouseEvent],
      ['mouseup', MouseEvent],
    ];
    for (const [type, Ctor] of seq) {
      try { el.dispatchEvent(new Ctor(type, base)); } catch {}
    }
  }

  if (A === 'info') {
    return { url: location.href, title: document.title, ready: document.readyState };
  }

  if (A === 'snapshot') {
    const max = Math.max(1, Math.min(Number(p.max || 150), 400));
    document.querySelectorAll('[data-dsh-ref]').forEach((e) => e.removeAttribute('data-dsh-ref'));
    const sel = 'a[href],button,input:not([type="hidden"]),textarea,select,summary,[role="button"],[role="link"],[role="tab"],[role="menuitem"],[role="checkbox"],[role="radio"],[role="switch"],[role="combobox"],[role="textbox"],[contenteditable="true"],[onclick]';
    const all = Array.from(document.querySelectorAll(sel));
    const items = [];
    let n = 0;
    let truncated = false;
    for (const el of all) {
      if (n >= max) { truncated = true; break; }
      if (!visible(el)) continue;
      const tag = el.tagName.toLowerCase();
      const isField = tag === 'input' || tag === 'textarea' || tag === 'select';
      const nm = nameOf(el);
      if (!nm && !isField) continue;
      const ref = 'e' + ++n;
      el.setAttribute('data-dsh-ref', ref);
      items.push({ ref, tag, role: roleOf(el), name: nm, extra: extraOf(el) });
    }
    let text = '';
    if (!p.noText) {
      const body = document.body;
      const raw = body ? body.innerText || '' : '';
      text = norm(raw).slice(0, Number(p.limit || 900));
    }
    return {
      url: location.href,
      title: document.title,
      vw: innerWidth,
      vh: innerHeight,
      sy: Math.round(scrollY),
      dh: Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0),
      items,
      text,
      truncated,
    };
  }

  if (A === 'text') {
    const raw = document.body ? document.body.innerText || '' : '';
    return { text: raw.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, Number(p.limit || 6000)) };
  }

  if (A === 'query') {
    let count = 0;
    try { count = document.querySelectorAll(p.sel).length; } catch { count = 0; }
    return { exists: count > 0, count };
  }

  if (A === 'click') {
    const el = resolve(p.spec);
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const r = el.getBoundingClientRect();
    const info = {
      name: norm(el.innerText || el.getAttribute('aria-label') || el.value || '').slice(0, 40),
      tag: el.tagName.toLowerCase(),
      x: Math.round(r.left + r.width / 2),
      y: Math.round(r.top + r.height / 2),
    };
    try { el.focus({ preventScroll: true }); } catch {}
    firePointer(el, info.x, info.y);
    if (typeof el.click === 'function') el.click();
    else el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    return { clicked: info };
  }

  if (A === 'fill') {
    const el = resolve(p.spec);
    const text = p.text == null ? '' : String(p.text);
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    try { el.focus({ preventScroll: true }); } catch {}
    if (el.isContentEditable) {
      el.textContent = text;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
    } else {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc && desc.set) desc.set.call(el, text);
      else el.value = text;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return { value: el.isContentEditable ? text : el.value };
  }

  if (A === 'type') {
    const el = resolve(p.spec);
    const text = p.text == null ? '' : String(p.text);
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    try { el.focus({ preventScroll: true }); } catch {}
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    const setVal = (v) => { if (desc && desc.set) desc.set.call(el, v); else el.value = v; };
    let cur = el.value || '';
    for (const ch of text) {
      cur += ch;
      setVal(cur);
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: ch, inputType: 'insertText' }));
      el.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keyup', { key: ch, bubbles: true }));
    }
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { value: el.value };
  }

  if (A === 'press') {
    const el = p.spec ? resolve(p.spec) : document.activeElement || document.body;
    if (!el) throw new Error('没有焦点元素');
    try { el.focus({ preventScroll: true }); } catch {}
    const table = {
      Enter: { key: 'Enter', code: 'Enter', keyCode: 13 },
      Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
      Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
      Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
      Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
      ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
      ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
      ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
      ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
      PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
      PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
      Home: { key: 'Home', code: 'Home', keyCode: 36 },
      End: { key: 'End', code: 'End', keyCode: 35 },
      ' ': { key: ' ', code: 'Space', keyCode: 32 },
    };
    const K = table[p.key] || {
      key: p.key,
      code: p.key && p.key.length === 1 ? 'Key' + p.key.toUpperCase() : p.key,
      keyCode: p.key && p.key.length === 1 ? p.key.toUpperCase().charCodeAt(0) : 0,
    };
    const mk = (type, extra) => new KeyboardEvent(type, { key: K.key, code: K.code, keyCode: K.keyCode, which: K.keyCode, bubbles: true, cancelable: true, ...extra });
    el.dispatchEvent(mk('keydown'));
    if (K.key && K.key.length === 1) el.dispatchEvent(mk('keypress'));
    el.dispatchEvent(mk('keyup'));
    return {
      active: { tag: el.tagName.toLowerCase(), name: nameOf(el) },
      note: K.key === 'Enter' && el.form ? '注意：JS 触发的 Enter 不会自动提交表单，必要时用 click 点提交按钮' : '',
    };
  }

  if (A === 'select') {
    const el = resolve(p.spec);
    if (el.tagName !== 'SELECT') throw new Error('目标不是 <select>');
    const want = String(p.value == null ? '' : p.value);
    const opts = Array.from(el.options || []);
    const opt =
      opts.find((o) => o.value === want) ||
      opts.find((o) => norm(o.textContent) === norm(want)) ||
      opts.find((o) => norm(o.textContent).indexOf(norm(want)) >= 0);
    if (!opt) throw new Error('没有匹配的选项: ' + want);
    el.value = opt.value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { selected: opt.value, label: norm(opt.textContent) };
  }

  if (A === 'scroll') {
    if (p.spec) {
      const el = resolve(p.spec);
      el.scrollIntoView({ block: 'center', behavior: 'instant' });
    } else if (p.to === 'top') {
      window.scrollTo({ top: 0, behavior: 'instant' });
    } else if (p.to === 'bottom') {
      window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' });
    } else {
      window.scrollBy({ top: Number(p.dy || 600), behavior: 'instant' });
    }
    return { scrollY: Math.round(window.scrollY), docH: document.documentElement.scrollHeight };
  }

  if (A === 'eval') {
    let v;
    try {
      v = new Function('return (' + p.js + ')')();
    } catch (e) {
      throw new Error('表达式执行失败: ' + ((e && e.message) || e));
    }
    let out;
    try { out = JSON.parse(JSON.stringify(v === undefined ? null : v)); } catch { out = String(v); }
    return { value: out };
  }

  throw new Error('未知页面动作: ' + A);
}

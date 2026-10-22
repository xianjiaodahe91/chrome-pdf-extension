'use strict';

/**
 * popup 面板
 *
 * 只做三件事：渲染按钮、把点击转成消息发给 background、显示结果。
 * 真正的功能实现全部在 background.js 的 ACTIONS 注册表里 ——
 * 那边加一项，这里就会自动多出一个按钮，本文件不需要改动。
 *
 * 直接双击 popup.html 在浏览器里打开会走「预览模式」（用假数据渲染），
 * 方便调界面；在扩展环境里运行时始终走真实数据。
 */

const listEl = document.getElementById('list');
const srcEl = document.getElementById('src');
const statusEl = document.getElementById('status');
const verEl = document.getElementById('ver');

// 与 background.js 的 BLOCKED_URL 保持一致，用于提前禁用按钮
const BLOCKED_URL = /^(chrome|edge|brave|about|devtools|chrome-extension|view-source|file):/i;

const HAS_EXTENSION_API = typeof chrome !== 'undefined' && !!chrome.runtime && !!chrome.runtime.id;

// 预览模式（非扩展环境）下的假数据，仅用于调整界面
const PREVIEW = {
  tab: {
    title: 'CFD Simulation of Flue Gas Desulfurization (FGD) Plant (a.k.a Scrubbers)',
    url: 'https://support.sw.siemens.com/zh-CN/product/226870983/knowledge-base/KB000037241_EN_US'
  },
  actions: [
    {
      id: 'export-pdf',
      title: '保存为 PDF',
      hint: 'A4 · 与手动打印 Ctrl+P 逐像素一致',
      badge: 'PDF'
    }
  ],
  busy: false
};

let currentTab = null;
let running = false;

function setStatus(text, kind) {
  statusEl.textContent = text || '';
  statusEl.className = 'status' + (kind ? ' ' + kind : '');
}

function setBusy(on) {
  running = on;
  listEl.classList.toggle('busy', on);
}

/* ---------------- 渲染 ---------------- */

function renderItem(action) {
  const btn = document.createElement('button');
  btn.className = 'item';
  btn.type = 'button';
  btn.dataset.id = action.id;

  const badge = document.createElement('span');
  badge.className = 'badge';
  badge.textContent = action.badge || '';
  if (action.badgeColor) badge.style.background = action.badgeColor;

  const body = document.createElement('span');
  body.className = 'body';

  const title = document.createElement('span');
  title.className = 't';
  title.textContent = action.title;
  body.appendChild(title);

  if (action.hint) {
    const hint = document.createElement('span');
    hint.className = 'h';
    hint.textContent = action.hint;
    body.appendChild(hint);
  }

  const chev = document.createElement('span');
  chev.className = 'chev';

  btn.append(badge, body, chev);
  btn.addEventListener('click', () => runAction(action, btn));
  return btn;
}

function renderSkeleton(n = 1) {
  listEl.replaceChildren();
  for (let i = 0; i < n; i += 1) {
    const sk = document.createElement('div');
    sk.className = 'skel';
    listEl.appendChild(sk);
  }
}

/* ---------------- 执行 ---------------- */

async function runAction(action, btn) {
  if (running) return;

  if (!HAS_EXTENSION_API) {
    setStatus('预览模式：按钮不会真的导出', 'run');
    return;
  }

  setBusy(true);
  setStatus('正在处理…', 'run');
  btn.setAttribute('aria-busy', 'true');

  try {
    const res = await chrome.runtime.sendMessage({
      type: 'RUN_ACTION',
      actionId: action.id,
      tabId: currentTab ? currentTab.id : undefined,
      url: currentTab ? currentTab.url : undefined
    });

    if (res && res.ok) {
      setStatus('✓ ' + (res.message || '完成'), 'ok');
    } else {
      setStatus('✗ ' + ((res && res.error) || '未知错误'), 'err');
    }
  } catch (err) {
    // popup 在等待期间被关掉、或 Service Worker 重启时消息通道会断。
    // 任务已在后台继续，完成/失败都会弹系统通知，这里只做提示。
    setStatus('任务已转到后台，完成后会弹通知', 'run');
  } finally {
    btn.removeAttribute('aria-busy');
    setBusy(false);
  }
}

/* ---------------- 初始化 ---------------- */

async function loadContext() {
  if (!HAS_EXTENSION_API) return PREVIEW;

  let tab = null;
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch (err) {
    tab = null;
  }

  let actions = [];
  let busy = false;
  try {
    const res = await chrome.runtime.sendMessage({ type: 'GET_ACTIONS' });
    actions = (res && res.actions) || [];
    busy = !!(res && res.busy);
  } catch (err) {
    throw new Error('后台未响应，请重新加载扩展');
  }

  return { tab, actions, busy };
}

async function init() {
  verEl.textContent = HAS_EXTENSION_API ? 'v' + chrome.runtime.getManifest().version : 'preview';
  renderSkeleton(1);

  let ctx;
  try {
    ctx = await loadContext();
  } catch (err) {
    listEl.replaceChildren();
    setStatus((err && err.message) || '初始化失败', 'err');
    return;
  }

  currentTab = ctx.tab || null;

  if (currentTab) {
    const label = (currentTab.title || '').trim() || currentTab.url || '当前标签页';
    srcEl.textContent = label;
    srcEl.title = label;
  }

  if (!ctx.actions.length) {
    listEl.replaceChildren();
    setStatus('没有可用功能', 'err');
    return;
  }

  listEl.replaceChildren(...ctx.actions.map(renderItem));

  // 当前页不支持时提前禁用
  const url = currentTab && currentTab.url;
  if (url && BLOCKED_URL.test(url)) {
    listEl.classList.add('blocked');
    setStatus('该页面不支持（浏览器内部页面或本地文件）', 'err');
    return;
  }

  if (ctx.busy) {
    setBusy(true);
    setStatus('上一个任务还在进行中…', 'run');
  }
}

init();

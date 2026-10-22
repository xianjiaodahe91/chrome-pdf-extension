'use strict';

/**
 * Page to PDF — 后台逻辑
 *
 * 点扩展图标 -> chrome.debugger 调 CDP 的 Page.printToPDF -> 拿到 base64
 * -> 落盘（两种方式，自动降级）：
 *    1) data URL 由 SW 直接调 chrome.downloads（首选，简单）
 *    2) URL 过长/被拒时，offscreen document 转 Blob URL，SW 再调 downloads
 *
 * 注意：offscreen document 只能用 chrome.runtime 消息类 API，
 *      chrome.downloads 在它里面不存在 —— 下载必须由 SW 发起。
 */

const OFFSCREEN_PATH = 'offscreen.html';
const PDF_FILE_NAME = 'Page.pdf';

/**
 * 是否打印背景图形（底色、背景图、半透明填充等）。
 *
 * 设为 false 是为了与 Chrome 手动打印（Ctrl+P，默认「背景图形」未勾选）对齐。
 * Chrome 关闭时会走 print-color-adjust: economy，把半透明文字强制为不透明，
 * 因此占位提示文字（如 #666 的 ::placeholder）会变得更深。
 * 实测同一页面：printBackground 差异只影响这类半透明元素，
 * 正文文字、图片、矢量图形的落点与灰度完全不受影响；
 * 关闭后该页与你手动导出的版本灰度直方图完全一致。
 *
 * 代价：页面若有彩色/深色底块，导出后背景会变白（内容仍在）。
 */
const PRINT_BACKGROUND = false;

const PDF_OPTIONS = {
  printBackground: PRINT_BACKGROUND,
  preferCSSPageSize: false,
  displayHeaderFooter: true, // Chrome 默认样式：页眉=标题+日期，页脚=URL+页码
  paperWidth: 8.2633, // 精确 A4：实测输出 594.96pt 与手动版一致（8.264~8.27 都会量化成 595.92）
  paperHeight: 11.6933, // 输出 841.92pt
  // 仅作降级用（注入 @page 失败时）：参数路径的边距被 Chrome 量化成两档，
  // 0.4025 是可达档位中较接近手动版（等效 29.55pt）的组合
  marginTop: 0.4025,
  marginBottom: 0.4025,
  marginLeft: 0.4025,
  marginRight: 0.4025
};

const BLOCKED_URL = /^(chrome|edge|brave|about|devtools|chrome-extension|view-source|file):/i;

/**
 * 首选方案：用 CSS @page 规则接管纸张尺寸与边距（配合 preferCSSPageSize: true）。
 *
 * 为什么不用 printToPDF 的 paperWidth/margin 参数：
 * 参数路径的边距被 Chrome 量化成两档（间距 1.5pt），Chrome 手动打印（Ctrl+P）
 * 的等效边距 29.55pt 恰在档位之间，永远残留 0.75pt（0.26mm）整体偏移；
 * 而 CSS @page 路径的档位更细，实测有效边距 29.73pt，与手动版只差 0.18pt
 * （0.06mm，肉眼不可辨）。纸张尺寸则由 size 精确给出，输出与手动版一致。
 *
 * 实测数据（headless Chrome 155 / A4）：
 *   @page margin <= 0.400in  -> 有效 29.73pt   <-- 采用
 *   @page margin >= 0.4025in -> 有效 30.48pt
 *
 * 右侧补偿：Chrome 对 @page 左右边距的处理不对称（纸张宽度方向取整不同），
 * 实测内容区右边缘比手动打印窄 1.31pt，左边缘则完全一致。
 * 解法是把右边距单独调小（margin 四值写法：上 右 下 左 = 0.4in 0.38in 0.4in 0.4in），
 * 让内容区宽度与手动打印对齐。
 * ⚠ 必须走 @page 边距这条正规路径：曾试过用 CSS 撑宽（html/body 的负 margin-right），
 * 虽然水平也准，但它绕开打印布局管线，会让页面重排、分页错位（实测第 2 页偏 10pt）。
 *
 * 实测右边距档位（每档 0.75pt）：
 *   0.395in -> +0.00   0.390/0.385in -> +0.75   0.380in -> +1.50   0.370in -> +2.25
 * 目标 +1.31 → 取 0.38in，残差 0.19pt (0.067mm)，垂直方向零漂移。
 *
 * ── 关于 size 的宽度为什么不是 A4 的 8.2633in ──
 * Chrome 的「页眉/页脚」是独立图层，它的右对齐锚点用的是**未经量化的 CSS size 值**，
 * 而纸张 MediaBox 会量化。两者用的是不同精度，正好留下一条可调缝隙：
 *   · size 宽度在 8.2640 ~ 8.2700in 之间时，MediaBox 恒定输出 594.96pt（标准 A4）
 *   · 但页眉页脚的横向位置会随这个值线性移动（标题约 35pt/in，页码约 70pt/in）
 * 手动打印（Ctrl+P）的页眉页脚等效于 size = 8.26667in = 2480/300 in（Chrome 的 1/300 网格点）。
 * 取这个值后，三页的页眉标题、页脚页码与手动版**逐 run 坐标完全重合（dx=dy=0.000）**，
 * 而纸张仍是 594.96×841.92pt，正文 253 段 run 也不受影响。
 * 容差实测：8.26660 ~ 8.26675 区间内均为 0.000，超出后开始按上述斜率漂移。
 *
 * 注意：这个技巧只在 CSS @page 路径有效。参数路径（paperWidth）一旦调到 8.264 以上，
 * MediaBox 会直接跳到 595.92pt，所以 PDF_OPTIONS 里的 paperWidth 仍保持 8.2633。
 */
const PAGE_RULE = '@page { size: 8.26667in 11.6933in; margin: 0.4in 0.38in 0.4in 0.4in; }';

async function applyPageRule(tabId) {
  try {
    await chrome.scripting.insertCSS({ target: { tabId }, css: PAGE_RULE });
    return true;
  } catch (err) {
    console.warn('[Page to PDF] 注入 @page 规则失败，降级为参数边距：', err && err.message);
    return false;
  }
}

async function clearPageRule(tabId, applied) {
  if (!applied) return;
  try {
    await chrome.scripting.removeCSS({ target: { tabId }, css: PAGE_RULE });
  } catch (err) {
    /* 页面已关闭等情况，忽略 */
  }
}

/**
 * 与 Chrome 手动打印逐点对齐用的微小平移（备用方案，当前关闭）。
 *
 * 实测：`html { padding-left/top: Npt }` 在打印输出中呈精确线性平移，
 * 但 padding 会缩小内容区宽度（右栏被连带左推），且 padding-top 只作用于
 * 文档首页。因此 @page 方案（见上）足够精确时应保持这两个值为 0。
 */
const PRINT_OFFSET = { xPt: 0, yPt: 0 };

function printOffsetCss() {
  const { xPt, yPt } = PRINT_OFFSET;
  if (!xPt && !yPt) return '';
  return `html { padding-left: ${xPt}pt !important; padding-top: ${yPt}pt !important; }`;
}

async function applyPrintOffset(tabId) {
  const css = printOffsetCss();
  if (!css) return null;
  try {
    await chrome.scripting.insertCSS({ target: { tabId }, css });
    return css;
  } catch (err) {
    console.warn('[Page to PDF] 注入打印偏移失败：', err && err.message);
    return null;
  }
}

async function clearPrintOffset(tabId, css) {
  if (!css) return;
  try {
    await chrome.scripting.removeCSS({ target: { tabId }, css });
  } catch (err) {
    /* 页面已关闭等情况，忽略 */
  }
}

function setBadge(text, color) {
  return chrome.action.setBadgeText({ text }).then(() =>
    color ? chrome.action.setBadgeBackgroundColor({ color }) : undefined
  );
}

/* ------------------------------------------------------------------ */
/* 1. 打印前预处理：等图片加载完 + 触发懒加载                          */
/* ------------------------------------------------------------------ */

async function preparePage(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: async () => {
        const pending = [...document.images].filter((img) => !img.complete);
        await Promise.all(
          pending.map(
            (img) =>
              new Promise((res) => {
                img.addEventListener('load', res, { once: true });
                img.addEventListener('error', res, { once: true });
              })
          )
        );
        const y = window.scrollY;
        window.scrollTo(0, document.body.scrollHeight);
        await new Promise((r) => setTimeout(r, 800));
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 300));
      }
    });
  } catch (err) {
    console.warn('[Page to PDF] 页面预处理已跳过：', err && err.message);
  }
}

/* ------------------------------------------------------------------ */
/* 2. 通过 CDP 打印成 PDF                                             */
/* ------------------------------------------------------------------ */

async function exportCurrentTab(tab) {
  if (!tab || tab.id === undefined) throw new Error('找不到目标标签页');
  if (BLOCKED_URL.test(tab.url || '')) {
    throw new Error('这个页面不支持导出（浏览器内部页面或本地文件）');
  }

  await setBadge('...', '#1a73e8');
  await preparePage(tab.id);

  // 首选 CSS @page 控制纸型与边距；失败则退回参数方式
  const useCssPage = await applyPageRule(tab.id);
  const offsetCss = await applyPrintOffset(tab.id);
  const options = useCssPage
    ? {
        printBackground: PRINT_BACKGROUND,
        displayHeaderFooter: true,
        preferCSSPageSize: true
      }
    : PDF_OPTIONS;

  const target = { tabId: tab.id };
  let attached = false;
  try {
    await chrome.debugger.attach(target, '1.3');
    attached = true;
    await chrome.debugger.sendCommand(target, 'Page.enable');
    const result = await chrome.debugger.sendCommand(target, 'Page.printToPDF', options);
    if (!result || !result.data) throw new Error('打印返回了空数据');
    return result.data;
  } catch (err) {
    const msg = (err && err.message) || String(err);
    if (/Another debugger is already attached/i.test(msg)) {
      throw new Error('请先关闭该页面的 DevTools，再点扩展图标');
    }
    if (/Cannot attach/i.test(msg)) {
      throw new Error('无法附加调试器，该页面可能受保护');
    }
    throw err;
  } finally {
    if (attached) {
      try {
        await chrome.debugger.detach(target);
      } catch (err) {
        /* 已经断开，忽略 */
      }
    }
    await clearPrintOffset(tab.id, offsetCss);
    await clearPageRule(tab.id, useCssPage);
  }
}

/* ------------------------------------------------------------------ */
/* 3. 落盘                                                            */
/* ------------------------------------------------------------------ */

async function ensureOffscreenDocument() {
  const url = chrome.runtime.getURL(OFFSCREEN_PATH);
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [url]
  });
  if (contexts.length > 0) return;

  await chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ['BLOBS'],
    justification: '需要 DOM 环境把 PDF 字节转成 Blob URL'
  });
}

async function savePdfViaBlob(base64Data) {
  await ensureOffscreenDocument();

  let res = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      res = await chrome.runtime.sendMessage({ type: 'MAKE_BLOB', data: base64Data });
      if (res && res.ok) break;
    } catch (err) {
      res = { ok: false, error: (err && err.message) || String(err) };
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  if (!res || !res.ok) {
    throw new Error('生成 Blob 失败：' + ((res && res.error) || 'offscreen 无响应'));
  }

  return chrome.downloads.download({
    url: res.url,
    filename: PDF_FILE_NAME,
    saveAs: false,
    conflictAction: 'uniquify'
  });
}

async function savePdf(base64Data) {
  try {
    // 首选：data URL，全部逻辑在 SW 内，不依赖 offscreen
    return await chrome.downloads.download({
      url: 'data:application/pdf;base64,' + base64Data,
      filename: PDF_FILE_NAME,
      saveAs: false,
      conflictAction: 'uniquify'
    });
  } catch (err) {
    // data URL 有 ~2MB 长度上限；超大 PDF 或异常时退回 Blob 方案
    console.warn('[Page to PDF] data URL 下载失败，改用 offscreen Blob：', err && err.message);
    return savePdfViaBlob(base64Data);
  }
}

/* ------------------------------------------------------------------ */
/* 4. 功能注册表 —— 以后新增功能只改这一段                              */
/* ------------------------------------------------------------------ */

/**
 * 每一项对应面板上的一个按钮，顺序即面板里的显示顺序。
 *
 * 新增功能只要两步：
 *   ① 在下面的数组里加一项：
 *        id    唯一标识，不能重复
 *        title 按钮主标题
 *        hint  副标题，一句话说明（可省略）
 *        badge 左侧方块里的字，2~4 个字符，如 PDF / MD / PNG
 *        run   async (tab) => ({ message })  —— message 会显示在面板和通知里
 *   ② 把 run 的实现写出来（可以复用本文件已有的 exportCurrentTab / savePdf 等）
 *
 * popup.html / popup.js 不需要任何改动，新按钮会自动出现在面板里。
 */
const ACTIONS = [
  {
    id: 'export-pdf',
    title: '保存为 PDF',
    hint: 'A4 · 与手动打印 Ctrl+P 逐像素一致',
    badge: 'PDF',
    run: async (tab) => {
      const base64 = await exportCurrentTab(tab);
      const downloadId = await savePdf(base64);
      const path = await getDownloadPath(downloadId);
      return { message: '已保存到 ' + path };
    }
  }
];

const ACTION_MAP = new Map(ACTIONS.map((item) => [item.id, item]));

// 同一时刻只允许跑一个功能，避免两个任务同时抢 chrome.debugger
let busyActionId = null;

/* ------------------------------------------------------------------ */
/* 5. 入口                                                            */
/* ------------------------------------------------------------------ */

/**
 * 下载刚创建的一瞬间，downloads.search 返回的 filename 可能还是相对路径，
 * 因此轮询到「已完成」或「已是绝对路径」再返回，让通知里显示真实位置。
 */
async function getDownloadPath(downloadId, timeoutMs = 3000) {
  const isAbsolute = (p) => /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('/');
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const [item] = await chrome.downloads.search({ id: downloadId });
      if (item && item.filename) {
        if (item.state === 'complete' || isAbsolute(item.filename)) return item.filename;
      }
    } catch (err) {
      /* 查不到就继续等 */
    }
    await new Promise((r) => setTimeout(r, 150));
  }

  try {
    const [item] = await chrome.downloads.search({ id: downloadId });
    if (item && item.filename) return item.filename;
  } catch (err) {
    /* 兜底 */
  }
  return '默认下载目录\\' + PDF_FILE_NAME;
}

function notify(title, message) {
  try {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title,
      message
    });
  } catch (err) {
    console.warn('[Page to PDF] 通知失败：', err);
  }
}

/* ------------------------------------------------------------------ */
/* 6. 消息路由（popup <-> background）                                 */
/* ------------------------------------------------------------------ */

async function resolveTab(tabId, fallbackUrl) {
  if (tabId !== undefined) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (!tab.url && fallbackUrl) tab.url = fallbackUrl;
      return tab;
    } catch (err) {
      /* 标签页可能已关闭，退回当前活动页 */
    }
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

async function runAction(actionId, tabId, fallbackUrl) {
  const action = ACTION_MAP.get(actionId);
  if (!action) return { ok: false, error: '未知功能：' + actionId };
  if (busyActionId) return { ok: false, error: '上一个任务还在进行中，请稍候' };

  const tab = await resolveTab(tabId, fallbackUrl);
  if (!tab || tab.id === undefined) return { ok: false, error: '找不到目标标签页' };

  busyActionId = action.id;
  await setBadge('...', '#1a73e8');
  try {
    const result = await action.run(tab);
    const message = (result && result.message) || '完成';
    await setBadge('OK', '#188038');
    console.log('[Page to PDF]', action.id, '->', message);
    notify('Page 工具箱 — 完成', message);
    return { ok: true, message };
  } catch (err) {
    const msg = (err && err.message) || String(err);
    console.error('[Page to PDF]', action.id, '失败：', err);
    await setBadge('!', '#d93025');
    notify('Page 工具箱 — 失败', msg);
    return { ok: false, error: msg };
  } finally {
    busyActionId = null;
    setTimeout(() => {
      chrome.action.setBadgeText({ text: '' });
    }, 3000);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return undefined;

  // popup 打开时拉取按钮清单（只暴露展示用字段，不传 run）
  if (msg.type === 'GET_ACTIONS') {
    sendResponse({
      actions: ACTIONS.map(({ id, title, hint, badge, badgeColor }) => ({
        id,
        title,
        hint,
        badge,
        badgeColor
      })),
      busy: !!busyActionId
    });
    return undefined;
  }

  if (msg.type === 'RUN_ACTION') {
    runAction(msg.actionId, msg.tabId, msg.url)
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: (err && err.message) || String(err) }));
    return true; // 保持消息通道打开，等待异步结果
  }

  return undefined;
});

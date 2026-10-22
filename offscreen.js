'use strict';

/**
 * offscreen document
 *
 * Service Worker 里没有 DOM，也就没有 URL.createObjectURL。
 * 这里只做一件事：把 base64 还原成字节 -> Blob -> Blob URL，把 URL 交回 SW。
 * 真正的 chrome.downloads.download 由 Service Worker 调用
 * （offscreen document 只能用消息类 API，访问不到 downloads）。
 */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'MAKE_BLOB') return undefined;

  try {
    const bin = atob(msg.data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);

    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    // 给下载留足时间后再释放；offscreen 常驻，手动兜底回收
    setTimeout(() => URL.revokeObjectURL(url), 10 * 60 * 1000);

    sendResponse({ ok: true, url });
  } catch (err) {
    sendResponse({ ok: false, error: (err && err.message) || String(err) });
  }

  return undefined;
});

# Page 工具箱（Page to PDF）

一个 Chrome 扩展（Manifest V3）：点一下图标，把当前网页导出为 PDF，直接落到默认下载目录，不弹打印对话框。

目标不是「能导出」，而是**导出结果与 Chrome 手动打印（Ctrl+P → 另存为 PDF，默认设置）逐像素一致**。

当前版本 **1.7.0**。

---

## 它解决什么问题

Chrome 自带的「打印 → 另存为 PDF」需要四步：Ctrl+P、等预览渲染、点保存、选路径。批量存网页时非常累。

但用脚本调用 `Page.printToPDF` 直接导出，结果和手动打印**并不一样**——Chrome 在这条路径上对纸张宽度和页边距做了不同程度的量化（取整），导致：

- 纸张宽度偏 0.96pt（595.92 vs 594.96）
- 整体边距残留 0.75pt 偏移
- 内容区右边缘窄 1.31pt
- 页眉 / 页脚右对齐部分偏 0.117 ~ 0.234pt

肉眼在单页上看不出来，但页面一多、或者把两个 PDF 叠在一起对比，就能明显察觉「正文偏左上」。

这个扩展通过一组标定过的参数，把上述偏差逐一压到 **0.000pt**。

---

## 安装

1. 打开 `chrome://extensions`
2. 右上角开启「开发者模式」
3. 点「加载已解压的扩展程序」，选择本目录
4. 建议把图标固定到工具栏（拼图按钮 → 图钉）

要求 **Chrome 116+**（依赖 `chrome.runtime.getContexts` 与 `offscreen` API）。

---

## 使用

1. 打开任意网页（`http://` / `https://`）
2. 点工具栏图标，弹出功能面板
3. 点「保存为 PDF」
4. 文件保存到默认下载目录，文件名 `Page.pdf`；重名自动变成 `Page (1).pdf`、`Page (2).pdf`
5. 完成后弹系统通知，里面带真实绝对路径

面板上会显示当前页面标题，方便确认导的是哪一页。

---

## 功能面板

点图标不是直接触发导出，而是弹出一个面板：

```
┌─────────────────────────────────┐
│ [图标]  Page 工具箱              │
│         CFD Simulation of Flue… │  ← 当前页面标题，过长省略
├─────────────────────────────────┤
│ ┌────┐                          │
│ │PDF │  保存为 PDF              │  ← 按钮
│ └────┘  A4 · 与手动打印逐像素一致 │
├─────────────────────────────────┤
│ 正在处理…                  v1.7.0│  ← 状态行 + 版本号
└─────────────────────────────────┘
```

这样设计是为了**以后能往上加功能**：加一项就在 `background.js` 的 `ACTIONS` 数组里追加一条，面板自动多出一个按钮，`popup.html` / `popup.css` / `popup.js` 一行都不用改。

当前只有「保存为 PDF」一项。

---

## 目录结构

```
chrome-pdf-extension/
├── manifest.json      扩展清单（MV3）
├── background.js      ★ 核心：打印、落盘、功能注册表、消息路由
├── popup.html         面板结构
├── popup.css          面板样式（跟随系统深浅色）
├── popup.js           面板逻辑：渲染按钮、发消息、显示结果
├── offscreen.html     offscreen 宿主页
├── offscreen.js       base64 → Blob URL（降级下载用）
└── icons/             16 / 32 / 48 / 128 图标
```

---

## 工作原理

```
点击面板按钮
   │
   ├─ preparePage()        等图片加载完、滚到底触发懒加载再滚回
   │
   ├─ applyPageRule()      注入 @page 规则（纸型 + 边距）
   │     └─ 失败则降级为传参
   │
   ├─ chrome.debugger.attach()
   │     └─ Page.enable
   │     └─ Page.printToPDF()  → base64
   │     └─ detach（无论成败）
   │
   └─ savePdf()            落盘
         ├─ 首选：data URL 直接给 chrome.downloads（~2MB 上限）
         └─ 降级：offscreen 转 Blob URL，再由 Service Worker 下载
```

两个设计要点：

**① 下载必须由 Service Worker 发起。** offscreen document 里 `chrome.downloads` 是 `undefined` —— 它只能使用消息类 API。这是早期版本踩过的坑。

**② `chrome.debugger` 同一时刻只能挂一个。** 代码里用 `busyActionId` 做了互斥，避免两个任务抢调试器。

### 关键参数

```js
// 首选路径：CSS @page + preferCSSPageSize
const PAGE_RULE = '@page { size: 8.26667in 11.6933in; margin: 0.4in 0.38in 0.4in 0.4in; }';

// 降级路径：printToPDF 参数
paperWidth: 8.2633, paperHeight: 11.6933,   // 输出 594.96 × 841.92pt = A4
marginTop/Bottom/Left/Right: 0.4025
printBackground: false                       // 与手动打印默认「背景图形未勾选」对齐
displayHeaderFooter: true                    // Chrome 默认样式页眉页脚
```

### 为什么不用普通的 paperWidth / margin 参数

实测（Chrome 155 / A4）：**参数路径的边距被量化成两档，间距 1.5pt**：

| 传入 margin | 实际生效 |
|---|---|
| ≤ 0.4025in | 28.80 ~ 28.98pt |
| ≥ 0.403in | 30.52 / 30.30pt |

而 Chrome 手动打印的等效边距是 **29.55pt**，正好落在两档中间 —— 永远残留 0.75pt（0.26mm）。

CSS `@page` 路径的档位更细，最大档位生效 29.73pt，与手动版只差 0.18pt（0.06mm）。

### 三个不太直观的取值

**`size` 宽度为什么是 8.26667in，不是 A4 的 8.2633in？**

Chrome 的页眉 / 页脚是独立图层，它的右对齐锚点用**未经量化的原始 CSS 值**，而纸张 MediaBox 会量化。两者精度不同，正好留下一条可调缝隙：

- `size` 宽度在 **8.2640 ~ 8.2700in** 之间时，MediaBox 恒定输出 **594.96pt**（标准 A4）
- 但页眉页脚的横向位置会随这个值线性移动（标题约 35pt/in，页码约 70pt/in）

零点落在 `8.26667in = 2480/300 in`，正好是 Chrome 的 **1/300 英寸量化网格点**——也是手动打印页眉的等效值。

| size (in) | 页眉标题 dx | 页脚页码 dx |
|---|---|---|
| 8.2650 | −0.059 | −0.117 |
| 8.2660 | −0.023 | −0.047 |
| **8.26667** | **0.000** | **0.000** |
| 8.2680 | +0.059 | +0.105 |

容差：`8.26660 ~ 8.26675` 内均为 0.000。

> ⚠ 这个技巧**只在 CSS 路径有效**。参数路径的 `paperWidth` 一旦超过 8.264，MediaBox 会直接跳到 595.92pt。所以 `PDF_OPTIONS.paperWidth` 仍保持 8.2633。

**右边距为什么是 0.38in，不是对称的 0.4in？**

Chrome 对 `@page` 左右边距处理不对称，内容区右边缘比手动打印窄 1.31pt，左边缘则完全吻合。右边距档位每档 0.75pt：

| 右边距 | 右边缘残差 |
|---|---|
| 0.395in | +0.00 |
| 0.390 / 0.385in | +0.75 |
| **0.380in** | **+1.50** ← 采用，最接近目标 +1.31 |
| 0.370in | +2.25 |

> ⚠ 必须走 `@page` 边距这条正规路径。曾试过用 CSS 撑宽（`html { margin-right: -1.2pt }`），水平虽然准，但它绕开了打印布局管线，**会导致页面重排、分页错位**（实测第 2 页偏移 10pt）。

**`printBackground` 为什么是 `false`？**

Chrome 手动打印默认不勾「背景图形」。关闭时走 `print-color-adjust: economy`，会把**半透明文字强制为不透明**——最典型的是 `::placeholder` 灰色提示字会变深。

实测同一页面：这个开关只影响这类半透明元素，正文文字、图片、矢量图形的落点与灰度完全不受影响。关闭后与手动版灰度直方图完全一致。

代价：页面若有彩色 / 深色底块，导出后背景会变白（内容仍在）。想改回来，把 `background.js` 顶部的 `PRINT_BACKGROUND` 改成 `true` 即可，就一行。

---

## 添加新功能

只改 `background.js` 里的 `ACTIONS` 数组：

```js
const ACTIONS = [
  {
    id: 'export-pdf',              // 唯一标识，不能重复
    title: '保存为 PDF',            // 按钮主标题
    hint: 'A4 · 与手动打印逐像素一致', // 副标题，可省略
    badge: 'PDF',                  // 左侧方块里的字，2~4 字符
    badgeColor: 'linear-gradient(160deg,#5f6368,#3c4043)', // 可选，不填用默认蓝
    run: async (tab) => {
      const base64 = await exportCurrentTab(tab);
      const downloadId = await savePdf(base64);
      const path = await getDownloadPath(downloadId);
      return { message: '已保存到 ' + path };   // message 显示在面板和通知里
    }
  },
  // ← 新功能加在这里，面板自动多一个按钮
];
```

`run` 可以直接复用已有的 `exportCurrentTab` / `savePdf` / `getDownloadPath`。抛出异常即视为失败，面板和通知会自动显示 `err.message`。

---

## 权限说明

| 权限 | 用途 |
|---|---|
| `debugger` | 调 CDP 的 `Page.printToPDF`，这是自动化打印的唯一入口 |
| `downloads` | 把 PDF 写进下载目录 |
| `scripting` | 注入 `@page` 规则、等图片加载 |
| `offscreen` | 降级下载时用 DOM 造 Blob URL |
| `notifications` | 完成后告知文件落点、失败时告知原因 |
| `activeTab` | 读取当前标签页信息 |

`debugger` 权限听起来吓人，但它只在这一种场景下用：打印期间附加、打印完立即 `detach`。代码里用 `finally` 保证无论成败都会断开。

---

## 已知限制

**导出时 Chrome 顶部会出现「已开始调试此浏览器」黄条。** 这是 `chrome.debugger` 的强制提示，无法隐藏。它会在打印结束后自行消失——**不要点「取消」，那会中断导出**。

**不支持 `chrome://`、`about:`、`chrome-extension://`、`view-source:`、`file://` 等页面。** 面板会提前禁用按钮并提示。

**导出前请关掉该页面的 DevTools。** 同一个标签页不能挂两个调试器，否则会报「请先关闭 DevTools」。

**可能漏掉懒加载内容。** 代码会先滚到底触发懒加载再滚回顶部，但对于「滚动时才用 JS 渲染」的站点，仍可能有空白区域。这类情况建议先手动滚一遍。

**页眉里的日期时间无法对齐。** 它是打印时刻，手动版和扩展版必然不同，属于正常现象。

**内嵌 iframe（如 Salesforce 幻灯片预览）会完整渲染。** 手动打印时 iframe 常常还没画完就截了，导致空白框。扩展版反而更忠实于页面——如果你的手动版那里是空白，那不是扩展的问题。

---

## 校验精度

在目标页面（Siemens 支持中心 CFD 知识库，3 页）上与手动打印版对比：

| 项目 | 结果 |
|---|---|
| 纸张 | 三页均 594.96 × 841.92pt（A4） |
| 正文坐标 | 253 段文本 run，>0.005pt 偏差：**0 段**，最大 0.000pt |
| 页眉 | 6 个 run，dx = dy = **+0.000** |
| 页脚 | 12 个 run，dx = dy = **+0.000** |
| 内嵌字体 | 逐页一致 |
| 图片落点 | 完全一致 |
| 全文文本 | 逐字相同 |

唯一差异是页眉时间戳。

---

## 开发调试

**改完代码**：到 `chrome://extensions` 点扩展卡片上的「重新加载」。（改 `background.js` 必须重载；改 `popup.*` 只要重开面板。）

**看日志**：`chrome://extensions` → 扩展卡片 →「Service Worker」链接 → 打开控制台。

**调界面**：直接在浏览器里双击打开 `popup.html`，会走「预览模式」——用假数据渲染，不需要装扩展、不需要重载，方便反复改样式。在扩展环境里运行时始终走真实数据。

**没有构建步骤**：纯原生 JS，没有打包、没有依赖，改完就生效。

---

## 版本历史

| 版本 | 改动 |
|---|---|
| 1.0.0 | 初始版本，CDP + `chrome.debugger` + `downloads` 跑通 |
| 1.1.0 | 用 `padding` 补偿偏移 —— **失败**，「治左伤右」，右栏被连带左推 |
| 1.2.0 | 改用 CSS `@page` 控制纸型与边距，消除整体 0.75pt 偏移 |
| 1.3.0 | 用 `html { margin-right: -1.2pt }` 修右边缘 —— 水平准了，但**导致页面重排**（第 2 页偏 10pt） |
| 1.4.0 | 改用 `@page` 右边距 0.38in，走正规打印管线，垂直零漂移 |
| 1.5.0 | 关闭 `printBackground`，与手动打印「背景图形未勾选」对齐 |
| 1.6.0 | 点图标改为弹出功能面板；新增 `ACTIONS` 功能注册表；修复通知路径不精确 |
| 1.7.0 | `@page size` 宽度改为 2480/300 in，页眉页脚偏移归零 |

---

## 一句话总结

它把一个「看起来差不多」的自动化导出，一路标定到了和手动打印**逐像素无法区分**的程度——包括那些 Chrome 自己都没打算让你改的细节（纸张量化和页眉锚点之间的缝隙）。

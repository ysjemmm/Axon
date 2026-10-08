/**
 * 文件预览入口
 *
 * ⚠️ 这里没有弹窗组件。预览窗开在 workbench 层（外壳的 axonFilePreviewModal
 * contribution），webview 只负责把"预览这个路径"的请求发出去。
 *
 * 为什么不在 webview 里渲染：webview 的 DOM 永远被裁在它自己的边界内，
 * 侧栏那条宽度放不下表格和网页（实测 Excel 表格被挤成竖条）。workbench 级
 * overlay 挂在 mainWindow.document.body 上，才能盖住整个 IDE 窗口。
 */

interface VSCodeHost {
  postMessage(msg: unknown): void;
}

function getHost(): VSCodeHost | null {
  return (window as unknown as { __axonVSCode?: VSCodeHost }).__axonVSCode ?? null;
}

/** 当前环境是否支持预览（只有 webview 形态有宿主可以读文件） */
export function canPreviewFiles(): boolean {
  return getHost() !== null;
}

/**
 * 请求预览一个文件。
 * path 需要是绝对路径 —— 宿主按它读盘，相对路径会被解析到扩展进程的 cwd。
 */
export function requestFilePreview(path: string): void {
  getHost()?.postMessage({ type: "preview_file", path });
}

/**
 * Axon 底部状态栏入口
 *
 * 替代 Code OSS 内置的 Copilot 状态栏入口（fork 侧已注释其注册）。
 * 显示 Axon 品牌按钮，点击聚焦右侧 Axon AI 对话栏。
 *
 * 说明：VS Code 状态栏 text 仅支持内置 codicon（`$(...)`）或纯文本，
 * 无法直接渲染自定义 svg。此处用 `$(sparkle)` 作为 AI 标识并附带
 * "Axon" 品牌文字；如需真正的 Axon logo，需将 svg 转为图标字体后
 * 通过 package.json 的 `contributes.icons` 注册再以 `$(axon-logo)` 引用。
 */

import * as vscode from "vscode";

/** 点击状态栏按钮时执行的命令（聚焦 Axon 对话视图）。 */
const FOCUS_CHAT_COMMAND = "axon.focusChat";

/**
 * 创建并注册 Axon 状态栏入口。返回的 disposable 由调用方纳入
 * context.subscriptions 统一释放。
 */
export function registerAxonStatusBar(context: vscode.ExtensionContext): vscode.StatusBarItem {
  const item = vscode.window.createStatusBarItem(
    "axon.aiChat",
    vscode.StatusBarAlignment.Right,
    100,
  );

  item.name = "Axon";
  item.text = "$(sparkle) Axon";
  item.tooltip = "点击打开 AI 对话";
  item.command = FOCUS_CHAT_COMMAND;
  item.show();

  context.subscriptions.push(item);
  return item;
}

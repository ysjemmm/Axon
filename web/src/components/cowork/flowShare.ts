/** 流程的分享与导入：复制成一段文本发给同事，对方粘贴导入 */

import type { CoworkFlowDraft } from "./flowTypes";

/** 空白流程的起点：一个可多选的输入槽 + 一个空步骤 */
export const BLANK_FLOW: CoworkFlowDraft = { name: "", inputs: [{ id: "files", label: "要处理的文件", multiple: true }], steps: [""], checks: [] };

/** 同事分享的流程文本 → 草稿（去掉 id 和运行记录，作为一个新流程保存） */
export function parseSharedFlow(text: string): CoworkFlowDraft {
  let raw: unknown;
  try { raw = JSON.parse(text.trim()); } catch { throw new Error("这不是有效的流程内容，请完整复制对方分享的文本"); }
  const obj = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  if (typeof obj.name !== "string" || !Array.isArray(obj.steps) || !Array.isArray(obj.inputs)) throw new Error("内容里缺少流程名、步骤或输入文件");
  return {
    name: obj.name,
    ...(typeof obj.description === "string" ? { description: obj.description } : {}),
    inputs: (obj.inputs as CoworkFlowDraft["inputs"]).filter((i) => i && typeof i.label === "string"),
    steps: (obj.steps as unknown[]).filter((s): s is string => typeof s === "string"),
    checks: Array.isArray(obj.checks) ? (obj.checks as unknown[]).filter((s): s is string => typeof s === "string") : [],
    ...(typeof obj.outputName === "string" ? { outputName: obj.outputName } : {}),
    ...(typeof obj.askEachRun === "string" ? { askEachRun: obj.askEachRun } : {}),
  };
}

/** 分享用的文本：只带流程定义，不带 id、时间和运行记录 */
export function shareFlowText(flow: CoworkFlowDraft): string {
  const { name, description, inputs, steps, checks, outputName, askEachRun } = flow;
  return JSON.stringify({ axonFlow: 1, name, description, inputs, steps, checks, outputName, askEachRun }, null, 2);
}

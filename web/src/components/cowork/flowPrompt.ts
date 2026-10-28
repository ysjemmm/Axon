/**
 * 把一次 Cowork 任务拼成发给 Agent 的消息。
 *
 * 自由任务和流程任务共用结尾的交付约定（登记产出、登记核对）。核对对所有任务都要求：
 * 财务、会计最怕数字错了还看不出来，这是 Cowork 和普通对话最不一样的地方。
 */

import type { CoworkFlowDraft } from "./flowTypes";

export interface PickedFile {
  path: string;
  name: string;
}

function deliveryLines(outputDir: string, outputName?: string): string[] {
  const lines = ["", "请用 Markdown 分段回答：不同处理阶段各成一段，必要时用小标题或列表。简短回答无需刻意加标题。"];
  if (outputDir) lines.push("", `产出文件请放到：${outputDir}`);
  if (outputName) lines.push(`产出文件命名：${outputName}（花括号里的占位按本次实际情况填写）`);
  lines.push(
    "",
    "交付前：",
    "1. 真正去核对结果（金额合计、条数、有无遗漏或重复等），然后调用 report_checks 登记每一条核对结论，detail 里写清楚具体数字；",
    "2. 如果生成或改写了文件，调用 report_outputs 登记最终产出，为每个文件标明 kind：本轮新建用 created，修改已有文件用 edited（临时脚本不用登记）。",
  );
  return lines;
}

/** 自由任务 */
export function buildFreeTaskMessage(request: string, files: PickedFile[], outputDir: string): string {
  const lines: string[] = [];
  if (files.length > 0) {
    lines.push("要处理的文件：", ...files.map((f) => `- ${f.path}`), "");
  }
  lines.push(request);
  return [...lines, ...deliveryLines(outputDir)].join("\n");
}

/** 流程任务：固定步骤 + 本次文件（按槽位）+ 核对项 */
export function buildFlowMessage(flow: CoworkFlowDraft, slots: Record<string, PickedFile[]>, extra: { answer?: string; note?: string; outputDir: string }): string {
  const lines = [
    `【流程：${flow.name}】`,
    "这是用户保存的例行流程，步骤已经验证过，请照做。本次文件和上次不同（月份、行数、条目变化）是正常的；遇到步骤没覆盖的情况，按最稳妥的方式处理并在回复里说明。",
    "",
    "本次文件：",
  ];
  for (const input of flow.inputs) {
    const files = slots[input.id] ?? [];
    if (files.length === 0) {
      lines.push(`- ${input.label}：（本次未提供）`);
      continue;
    }
    if (files.length === 1) lines.push(`- ${input.label}：${files[0].path}`);
    else lines.push(`- ${input.label}（${files.length} 个）：`, ...files.map((f) => `  - ${f.path}`));
  }
  if (flow.askEachRun && extra.answer?.trim()) lines.push("", `${flow.askEachRun}：${extra.answer.trim()}`);
  lines.push("", "步骤：", ...flow.steps.map((s, i) => `${i + 1}. ${s}`));
  if (extra.note?.trim()) lines.push("", `本次的额外要求（优先于上面的步骤）：${extra.note.trim()}`);
  if (flow.checks.length > 0) lines.push("", "必须逐条核对：", ...flow.checks.map((c) => `- ${c}`));
  return [...lines, ...deliveryLines(extra.outputDir, flow.outputName)].join("\n");
}

/** 历史列表 / 任务卡片里显示的用户原话 */
export function flowDisplayText(flow: CoworkFlowDraft, extra: { answer?: string; note?: string }): string {
  const parts = [`运行流程「${flow.name}」`];
  if (extra.answer?.trim()) parts.push(extra.answer.trim());
  if (extra.note?.trim()) parts.push(extra.note.trim());
  return parts.join(" · ");
}

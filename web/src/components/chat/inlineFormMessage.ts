/**
 * 把内联表单的提交内容整理成一条用户消息
 *
 * 内联表单没有挂起门——提交在语义上就是「用户说了这段话」，所以把填写结果整理成文本、
 * 走普通消息链路即可，不需要新增协议。
 *
 * 格式刻意对齐 core 侧的 formatFormSubmission（阻塞式那条）：两种来源的表单提交在模型眼里
 * 是同一个结构，它不必区分"这是工具回来的还是用户发来的"。
 */

import type { FormFieldData, FormSpecData, FormSubmitData } from "./formTypes";

/** 把触发动作翻译成一句短描述；直接点提交时返回空串（不啰嗦）。 */
function describeAction(spec: FormSpecData, payload: FormSubmitData): string {
  if (payload.row) {
    const table = spec.fields.find((f) => f.name === payload.row!.table);
    const action = table?.rowActions?.find((a) => a.id === payload.row!.actionId);
    return `${table?.label ?? payload.row.table}第 ${payload.row.index + 1} 行的「${action?.label ?? payload.row.actionId}」`;
  }
  if (payload.action !== "submit") {
    const button = spec.buttons?.find((b) => b.id === payload.action);
    return `「${button?.label ?? payload.action}」`;
  }
  return "";
}

/** 带选项的字段把回传值翻成用户看到的文案（模型不必自己反查选项表）。 */
function describeValue(field: FormFieldData, value: unknown): string {
  if (value == null || value === "") return "（未填写）";
  if (field.type === "switch") return value === true ? "是" : "否";
  if (field.type === "select" || field.type === "radio") {
    return field.options?.find((o) => o.value === value)?.label ?? String(value);
  }
  if (field.type === "checkbox") {
    const picked = Array.isArray(value) ? value : [value];
    if (picked.length === 0) return "（未选择）";
    return picked.map((v) => field.options?.find((o) => o.value === v)?.label ?? String(v)).join("、");
  }
  if (Array.isArray(value)) return value.length === 0 ? "（未填写）" : value.map(String).join("、");
  return String(value);
}

function describeTable(field: FormFieldData, rows: unknown, selected: string[] | undefined): string {
  const columns = field.columns ?? [];
  const list = Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
  if (list.length === 0) return "（空表）";
  const lines = [
    `| ${columns.map((c) => c.label).join(" | ")} |`,
    `| ${columns.map(() => "---").join(" | ")} |`,
    ...list.map((row) => `| ${columns.map((c) => (row[c.key] == null || row[c.key] === "" ? "" : String(row[c.key]))).join(" | ")} |`),
  ];
  if (selected && selected.length > 0) {
    lines.push(`（勾选的行：${selected.map((k) => `第 ${Number(k) + 1} 行`).join("、")}）`);
  }
  return lines.join("\n");
}

/**
 * 生成要发给 AI 的用户消息正文。
 * 开头点明这是表单提交（模型据此知道该用填写结果继续，而不是反问一遍）。
 */
export function formatInlineFormMessage(spec: FormSpecData, payload: FormSubmitData): string {
  const action = describeAction(spec, payload);
  const head = spec.title ? `表单「${spec.title}」` : "表单";
  const lines: string[] = [action ? `（我提交了${head}，点了${action}）` : `（我提交了${head}）`, ""];

  for (const field of spec.fields) {
    if (field.type === "note") continue;
    if (field.type === "section") {
      if (field.title) lines.push(`【${field.title}】`);
      continue;
    }
    if (!field.name) continue;
    const value = payload.values[field.name];
    if (field.type === "table") {
      lines.push(`- ${field.label}：`);
      lines.push(describeTable(field, value, payload.selectedRows?.[field.name]));
    } else {
      lines.push(`- ${field.label}: ${describeValue(field, value)}`);
    }
  }

  return lines.join("\n");
}

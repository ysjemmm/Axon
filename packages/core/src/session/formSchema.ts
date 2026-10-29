/**
 * FormSchema —— AI 交付给用户的【声明式交互面板】
 *
 * 为什么需要它：ask_user 只能承载「在几个选项里选一个」（每题最多 4 个选项）。当 AI 需要用户
 * 填一套参数——文本、数值、开关、滑块、日期，甚至一张可编辑的表——选项卡片表达不了。
 *
 * 设计取舍：AI 只描述「要哪些控件、什么约束」，渲染、校验、主题、键盘操作全部交给前端。
 * 相比让 AI 直接写 HTML/JS，这样样式不会与产品割裂、没有脚本执行面、回传天然是结构化数据
 * （不必从 DOM 反向解析）。代价是控件类型由 Axon 固定，AI 不能自创交互形式。
 *
 * 两种交付方式共用这一份 schema：
 * - 阻塞式：ask_form 工具（继续任务前必须要这些输入，agent loop 挂起等提交）
 * - 内联式：回复里的 form 代码块（不打断这次回复，用户随时提交）
 */

/** 下拉 / 单选 / 多选共用的选项。 */
export interface FormOption {
  value: string;
  label: string;
  description?: string;
}

/** 表格列。type 决定单元格的编辑控件与校验方式。 */
export interface FormColumnSpec {
  key: string;
  label: string;
  type: "text" | "number" | "select";
  options?: FormOption[];
  /** false=只读列 */
  editable?: boolean;
  align?: "left" | "right";
}

/** 表格行内操作按钮；点击会立刻按「当前全部值 + 这个动作」提交。 */
export interface FormRowAction {
  id: string;
  label: string;
  danger?: boolean;
}

export type FormFieldType =
  | "text"
  | "textarea"
  | "number"
  | "select"
  | "radio"
  | "checkbox"
  | "switch"
  | "slider"
  | "date"
  | "time"
  | "tags"
  | "table"
  /** 视觉分组标题（不产生值） */
  | "section"
  /** 纯说明文本（不产生值） */
  | "note";

export interface FormFieldSpec {
  type: FormFieldType;
  /** 提交时的键；section / note 不需要 */
  name?: string;
  label?: string;
  help?: string;
  placeholder?: string;
  required?: boolean;
  default?: unknown;
  /** select / radio / checkbox 的选项 */
  options?: FormOption[];
  /** number / slider 的取值范围 */
  min?: number;
  max?: number;
  step?: number;
  /** textarea 行数 */
  rows?: number;
  /** table：列定义与初始行 */
  columns?: FormColumnSpec[];
  data?: Record<string, unknown>[];
  selectable?: boolean;
  addable?: boolean;
  removable?: boolean;
  rowActions?: FormRowAction[];
  /** section / note 的正文 */
  title?: string;
  text?: string;
}

export interface FormSpec {
  title?: string;
  description?: string;
  fields: FormFieldSpec[];
  submitLabel?: string;
  /** 次级动作按钮（如「取消」）；点击同样回传当前值 + 该按钮 id */
  buttons?: { id: string; label: string }[];
}

/** 用户提交时回传的内容：当前所有字段值 + 触发的动作。 */
export interface FormSubmitPayload {
  /** "submit" | 自定义按钮 id | `row:<表格名>:<行下标>:<动作 id>` */
  action: string;
  values: Record<string, unknown>;
  /** 表格名 → 被勾选的行 key 列表 */
  selectedRows?: Record<string, string[]>;
  /** 行内操作命中的位置，便于模型理解这次点击落在哪一行 */
  row?: { table: string; index: number; actionId: string };
}

// ── 规模上限：模型可能给出任意大的表单，这里统一收敛，避免渲染卡死或把上下文撑爆 ──
const MAX_FIELDS = 40;
const MAX_OPTIONS = 30;
const MAX_COLUMNS = 12;
const MAX_ROWS = 200;
const MAX_BUTTONS = 4;
/** 文本类字段回传值的长度上限（用户可能粘贴超长内容） */
const MAX_TEXT_LEN = 4000;

const VALUE_FIELD_TYPES = new Set<FormFieldType>([
  "text",
  "textarea",
  "number",
  "select",
  "radio",
  "checkbox",
  "switch",
  "slider",
  "date",
  "time",
  "tags",
  "table",
]);

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function asNumber(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

/** 规整选项列表；无 label 的项按 value 兜底，两者都没有则丢弃。 */
function normalizeOptions(raw: unknown): FormOption[] {
  if (!Array.isArray(raw)) return [];
  const out: FormOption[] = [];
  for (const item of raw) {
    if (out.length >= MAX_OPTIONS) break;
    if (item && typeof item === "object") {
      const o = item as Record<string, unknown>;
      const label = asString(o.label) ?? asString(o.text) ?? asString(o.title) ?? asString(o.name) ?? asString(o.value);
      if (!label) continue;
      const value = asString(o.value) ?? label;
      out.push({ value, label, description: asString(o.description) });
    } else if ((typeof item === "string" && item.trim()) || typeof item === "number") {
      // 允许模型图省事直接给字符串数组
      const text = String(item).trim();
      out.push({ value: text, label: text });
    }
  }
  return out;
}

/** 模型常用的控件类型叫法 → 本表单的类型 */
const TYPE_ALIASES: Record<string, FormFieldType> = {
  input: "text", string: "text", email: "text", url: "text", password: "text", path: "text", file: "text",
  multiline: "textarea", longtext: "textarea", paragraph: "textarea",
  integer: "number", int: "number", float: "number", range: "slider",
  dropdown: "select", enum: "select", choice: "radio", single: "radio",
  multiselect: "checkbox", checkboxes: "checkbox", multi: "checkbox", multiple: "checkbox",
  boolean: "switch", bool: "switch", toggle: "switch",
  datetime: "date", list: "tags", array: "tags", grid: "table",
  header: "section", heading: "section", title: "section", text_block: "note", info: "note", markdown: "note",
};

/** 从标签里造一个回传键：模型漏了 name 时用（英文数字保留，其余按序号） */
function nameFromLabel(label: string | undefined, index: number): string {
  const slug = (label ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return slug || `field_${index + 1}`;
}

function normalizeColumns(raw: unknown): FormColumnSpec[] {
  if (!Array.isArray(raw)) return [];
  const out: FormColumnSpec[] = [];
  for (const item of raw) {
    if (out.length >= MAX_COLUMNS) break;
    if (item && typeof item === "object") {
      const c = item as Record<string, unknown>;
      const key = asString(c.key);
      if (!key) continue;
      const type = c.type === "number" || c.type === "select" ? c.type : "text";
      out.push({
        key,
        label: asString(c.label) ?? key,
        type,
        options: type === "select" ? normalizeOptions(c.options) : undefined,
        editable: c.editable !== false,
        align: c.align === "right" ? "right" : undefined,
      });
    } else if (typeof item === "string" && item.trim()) {
      out.push({ key: item.trim(), label: item.trim(), type: "text", editable: true });
    }
  }
  return out;
}

function normalizeRows(raw: unknown, columns: FormColumnSpec[]): Record<string, unknown>[] {
  if (!Array.isArray(raw)) return [];
  const out: Record<string, unknown>[] = [];
  for (const item of raw) {
    if (out.length >= MAX_ROWS) break;
    if (!item || typeof item !== "object") continue;
    const src = item as Record<string, unknown>;
    const row: Record<string, unknown> = {};
    for (const col of columns) {
      const v = src[col.key];
      row[col.key] = col.type === "number" ? (asNumber(v) ?? null) : (v == null ? "" : String(v));
    }
    out.push(row);
  }
  return out;
}

function normalizeRowActions(raw: unknown): FormRowAction[] {
  if (!Array.isArray(raw)) return [];
  const out: FormRowAction[] = [];
  for (const item of raw) {
    if (out.length >= MAX_BUTTONS) break;
    if (!item || typeof item !== "object") continue;
    const a = item as Record<string, unknown>;
    const id = asString(a.id);
    const label = asString(a.label);
    if (!id || !label) continue;
    out.push({ id, label, danger: a.danger === true });
  }
  return out;
}

/** 规整单个字段；返回 null 表示这个字段无法渲染（原因记进 why）。 */
function normalizeField(raw: unknown, index = 0, why: string[] = []): FormFieldSpec | null {
  const at = `第 ${index + 1} 个字段`;
  if (!raw || typeof raw !== "object") { why.push(`${at}不是对象`); return null; }
  const f = raw as Record<string, unknown>;
  const rawType = typeof f.type === "string" ? f.type.trim().toLowerCase() : "";
  const type = (TYPE_ALIASES[rawType] ?? rawType) as FormFieldType;

  // 布局类字段：只要有一段文字就保留
  if (type === "section" || type === "note") {
    const title = asString(f.title) ?? asString(f.label);
    const text = asString(f.text) ?? asString(f.content) ?? asString(f.description);
    if (!title && !text) { why.push(`${at}（${type}）没有 title / text`); return null; }
    return { type, title, text };
  }
  if (!VALUE_FIELD_TYPES.has(type)) {
    why.push(`${at}的 type「${rawType || "（缺）"}」不支持，可用：${[...VALUE_FIELD_TYPES].join(" / ")} / section / note`);
    return null;
  }

  // 没有 name 就没法回传值：依次用 key / id，再不行从 label 造一个
  const name = asString(f.name) ?? asString(f.key) ?? asString(f.id) ?? nameFromLabel(asString(f.label), index);

  const field: FormFieldSpec = {
    type,
    name,
    label: asString(f.label) ?? name,
    help: asString(f.help),
    placeholder: asString(f.placeholder),
    required: f.required === true,
    default: f.default,
  };

  if (type === "select" || type === "radio" || type === "checkbox") {
    const options = normalizeOptions(f.options ?? f.choices ?? f.enum);
    if (options.length === 0) { why.push(`${at}「${field.label}」是 ${type}，但没有 options`); return null; } // 没有选项的选择控件毫无意义
    field.options = options;
  } else if (type === "number" || type === "slider") {
    field.min = asNumber(f.min);
    field.max = asNumber(f.max);
    field.step = asNumber(f.step);
    if (type === "slider") {
      // 滑块必须有界，缺省给一个合理区间，否则控件无法定位
      if (field.min === undefined) field.min = 0;
      if (field.max === undefined) field.max = 100;
      if (field.step === undefined) field.step = 1;
    }
  } else if (type === "textarea") {
    field.rows = asNumber(f.rows);
  } else if (type === "table") {
    const columns = normalizeColumns(f.columns);
    if (columns.length === 0) { why.push(`${at}「${field.label}」是 table，但没有 columns`); return null; }
    field.columns = columns;
    // 表格初始行用 data：rows 已被 textarea 的「行数」占用，同名会让模型和前端都犯迷糊
    field.data = normalizeRows(f.data ?? (Array.isArray(f.rows) ? f.rows : undefined), columns);
    field.selectable = f.selectable === true;
    field.addable = f.addable === true;
    field.removable = f.removable !== false;
    field.rowActions = normalizeRowActions(f.rowActions);
  }

  return field;
}

/**
 * 把模型给的 form 参数规整成可渲染的 FormSpec。
 * 失败时返回 error 文案（会作为工具结果回给模型，让它自己修正后重试）。
 */
export function normalizeFormSpec(raw: unknown): { spec: FormSpec | null; error?: string } {
  if (!raw || typeof raw !== "object") {
    return { spec: null, error: "form 必须是一个对象，里面至少要有 fields 数组。" };
  }
  const src = raw as Record<string, unknown>;
  const rawFields = Array.isArray(src.fields) ? src.fields : [];
  const fields: FormFieldSpec[] = [];
  const why: string[] = [];
  rawFields.forEach((rf, i) => {
    if (fields.length >= MAX_FIELDS) return;
    const field = normalizeField(rf, i, why);
    if (field) fields.push(field);
  });
  // 有字段渲染不了就整张打回：只弹一半，模型会以为该问的都问到了
  if (fields.length === 0 || why.length > 0) {
    return {
      spec: null,
      error:
        `${why.length ? why.join("；") : "form.fields 是空的"}。` +
        "每个取值字段都要有 type 和 name；select / radio / checkbox 还要有 options；table 还要有 columns。" +
        '示例：{"form": {"title": "部署参数", "fields": [{"type": "text", "name": "host", "label": "主机"}, {"type": "select", "name": "env", "label": "环境", "options": ["dev", "prod"]}]}}',
    };
  }
  // 回传键重复会互相覆盖：重复的加序号
  const used = new Set<string>();
  for (const field of fields) {
    if (!field.name) continue;
    let name = field.name;
    for (let n = 2; used.has(name); n++) name = `${field.name}_${n}`;
    field.name = name;
    used.add(name);
  }
  const buttons: { id: string; label: string }[] = [];
  if (Array.isArray(src.buttons)) {
    for (const b of src.buttons) {
      if (buttons.length >= MAX_BUTTONS) break;
      if (!b || typeof b !== "object") continue;
      const item = b as Record<string, unknown>;
      const id = asString(item.id);
      const label = asString(item.label);
      if (id && label) buttons.push({ id, label });
    }
  }
  return {
    spec: {
      title: asString(src.title),
      description: asString(src.description),
      submitLabel: asString(src.submitLabel) ?? "提交",
      buttons: buttons.length > 0 ? buttons : undefined,
      fields,
    },
  };
}

/** 把一个字段值转成人类/模型都能读的短文本。 */
function describeValue(field: FormFieldSpec, value: unknown): string {
  if (value == null || value === "") return "（未填写）";
  if (field.type === "switch") return value === true ? "是" : "否";
  if (Array.isArray(value)) {
    if (value.length === 0) return "（未填写）";
    return value.map((v) => String(v)).join("、");
  }
  if (field.type === "select" || field.type === "radio") {
    return field.options?.find((o) => o.value === value)?.label ?? String(value);
  }
  if (field.type === "checkbox") {
    const picked = Array.isArray(value) ? value : [value];
    return picked.map((v) => field.options?.find((o) => o.value === v)?.label ?? String(v)).join("、");
  }
  const text = String(value);
  return text.length > MAX_TEXT_LEN ? `${text.slice(0, MAX_TEXT_LEN)}…（已截断）` : text;
}

/** 表格渲染成 Markdown，模型读起来最省力。 */
function describeTable(field: FormFieldSpec, rows: unknown, selected: string[] | undefined): string {
  const columns = field.columns ?? [];
  const list = Array.isArray(rows) ? rows : [];
  if (list.length === 0) return "（空表）";
  const lines: string[] = [];
  lines.push(`| ${columns.map((c) => c.label).join(" | ")} |`);
  lines.push(`| ${columns.map(() => "---").join(" | ")} |`);
  for (const row of list) {
    const r = (row ?? {}) as Record<string, unknown>;
    lines.push(`| ${columns.map((c) => (r[c.key] == null || r[c.key] === "" ? "" : String(r[c.key]))).join(" | ")} |`);
  }
  if (selected && selected.length > 0) {
    lines.push(`（用户勾选的行：${selected.map((k) => `第 ${Number(k) + 1} 行`).join("、")}）`);
  }
  return lines.join("\n");
}

/** 把触发动作翻译成一句人话，让模型知道用户到底点了什么。 */
function describeAction(spec: FormSpec, payload: FormSubmitPayload): string {
  if (payload.row) {
    const table = spec.fields.find((f) => f.name === payload.row!.table);
    const action = table?.rowActions?.find((a) => a.id === payload.row!.actionId);
    return `用户点了「${table?.label ?? payload.row.table}」第 ${payload.row.index + 1} 行的「${action?.label ?? payload.row.actionId}」按钮`;
  }
  if (payload.action !== "submit") {
    const button = spec.buttons?.find((b) => b.id === payload.action);
    return `用户点了「${button?.label ?? payload.action}」按钮`;
  }
  return "用户点提交";
}

/**
 * 把一次表单提交整形成给模型看的文本。
 * 输出「动作 + 逐字段值」，表格用 Markdown；未填字段也显式列出，避免模型以为漏了。
 */
export function formatFormSubmission(spec: FormSpec, payload: FormSubmitPayload): string {
  const head = spec.title ? `表单「${spec.title}」` : "表单";
  const lines: string[] = [`${describeAction(spec, payload)}——${head}的当前内容：`, ""];

  for (const field of spec.fields) {
    if (field.type === "section") {
      if (field.title) lines.push(`【${field.title}】`);
      continue;
    }
    if (field.type === "note") continue;
    if (!field.name) continue;
    const value = payload.values[field.name];
    if (field.type === "table") {
      lines.push(`- ${field.label}（表格）：`);
      lines.push(describeTable(field, value, payload.selectedRows?.[field.name]));
    } else {
      lines.push(`- ${field.label}: ${describeValue(field, value)}`);
    }
  }

  return lines.join("\n");
}

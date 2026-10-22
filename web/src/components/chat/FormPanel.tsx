/**
 * FormPanel —— 声明式表单面板（AI 交付给用户的控件集合）
 *
 * 两种交付方式共用这一个组件：
 * - 阻塞式（ask_form 工具）：卡片渲染在会话区容器内（与消息同宽、最高占会话区一半），
 *   用户提交后 agent loop 继续
 * - 内联式（回复里的 form 块）：渲染在消息里，随时提交，提交作为一条新消息回到 AI
 *
 * 职责边界：只负责「把已经规整过的字段渲染出来 + 收集值 + 做必填校验」。schema 的合法性与
 * 规模上限由 core 侧统一处理（见 formSchema.ts），这里不再重复判断结构是否合法。
 *
 * 提交语义：**任何一次提交都回传当前全部字段值 + 触发的动作**。行内按钮、次级按钮同理——
 * 用户是"改到一半顺手点了删除"，只回一个行号会丢掉他此前填的所有内容。
 */

import { useMemo, useState } from "react";
import { Check } from "lucide-react";
import type { FormFieldData, FormSpecData, FormSubmitData } from "./formTypes";
import { FormTable } from "./FormTable";

export interface FormPanelProps {
  spec: FormSpecData;
  onSubmit: (payload: FormSubmitData) => void;
  /** 已提交/已失效时禁用全部交互（内联面板提交后需要保留在消息里，故由外部控制） */
  disabled?: boolean;
}

const INPUT_CLASS =
  "w-full bg-muted/40 border border-border/60 rounded-md px-2 py-1 text-xs text-foreground outline-none " +
  "placeholder:text-muted-foreground/40 focus:border-primary/60 focus:bg-muted/60 transition-colors";

/** 按字段类型给出初始值：能预填 default 就预填，否则给一个类型正确的空值。 */
function initialValue(field: FormFieldData): unknown {
  if (field.default !== undefined && field.default !== null) return field.default;
  switch (field.type) {
    case "switch":
      return false;
    case "checkbox":
    case "tags":
      return [];
    case "slider":
      return field.min ?? 0;
    case "number":
    case "text":
    case "textarea":
    case "date":
    case "time":
    case "radio":
    case "select":
    default:
      return "";
  }
}

/** 判断一个字段当前是否有值（用于必填校验）。 */
function isEmptyValue(field: FormFieldData, value: unknown): boolean {
  if (field.type === "table") return !Array.isArray(value) || value.length === 0;
  if (field.type === "switch") return false; // 开关永远有确定值
  if (field.type === "checkbox" || field.type === "tags") return !Array.isArray(value) || value.length === 0;
  return value === undefined || value === null || value === "";
}

export function FormPanel({ spec, onSubmit, disabled }: FormPanelProps) {
  const [values, setValues] = useState<Record<string, unknown>>(() => {
    const init: Record<string, unknown> = {};
    for (const f of spec.fields) {
      if (!f.name) continue;
      init[f.name] = f.type === "table" ? (f.data ?? []) : initialValue(f);
    }
    return init;
  });
  const [selectedRows, setSelectedRows] = useState<Record<string, string[]>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [tagDraft, setTagDraft] = useState<Record<string, string>>({});
  const [submitted, setSubmitted] = useState(false);

  const locked = disabled || submitted;

  const patch = (name: string, value: unknown) => {
    setValues((prev) => ({ ...prev, [name]: value }));
    // 用户开始改这一项就撤掉它的报错，避免"明明填了还红着"
    setErrors((prev) => (prev[name] ? { ...prev, [name]: "" } : prev));
  };

  const toggleSelected = (table: string, index: number) => {
    setSelectedRows((prev) => {
      const cur = prev[table] ?? [];
      const key = String(index);
      return { ...prev, [table]: cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key] };
    });
  };

  /** 提交前的必填校验：只拦"确实没填"的项，不做格式校验（各控件已由 input type 约束）。 */
  const validate = (): boolean => {
    const next: Record<string, string> = {};
    for (const f of spec.fields) {
      if (!f.name || !f.required) continue;
      if (isEmptyValue(f, values[f.name])) next[f.name] = "此项必填";
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const fire = (action: string, row?: FormSubmitData["row"]) => {
    if (locked) return;
    // 行内按钮与次级按钮同样要先过校验：它们多半是"删除某行后再提交"，
    // 若必填项空着，回传一份不完整的参数对模型毫无帮助。
    if (!validate()) return;
    setSubmitted(true);
    onSubmit({
      action,
      values,
      selectedRows: Object.keys(selectedRows).length > 0 ? selectedRows : undefined,
      row,
    });
  };

  const optionRowClass = (on: boolean, last: boolean) =>
    on
      ? "rounded-lg border border-primary bg-primary/5"
      : `border-b border-border/40 hover:bg-muted/40 ${last ? "border-b-0" : ""}`;

  const rendered = useMemo(
    () =>
      spec.fields.map((field, index) => {
        if (field.type === "section") {
          return (
            <div key={`s-${index}`} className="pt-1">
              <div className="text-[11px] font-medium text-muted-foreground/80">{field.title}</div>
            </div>
          );
        }
        if (field.type === "note") {
          return (
            <div key={`n-${index}`} className="text-[11px] leading-4 text-muted-foreground/60">
              {field.text}
            </div>
          );
        }

        const name = field.name!;
        const value = values[name];
        const error = errors[name];

        return (
          <div key={`${name}-${index}`} className="space-y-1">
            {field.label && field.type !== "switch" && (
              <div className="flex items-center gap-1">
                <span className="text-[11px] text-foreground/80">{field.label}</span>
                {field.required && <span className="text-[10px] text-destructive/70">*</span>}
              </div>
            )}

            {field.type === "text" && (
              <input
                type="text"
                className={INPUT_CLASS}
                value={String(value ?? "")}
                placeholder={field.placeholder}
                disabled={locked}
                onChange={(e) => patch(name, e.target.value)}
              />
            )}

            {field.type === "textarea" && (
              <textarea
                className={`${INPUT_CLASS} resize-y`}
                rows={field.rows ?? 3}
                value={String(value ?? "")}
                placeholder={field.placeholder}
                disabled={locked}
                onChange={(e) => patch(name, e.target.value)}
              />
            )}

            {field.type === "number" && (
              <input
                type="number"
                className={INPUT_CLASS}
                value={value === "" || value == null ? "" : String(value)}
                min={field.min}
                max={field.max}
                step={field.step}
                placeholder={field.placeholder}
                disabled={locked}
                onChange={(e) => patch(name, e.target.value === "" ? "" : Number(e.target.value))}
              />
            )}

            {field.type === "date" && (
              <input
                type="date"
                className={INPUT_CLASS}
                value={String(value ?? "")}
                disabled={locked}
                onChange={(e) => patch(name, e.target.value)}
              />
            )}

            {field.type === "time" && (
              <input
                type="time"
                className={INPUT_CLASS}
                value={String(value ?? "")}
                disabled={locked}
                onChange={(e) => patch(name, e.target.value)}
              />
            )}

            {field.type === "select" && (
              <select
                className={INPUT_CLASS}
                value={String(value ?? "")}
                disabled={locked}
                onChange={(e) => patch(name, e.target.value)}
              >
                <option value="">{field.placeholder ?? "请选择…"}</option>
                {(field.options ?? []).map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            )}

            {(field.type === "radio" || field.type === "checkbox") && (
              <div className="rounded-lg border border-border/50 overflow-hidden">
                {(field.options ?? []).map((o, i, arr) => {
                  const list = Array.isArray(value) ? (value as unknown[]) : [];
                  const on = field.type === "radio" ? value === o.value : list.includes(o.value);
                  return (
                    <button
                      key={o.value}
                      type="button"
                      disabled={locked}
                      onClick={() =>
                        patch(name, field.type === "radio" ? o.value : on ? list.filter((v) => v !== o.value) : [...list, o.value])
                      }
                      className={`w-full flex items-center gap-2.5 text-left px-2 py-1.5 transition-colors ${optionRowClass(on, i === arr.length - 1)}`}
                    >
                      <span
                        className={`shrink-0 w-4 h-4 rounded flex items-center justify-center transition-colors ${
                          on ? "bg-primary" : "bg-muted/70"
                        }`}
                      >
                        {on && <Check className="w-3 h-3 text-primary-foreground" strokeWidth={3} />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className={`block text-xs leading-4 ${on ? "text-foreground" : "text-foreground/80"}`}>{o.label}</span>
                        {o.description && <span className="block text-[11px] leading-4 text-muted-foreground/60">{o.description}</span>}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}

            {field.type === "switch" && (
              <button
                type="button"
                disabled={locked}
                onClick={() => patch(name, value !== true)}
                className="flex items-center gap-2 text-left"
              >
                <span className={`shrink-0 w-8 h-4.5 rounded-full p-0.5 transition-colors ${value === true ? "bg-primary" : "bg-muted"}`}>
                  <span className={`block w-3.5 h-3.5 rounded-full bg-background transition-transform ${value === true ? "translate-x-3.5" : ""}`} />
                </span>
                <span className="text-xs text-foreground/80">{field.label ?? name}</span>
              </button>
            )}

            {field.type === "slider" && (
              <div className="flex items-center gap-2">
                <input
                  type="range"
                  className="flex-1 accent-[var(--primary)]"
                  min={field.min ?? 0}
                  max={field.max ?? 100}
                  step={field.step ?? 1}
                  value={Number(value ?? field.min ?? 0)}
                  disabled={locked}
                  onChange={(e) => patch(name, Number(e.target.value))}
                />
                <span className="w-10 text-right text-[11px] tabular-nums text-muted-foreground">{String(value ?? "")}</span>
              </div>
            )}

            {field.type === "tags" && (
              <div className="flex flex-wrap items-center gap-1 bg-muted/40 border border-border/60 rounded-md px-1.5 py-1">
                {(Array.isArray(value) ? (value as unknown[]) : []).map((t) => (
                  <span key={String(t)} className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-primary/10 text-[11px] text-primary">
                    {String(t)}
                    <button
                      type="button"
                      disabled={locked}
                      onClick={() => patch(name, (value as unknown[]).filter((v) => v !== t))}
                      className="text-primary/60 hover:text-primary"
                    >
                      ×
                    </button>
                  </span>
                ))}
                <input
                  type="text"
                  value={tagDraft[name] ?? ""}
                  placeholder={field.placeholder ?? "输入后回车"}
                  disabled={locked}
                  onChange={(e) => setTagDraft((prev) => ({ ...prev, [name]: e.target.value }))}
                  onKeyDown={(e) => {
                    // 中文输入法用 Enter 上屏候选词，此时 keydown 也带 Enter，不排掉会误加标签
                    if (e.nativeEvent.isComposing) return;
                    const raw = (tagDraft[name] ?? "").trim();
                    if (e.key !== "Enter" || !raw) return;
                    e.preventDefault();
                    const list = Array.isArray(value) ? (value as unknown[]) : [];
                    if (!list.includes(raw)) patch(name, [...list, raw]);
                    setTagDraft((prev) => ({ ...prev, [name]: "" }));
                  }}
                  className="flex-1 min-w-[80px] bg-transparent text-[11px] text-foreground outline-none placeholder:text-muted-foreground/40"
                />
              </div>
            )}

            {field.type === "table" && (
              <FormTable
                columns={field.columns ?? []}
                rows={Array.isArray(value) ? (value as Record<string, unknown>[]) : []}
                selectable={field.selectable}
                addable={field.addable}
                removable={field.removable}
                rowActions={field.rowActions}
                selected={selectedRows[name] ?? []}
                disabled={locked}
                onRowsChange={(rows) => patch(name, rows)}
                onToggleRow={(i) => toggleSelected(name, i)}
                onRowAction={(i, actionId) => fire(`row:${name}:${i}:${actionId}`, { table: name, index: i, actionId })}
              />
            )}

            {error && <div className="text-[10px] text-destructive/80">{error}</div>}
            {!error && field.help && <div className="text-[10px] text-muted-foreground/50">{field.help}</div>}
          </div>
        );
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [spec, values, errors, selectedRows, tagDraft, locked],
  );

  return (
    <div className="mb-2 rounded-xl border border-border bg-popover overflow-hidden">
      {(spec.title || spec.description) && (
        <div className="px-3.5 pt-2.5 pb-1.5">
          {spec.title && <div className="text-[13px] font-medium text-foreground">{spec.title}</div>}
          {spec.description && <div className="text-[11px] leading-4 text-muted-foreground/70 mt-0.5">{spec.description}</div>}
        </div>
      )}

      <div className="px-3.5 py-2 space-y-2.5">{rendered}</div>

      <div className="flex items-center gap-1.5 px-3.5 py-1.5 border-t border-border/40">
        <button
          type="button"
          onClick={() => fire("submit")}
          disabled={locked}
          className="px-2 py-0.5 rounded text-[11px] font-medium bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
        >
          {submitted ? "已提交" : (spec.submitLabel ?? "提交")}
        </button>
        {(spec.buttons ?? []).map((b) => (
          <button
            key={b.id}
            type="button"
            onClick={() => fire(b.id)}
            disabled={locked}
            className="px-1.5 py-0.5 rounded text-[11px] text-muted-foreground hover:text-foreground hover:bg-muted/50 disabled:opacity-40 transition-colors"
          >
            {b.label}
          </button>
        ))}
        {locked && !submitted && <span className="ml-auto text-[10px] text-muted-foreground/50">已失效</span>}
      </div>
    </div>
  );
}

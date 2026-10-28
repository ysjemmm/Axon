/**
 * 流程编辑器：确认 AI 整理出的草稿、修改已有流程、把模板存成自己的流程，都用这一个。
 *
 * 只暴露办公用户能理解的字段：要放哪些文件、按什么步骤做、做完核对什么、产出叫什么。
 */

import { useState } from "react";
import { Loader2, Plus, X } from "lucide-react";
import type { CoworkFlowDraft, CoworkFlowInput } from "./flowTypes";

interface FlowEditorProps {
  title: string;
  initial: CoworkFlowDraft;
  onSave: (flow: CoworkFlowDraft) => Promise<void>;
  onClose: () => void;
}

const field = "w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-[13px] outline-none focus:ring-1 focus:ring-ring";

function RemoveButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button type="button" onClick={onClick} aria-label={label} className="mt-1 shrink-0 rounded p-1 text-muted-foreground hover:bg-muted/60 hover:text-destructive">
      <X className="h-3.5 w-3.5" />
    </button>
  );
}

/** 一组可增删的文本行（步骤、核对项） */
function LineList({ items, onChange, placeholder, numbered, addLabel }: { items: string[]; onChange: (items: string[]) => void; placeholder: string; numbered?: boolean; addLabel: string }) {
  return (
    <div className="space-y-1.5">
      {items.map((item, index) => (
        <div key={index} className="flex items-start gap-1.5">
          {numbered && <span className="mt-1.5 w-4 shrink-0 text-right text-[12px] text-muted-foreground">{index + 1}.</span>}
          <textarea
            value={item}
            rows={Math.min(4, Math.max(1, Math.ceil(item.length / 48)))}
            onChange={(e) => onChange(items.map((v, i) => (i === index ? e.target.value : v)))}
            placeholder={placeholder}
            className={`${field} resize-none`}
          />
          <RemoveButton onClick={() => onChange(items.filter((_, i) => i !== index))} label="删除这一条" />
        </div>
      ))}
      <button type="button" onClick={() => onChange([...items, ""])} className="inline-flex items-center gap-1 text-[12px] text-muted-foreground hover:text-foreground">
        <Plus className="h-3.5 w-3.5" />{addLabel}
      </button>
    </div>
  );
}

export function FlowEditor({ title, initial, onSave, onClose }: FlowEditorProps) {
  const [flow, setFlow] = useState<CoworkFlowDraft>(() => ({ ...initial, inputs: initial.inputs.map((i) => ({ ...i })), steps: [...initial.steps], checks: [...initial.checks] }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const set = (patch: Partial<CoworkFlowDraft>) => setFlow((prev) => ({ ...prev, ...patch }));
  const setInput = (index: number, patch: Partial<CoworkFlowInput>) => set({ inputs: flow.inputs.map((input, i) => (i === index ? { ...input, ...patch } : input)) });

  const save = async () => {
    setError("");
    const clean: CoworkFlowDraft = {
      ...flow,
      name: flow.name.trim(),
      inputs: flow.inputs.filter((i) => i.label.trim()),
      steps: flow.steps.map((s) => s.trim()).filter(Boolean),
      checks: flow.checks.map((c) => c.trim()).filter(Boolean),
    };
    if (!clean.name) { setError("给流程起个名字"); return; }
    if (clean.inputs.length === 0) { setError("至少需要一类输入文件"); return; }
    if (clean.steps.length === 0) { setError("至少需要一个步骤"); return; }
    setSaving(true);
    try { await onSave(clean); } catch (e) { setError((e as Error).message); setSaving(false); }
  };

  return (
    <div className="absolute inset-0 z-50 flex flex-col bg-background">
      <header className="flex shrink-0 items-center justify-between border-b border-border px-4 py-2.5">
        <span className="text-[13px] font-medium text-foreground">{title}</span>
        <button onClick={onClose} className="rounded-md p-1 text-muted-foreground hover:bg-muted/60 hover:text-foreground" aria-label="关闭"><X className="h-4 w-4" /></button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[640px] space-y-5 px-4 py-5">
          <section className="space-y-2">
            <input value={flow.name} onChange={(e) => set({ name: e.target.value })} placeholder="流程名，如「月度银行对账」" className={`${field} text-[15px] font-medium`} />
            <input value={flow.description ?? ""} onChange={(e) => set({ description: e.target.value })} placeholder="一句话说明它做什么（可不填）" className={field} />
          </section>

          <section>
            <h3 className="mb-1 text-[12px] font-medium text-foreground">每次要放的文件</h3>
            <p className="mb-2 text-[12px] text-muted-foreground">按文件的角色分，不按具体文件：三个月的流水是一类「可放多个」的文件。</p>
            <div className="space-y-2">
              {flow.inputs.map((input, index) => (
                <div key={index} className="flex items-start gap-1.5 rounded-lg border border-border p-2">
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <input value={input.label} onChange={(e) => setInput(index, { label: e.target.value })} placeholder="叫什么，如「银行流水」" className={field} />
                    <input value={input.hint ?? ""} onChange={(e) => setInput(index, { hint: e.target.value })} placeholder="提示（可不填），如「网银导出的 Excel」" className={field} />
                    <div className="flex gap-4 text-[12px] text-muted-foreground">
                      <label className="inline-flex items-center gap-1.5"><input type="checkbox" checked={!!input.multiple} onChange={(e) => setInput(index, { multiple: e.target.checked })} />可放多个</label>
                      <label className="inline-flex items-center gap-1.5"><input type="checkbox" checked={!!input.optional} onChange={(e) => setInput(index, { optional: e.target.checked })} />可以不放</label>
                    </div>
                  </div>
                  <RemoveButton onClick={() => set({ inputs: flow.inputs.filter((_, i) => i !== index) })} label="删除这类文件" />
                </div>
              ))}
              <button type="button" onClick={() => set({ inputs: [...flow.inputs, { id: `input${Date.now().toString(36)}`, label: "" }] })} className="inline-flex items-center gap-1 text-[12px] text-muted-foreground hover:text-foreground">
                <Plus className="h-3.5 w-3.5" />添加一类文件
              </button>
            </div>
          </section>

          <section>
            <h3 className="mb-2 text-[12px] font-medium text-foreground">步骤</h3>
            <LineList items={flow.steps} onChange={(steps) => set({ steps })} placeholder="这一步做什么" numbered addLabel="添加步骤" />
          </section>

          <section>
            <h3 className="mb-1 text-[12px] font-medium text-foreground">做完后核对</h3>
            <p className="mb-2 text-[12px] text-muted-foreground">写能用数字验证的事，如「汇总表合计等于各原表合计之和」。每次运行都会逐条核对并告诉你结果。</p>
            <LineList items={flow.checks} onChange={(checks) => set({ checks })} placeholder="核对什么" addLabel="添加核对项" />
          </section>

          <section className="space-y-2">
            <div>
              <h3 className="mb-1 text-[12px] font-medium text-foreground">产出文件命名（可不填）</h3>
              <input value={flow.outputName ?? ""} onChange={(e) => set({ outputName: e.target.value })} placeholder="如「对账结果_{本期}.xlsx」" className={field} />
            </div>
            <div>
              <h3 className="mb-1 text-[12px] font-medium text-foreground">每次运行前要问你的（可不填）</h3>
              <input value={flow.askEachRun ?? ""} onChange={(e) => set({ askEachRun: e.target.value })} placeholder="如「本期是哪个月」" className={field} />
            </div>
          </section>
        </div>
      </div>
      <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-border px-4 py-2.5">
        {error && <span className="mr-auto text-[12px] text-destructive">{error}</span>}
        <button onClick={onClose} className="rounded-md px-3 py-1.5 text-[12px] text-muted-foreground hover:bg-muted/60 hover:text-foreground">取消</button>
        <button onClick={save} disabled={saving} className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3.5 py-1.5 text-[12px] font-medium text-primary-foreground disabled:opacity-60">
          {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}保存
        </button>
      </footer>
    </div>
  );
}

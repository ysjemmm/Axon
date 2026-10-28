/**
 * 运行一个流程：按输入槽放文件，回答这一期的问题（如「本期月份」），点运行。
 *
 * 步骤和核对项默认折起来：用户关心的是「放什么文件」，想确认它会怎么做时再展开看。
 */

import { useState, type ReactNode } from "react";
import { ArrowLeft, ChevronRight, FilePlus2, Pencil, Play, Save } from "lucide-react";
import { AttachmentCard, FileCardBody } from "@/components/chat/AttachmentCard";
import { attachmentTypeLabel } from "@/components/chat/attachmentType";
import { mergeFiles, type PickedFileInfo } from "./useFilePicker";
import type { CoworkFlowDraft } from "./flowTypes";

export interface FlowRunValues {
  slots: Record<string, PickedFileInfo[]>;
  answer: string;
  note: string;
}

interface FlowRunnerProps {
  flow: CoworkFlowDraft;
  /** 模板（还没存进我的流程）：显示「存为我的流程」而不是「编辑」 */
  isTemplate: boolean;
  /** 上一次运行留下的文件，「换一批文件再运行」时清空，「重新运行」时保留 */
  initial?: Partial<FlowRunValues>;
  pickFiles: (onPicked: (files: PickedFileInfo[]) => void) => boolean;
  onRun: (values: FlowRunValues) => void;
  onBack: () => void;
  onEdit: () => void;
  /** 模型 / 强度选择器（由面板提供，和自由任务共用一份偏好） */
  modelControls: ReactNode;
  disabledReason?: string;
}

export function FlowRunner({ flow, isTemplate, initial, pickFiles, onRun, onBack, onEdit, modelControls, disabledReason }: FlowRunnerProps) {
  const [slots, setSlots] = useState<Record<string, PickedFileInfo[]>>(initial?.slots ?? {});
  const [answer, setAnswer] = useState(initial?.answer ?? "");
  const [note, setNote] = useState(initial?.note ?? "");
  const [showSteps, setShowSteps] = useState(false);
  const [notice, setNotice] = useState("");

  const missing = flow.inputs.filter((i) => !i.optional && !(slots[i.id]?.length));
  const canRun = missing.length === 0 && !disabledReason;

  const addFiles = (slotId: string, multiple: boolean | undefined) => {
    const ok = pickFiles((files) => {
      if (files.length === 0) return;
      setSlots((prev) => ({ ...prev, [slotId]: multiple ? mergeFiles(prev[slotId] ?? [], files) : files.slice(0, 1) }));
      setNotice("");
    });
    if (!ok) setNotice("请在 Axon 中使用文件选择");
  };

  return (
    <div className="mx-auto w-full max-w-[max(640px,80%)] py-5">
      <button onClick={onBack} className="mb-3 inline-flex items-center gap-1 text-[12px] text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-3.5 w-3.5" />返回
      </button>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-[17px] font-medium text-foreground">{flow.name}</h2>
          {flow.description && <p className="mt-1 text-[13px] text-muted-foreground">{flow.description}</p>}
        </div>
        <button onClick={onEdit} className="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[12px] text-muted-foreground hover:bg-muted/60 hover:text-foreground">
          {isTemplate ? <><Save className="h-3.5 w-3.5" />存为我的流程</> : <><Pencil className="h-3.5 w-3.5" />编辑</>}
        </button>
      </div>

      <div className="mt-5 space-y-4">
        {flow.inputs.map((input) => {
          const files = slots[input.id] ?? [];
          return (
            <div key={input.id}>
              <div className="flex items-baseline gap-2">
                <span className="text-[13px] font-medium text-foreground">{input.label}</span>
                {input.optional && <span className="text-[11px] text-muted-foreground">可选</span>}
                {input.multiple && <span className="text-[11px] text-muted-foreground">可放多个</span>}
              </div>
              {input.hint && <p className="mt-0.5 text-[12px] text-muted-foreground">{input.hint}</p>}
              <div className="mt-2 flex flex-wrap items-center gap-3">
                {files.map((file) => (
                  <AttachmentCard
                    key={file.path}
                    onRemove={() => setSlots((prev) => ({ ...prev, [input.id]: (prev[input.id] ?? []).filter((f) => f.path !== file.path) }))}
                    removeLabel={`移除 ${file.name}`}
                    title={file.path}
                    previewPath={file.path}
                  >
                    <FileCardBody name={file.name} badge={attachmentTypeLabel({ name: file.name, kind: "file" })} />
                  </AttachmentCard>
                ))}
                {(input.multiple || files.length === 0) && (
                  <button onClick={() => addFiles(input.id, input.multiple)} className="inline-flex h-28 items-center gap-1.5 rounded-lg border border-dashed border-border px-4 text-[12px] text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground">
                    <FilePlus2 className="h-4 w-4" />{files.length === 0 ? "选择文件" : "继续添加"}
                  </button>
                )}
                {!input.multiple && files.length > 0 && (
                  <button onClick={() => addFiles(input.id, false)} className="text-[12px] text-muted-foreground hover:text-foreground">换一个</button>
                )}
              </div>
            </div>
          );
        })}

        {flow.askEachRun && (
          <div>
            <label className="text-[13px] font-medium text-foreground">{flow.askEachRun}</label>
            <input value={answer} onChange={(e) => setAnswer(e.target.value)} className="mt-1.5 h-8 w-full rounded-md border border-border bg-background px-2.5 text-[13px] outline-none focus:ring-1 focus:ring-ring" />
          </div>
        )}

        <div>
          <button onClick={() => setShowSteps((v) => !v)} className="inline-flex items-center gap-1 text-[12px] text-muted-foreground hover:text-foreground">
            <ChevronRight className={`h-3.5 w-3.5 transition-transform ${showSteps ? "rotate-90" : ""}`} />它会这样做（{flow.steps.length} 步{flow.checks.length ? `，${flow.checks.length} 项核对` : ""}）
          </button>
          {showSteps && (
            <div className="mt-2 rounded-lg bg-muted/40 px-3.5 py-2.5 text-[12px] leading-relaxed text-foreground/90">
              <ol className="list-decimal space-y-0.5 pl-4">{flow.steps.map((s, i) => <li key={i}>{s}</li>)}</ol>
              {flow.checks.length > 0 && (
                <>
                  <div className="mt-2 font-medium text-muted-foreground">做完会核对</div>
                  <ul className="list-disc space-y-0.5 pl-4">{flow.checks.map((c, i) => <li key={i}>{c}</li>)}</ul>
                </>
              )}
              {flow.outputName && <div className="mt-2 text-muted-foreground">产出：{flow.outputName}</div>}
            </div>
          )}
        </div>

        <div>
          <label className="text-[12px] text-muted-foreground">这次还有什么特别要求？（可不填）</label>
          <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} className="mt-1 w-full resize-none rounded-md border border-border bg-background px-2.5 py-1.5 text-[13px] outline-none focus:ring-1 focus:ring-ring" />
        </div>
      </div>

      {(notice || disabledReason || missing.length > 0) && (
        <p className="mt-3 text-[12px] text-amber-600 dark:text-amber-500">
          {notice || disabledReason || `还差：${missing.map((m) => m.label).join("、")}`}
        </p>
      )}
      <div className="mt-3 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-0.5">{modelControls}</div>
        <button
          onClick={() => onRun({ slots, answer, note })}
          disabled={!canRun}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-primary px-4 py-1.5 text-[13px] font-medium text-primary-foreground transition-opacity disabled:opacity-40"
        >
          <Play className="h-3.5 w-3.5" fill="currentColor" />运行
        </button>
      </div>
    </div>
  );
}


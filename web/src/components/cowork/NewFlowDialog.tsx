/**
 * 新建流程：一句话描述让 AI 起草步骤，或者从空白开始，或者粘贴同事分享的流程。
 * 三条路最后都进流程编辑器，用户确认后才保存。
 */

import { useState } from "react";
import { ClipboardPaste, FilePlus2, Loader2, Sparkles, X } from "lucide-react";
import type { CoworkFlowDraft } from "./flowTypes";
import { BLANK_FLOW, parseSharedFlow } from "./flowShare";

interface NewFlowDialogProps {
  onDraft: (description: string) => Promise<CoworkFlowDraft>;
  onOpenEditor: (draft: CoworkFlowDraft) => void;
  onClose: () => void;
}

export function NewFlowDialog({ onDraft, onOpenEditor, onClose }: NewFlowDialogProps) {
  const [mode, setMode] = useState<"describe" | "import">("describe");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const draft = async () => {
    if (!text.trim()) { setError("先描述一下这个流程要做什么"); return; }
    setBusy(true); setError("");
    try { onOpenEditor(await onDraft(text)); } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };

  const importFlow = () => {
    setError("");
    try { onOpenEditor(parseSharedFlow(text)); } catch (e) { setError((e as Error).message); }
  };

  return (
    <div className="absolute inset-0 z-50 flex items-start justify-center bg-background/80 px-4 pt-16 backdrop-blur-sm" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="w-full max-w-[560px] overflow-hidden rounded-2xl border border-border bg-background shadow-2xl">
        <header className="flex items-center justify-between border-b border-border px-4 py-2.5">
          <div className="flex gap-1">
            {([["describe", "新建流程"], ["import", "导入分享的流程"]] as const).map(([id, label]) => (
              <button key={id} onClick={() => { setMode(id); setError(""); setText(""); }}
                className={`rounded-full px-3 py-1 text-[12px] transition-colors ${mode === id ? "bg-foreground text-background" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"}`}>
                {label}
              </button>
            ))}
          </div>
          <button onClick={onClose} className="rounded-md p-1 text-muted-foreground hover:bg-muted/60 hover:text-foreground" aria-label="关闭"><X className="h-4 w-4" /></button>
        </header>

        <div className="space-y-3 px-4 py-4">
          {mode === "describe" ? (
            <>
              <p className="text-[13px] text-foreground">说说你每次都要做的这件事：放进来什么文件、怎么处理、最后要什么结果。</p>
              <textarea autoFocus rows={5} value={text} onChange={(e) => setText(e.target.value)}
                placeholder={"例如：每月把各门店的销售日报汇总，按门店和品类出一张月报，标出环比下降超过 10% 的品类，最后生成一份 Excel 发给区域经理。"}
                className="w-full resize-none rounded-lg border border-border bg-background px-3 py-2 text-[13px] leading-relaxed outline-none focus:ring-1 focus:ring-ring" />
              <p className="text-[11px] text-muted-foreground">AI 会写出输入文件、步骤和核对项，你确认、修改后再保存。用的是下方选择的模型。</p>
            </>
          ) : (
            <>
              <p className="text-[13px] text-foreground">粘贴同事用「复制分享」发给你的流程内容。</p>
              <textarea autoFocus rows={7} value={text} onChange={(e) => setText(e.target.value)} placeholder='{"axonFlow": 1, "name": "…", …}'
                className="w-full resize-none rounded-lg border border-border bg-background px-3 py-2 font-mono text-[12px] outline-none focus:ring-1 focus:ring-ring" />
            </>
          )}
          {error && <p className="text-[12px] text-destructive">{error}</p>}
        </div>

        <footer className="flex items-center justify-between gap-2 border-t border-border px-4 py-2.5">
          {mode === "describe" ? (
            <>
              <button onClick={() => onOpenEditor(BLANK_FLOW)} className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[12px] text-muted-foreground hover:bg-muted/60 hover:text-foreground">
                <FilePlus2 className="h-3.5 w-3.5" />从空白开始
              </button>
              <button onClick={draft} disabled={busy} className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3.5 py-1.5 text-[12px] font-medium text-primary-foreground disabled:opacity-60">
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}{busy ? "正在起草…" : "AI 起草"}
              </button>
            </>
          ) : (
            <>
              <span />
              <button onClick={importFlow} disabled={!text.trim()} className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3.5 py-1.5 text-[12px] font-medium text-primary-foreground disabled:opacity-60">
                <ClipboardPaste className="h-3.5 w-3.5" />导入
              </button>
            </>
          )}
        </footer>
      </div>
    </div>
  );
}

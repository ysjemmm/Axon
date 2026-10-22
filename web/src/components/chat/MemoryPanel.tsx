/**
 * MemoryPanel —— 会话记忆面板（查看 / 编辑 / 导出 / 导入）
 *
 * 记忆是「本次会话里值得跨会话带走的结论」的浓缩。它由模型在会话中调用 update_memory
 * 维护，也可以在这里手改，或把别处的一份 .md 导入进来。
 *
 * 与 .md 文件的关系：面板里编辑的是会话自己那份记忆；「导出」把它落成 .md，
 * 「导入」把一份 .md 覆盖进来。所以「换个会话接着用」= 导出 + 在新会话导入。
 */

import { useEffect, useState } from "react";
import { Brain, Download, History, Upload, X } from "lucide-react";
import { getSession, listSessions, type SessionMeta } from "@/lib/apiClient";

export interface MemoryPanelProps {
  memory: string;
  /** 保存到会话（走 set_memory 命令，core 落盘后会回推最新内容） */
  onSave: (content: string) => void;
  onClose: () => void;
}

export function MemoryPanel({ memory, onSave, onClose }: MemoryPanelProps) {
  const [draft, setDraft] = useState(memory);
  /** 空态下点「手动撰写」进入编辑；已有内容时默认就是编辑态 */
  const [editing, setEditing] = useState(false);
  // 「从会话导入」：列出已沉淀过记忆的会话，选中后把那份记忆取回来
  const [picking, setPicking] = useState(false);
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [pickingBusy, setPickingBusy] = useState(false);
  const [pickError, setPickError] = useState("");

  // 面板开着的时候模型可能又写了一次记忆：同步进草稿，避免用户基于旧内容编辑
  useEffect(() => setDraft(memory), [memory]);

  const dirty = draft !== memory;
  /** 什么时候显示正文编辑区：手点过「手动撰写」、已有记忆、或草稿被改过 */
  const showEditor = editing || !!memory.trim() || dirty;

  const exportMd = () => {
    const blob = new Blob([draft], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `axon-memory-${new Date().toISOString().slice(0, 10)}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  /**
   * 导入即生效：不走「先填草稿、再点保存」两步。
   * 导入本就是一次性的明确动作，多一步确认只让用户多点一次，
   * 而内容随时还能在面板里改。
   */
  const applyImported = (content: string) => {
    setDraft(content);
    onSave(content);
    setEditing(true);
  };

  const importMd = (file: File) => {
    const reader = new FileReader();
    // 显式按 UTF-8 读：记忆是中文为主的 Markdown，按默认编码读会乱码
    reader.onload = () => applyImported(typeof reader.result === "string" ? reader.result : "");
    reader.readAsText(file, "utf-8");
  };

  const openPicker = async () => {
    setPicking(true);
    setPickingBusy(true);
    setPickError("");
    try {
      const data = await listSessions();
      // 只列有记忆的：记忆为空的历史会话点开也没有内容，白让用户挑一遍
      setSessions((data.sessions || []).filter((s) => s.hasMemory));
    } catch (e) {
      setPickError((e as Error).message || "读取会话列表失败");
    } finally {
      setPickingBusy(false);
    }
  };

  const pickSession = async (id: string) => {
    setPickingBusy(true);
    setPickError("");
    try {
      const s = await getSession(id);
      applyImported(typeof s.memory === "string" ? s.memory : "");
      setPicking(false);
    } catch (e) {
      setPickError((e as Error).message || "读取该会话的记忆失败");
    } finally {
      setPickingBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="w-[min(720px,92vw)] max-h-[80vh] flex flex-col rounded-xl border border-border bg-background shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border/60">
          <Brain className="w-4 h-4 text-primary shrink-0" />
          <span className="text-sm font-medium text-foreground">会话记忆</span>
          <span className="text-[11px] text-muted-foreground/60 truncate">
            导出这份 .md，就能在新会话里导入接着用
          </span>
          <button
            onClick={onClose}
            className="ml-auto p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors shrink-0"
            title="关闭"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {picking ? (
          <div className="flex-1 min-h-[240px] overflow-y-auto px-2 py-2">
            {pickingBusy && <div className="px-2 py-3 text-[11px] text-muted-foreground/60">读取中…</div>}
            {pickError && <div className="px-2 py-3 text-[11px] text-destructive">{pickError}</div>}
            {!pickingBusy && !pickError && sessions.length === 0 && (
              <div className="px-2 py-3 text-[11px] text-muted-foreground/60">
                还没有任何会话沉淀过记忆。先在别的会话里聊出结论（或导入一份 .md），再来这里挑。
              </div>
            )}
            {sessions.map((s) => (
              <button
                key={s.id}
                onClick={() => pickSession(s.id)}
                className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-left hover:bg-muted/60 transition-colors"
              >
                <span className="flex-1 min-w-0 truncate text-[12.5px] text-foreground">{s.title || "未命名会话"}</span>
                <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/60">{s.memoryChars ?? 0} 字</span>
              </button>
            ))}
          </div>
        ) : showEditor ? (
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck={false}
            placeholder={
              "还没有记忆。\n\n模型会在会话里自动沉淀值得跨会话带走的结论；" +
              "也可以点下面的「导入 .md」或「从会话导入」，把别处的一份记忆带进来。"
            }
            className="flex-1 min-h-[240px] resize-none px-4 py-3 bg-transparent text-[12.5px] leading-relaxed text-foreground outline-none placeholder:text-muted-foreground/50"
          />
        ) : (
          <div className="flex-1 min-h-[240px] flex flex-col items-center justify-center gap-3 px-6 py-8">
            <p className="text-[12.5px] text-muted-foreground/80 text-center leading-relaxed">
              还没有记忆。模型会在会话里自动沉淀值得带走的结论；
              <br />
              也可以把别处的一份记忆带进来——带进来就直接生效。
            </p>
            <div className="flex items-center gap-2">
              <label className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-primary text-primary-foreground hover:bg-primary/90 cursor-pointer transition-colors">
                <Upload className="w-3.5 h-3.5" />
                导入 .md 文件
                <input
                  type="file"
                  accept=".md,.markdown,text/markdown,text/plain"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) importMd(f);
                    e.target.value = "";
                  }}
                />
              </label>
              <button
                onClick={() => void openPicker()}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-border text-foreground hover:bg-muted/60 transition-colors"
              >
                <History className="w-3.5 h-3.5" />
                从其他会话导入
              </button>
            </div>
            <button
              onClick={() => setEditing(true)}
              className="text-[11px] text-muted-foreground/60 hover:text-foreground transition-colors"
            >
              或直接手动撰写
            </button>
          </div>
        )}

        {(showEditor || picking) && (
        <div className="flex items-center gap-2 px-4 py-2.5 border-t border-border/60">
          <label className="flex items-center gap-1.5 px-2.5 py-1 rounded text-xs text-muted-foreground hover:text-foreground hover:bg-muted/60 cursor-pointer transition-colors">
            <Upload className="w-3.5 h-3.5" />
            导入 .md
            <input
              type="file"
              accept=".md,.markdown,text/markdown,text/plain"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) importMd(f);
                // 清空 input 的值：否则连续导入同一个文件不会再触发 change
                e.target.value = "";
              }}
            />
          </label>
          <button
            onClick={() => (picking ? setPicking(false) : void openPicker())}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded text-xs text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
          >
            <History className="w-3.5 h-3.5" />
            {picking ? "取消" : "从会话导入"}
          </button>
          <button
            onClick={exportMd}
            disabled={!draft.trim()}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded text-xs text-muted-foreground hover:text-foreground hover:bg-muted/60 disabled:opacity-40 transition-colors"
          >
            <Download className="w-3.5 h-3.5" />
            导出 .md
          </button>
          <span className="ml-auto text-[11px] tabular-nums text-muted-foreground/60">
            {draft.trim() ? `${draft.length} 字` : "空"}
          </span>
          <button
            onClick={() => onSave(draft)}
            disabled={!dirty}
            className="px-3 py-1 rounded text-xs font-medium bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40 transition-colors"
          >
            保存
          </button>
        </div>
        )}
      </div>
    </div>
  );
}

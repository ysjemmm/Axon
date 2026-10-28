/**
 * MemoryPanel —— 会话记忆面板（查看 / 编辑 / 导出 / 导入）
 *
 * 记忆是「本次会话里值得跨会话带走的结论」的浓缩。它由模型在会话中调用 update_memory
 * 维护，也可以在这里手改，或把别处的一份 .md 导入进来。
 *
 * 与 .md 文件的关系：面板里编辑的是会话自己那份记忆；「导出」把它落成 .md，
 * 「导入」把一份 .md 合并进来（不覆盖已有内容）。所以「换个会话接着用」= 导出 + 在新会话导入。
 *
 * 防覆盖：编辑期间后台可能又整理了记忆。草稿不会被推来的新内容冲掉，保存时带上开始编辑时的
 * base，由 core 做三方合并。每次改写前的旧内容都留有历史版本，可以在「历史版本」里恢复。
 */

import { useEffect, useState } from "react";
// 记忆用 NotebookPen（Brain 归「思考过程」独占，见 ToolCallItem 的 MemoryUpdatedRow 注释）
import { NotebookPen, Download, History, Upload, X, RotateCcw } from "lucide-react";
import { getSession, listSessions, type SessionMeta } from "@/lib/apiClient";
import type { MemoryVersion } from "./eventHandlers/types";

export interface MemoryPanelProps {
  memory: string;
  /** 历史版本（新的在前），点开「历史版本」时通过 onRequestHistory 拉取 */
  history: MemoryVersion[];
  /**
   * 保存到会话（走 set_memory 命令，core 合并、落盘后回推最新内容）。
   * 编辑保存带 base（开始编辑时的记忆），导入用 mode=merge。
   */
  onSave: (content: string, opts?: { base?: string; mode?: "replace" | "merge" }) => void;
  onRequestHistory: () => void;
  onRestore: (at: number) => void;
  onClose: () => void;
}

/** 历史版本是「被谁改写之前」的内容 */
const SOURCE_LABEL: Record<string, string> = {
  auto: "后台整理前",
  model: "AI 写入前",
  user: "你保存前",
  import: "导入前",
  restore: "恢复前",
};

function formatTime(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function MemoryPanel({ memory, history, onSave, onRequestHistory, onRestore, onClose }: MemoryPanelProps) {
  const [draft, setDraft] = useState(memory);
  /** 开始编辑时的记忆：保存时交给 core 做三方合并的基准 */
  const [base, setBase] = useState(memory);
  /** 编辑期间后台改过记忆（草稿没被冲掉，保存时会合并） */
  const [remoteChanged, setRemoteChanged] = useState(false);
  const [viewingHistory, setViewingHistory] = useState(false);
  const [openVersion, setOpenVersion] = useState<number | null>(null);
  /** 空态下点「手动撰写」进入编辑；已有内容时默认就是编辑态 */
  const [editing, setEditing] = useState(false);
  // 「从会话导入」：列出已沉淀过记忆的会话，选中后把那份记忆取回来
  const [picking, setPicking] = useState(false);
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [pickingBusy, setPickingBusy] = useState(false);
  const [pickError, setPickError] = useState("");

  const dirty = draft !== base;

  // 面板开着的时候后台可能又整理了一次记忆：没在编辑就直接同步；正在编辑就保留草稿，
  // 只提示一下——早先这里无条件 setDraft，用户没保存的编辑会被整份冲掉。
  useEffect(() => {
    if (draft === base) {
      setDraft(memory);
      setBase(memory);
      setRemoteChanged(false);
    } else if (memory !== base) {
      setRemoteChanged(true);
    }
    // 只在 core 推来新内容时触发；draft / base 是本次判断用的快照
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memory]);

  const save = () => {
    onSave(draft, { base });
    // 先把基准挪到草稿上：core 回推合并结果时（内容不同），上面的 effect 会把它同步进来
    setBase(draft);
    setRemoteChanged(false);
  };

  const openHistory = () => {
    setViewingHistory(true);
    setPicking(false);
    setOpenVersion(null);
    onRequestHistory();
  };
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
   * 导入即生效，而且是合并：不走「先填草稿、再点保存」两步，也不整份覆盖已有记忆
   * （早先导入会把本会话已经攒下的记忆整个冲掉）。合并结果由 core 回推。
   */
  const applyImported = (content: string) => {
    if (!content.trim()) return;
    onSave(content, { mode: "merge" });
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
          <NotebookPen className="w-4 h-4 text-primary shrink-0" />
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

        {remoteChanged && !viewingHistory && (
          <div className="px-4 py-1.5 text-[11px] text-amber-600 dark:text-amber-400 bg-amber-500/10 border-b border-amber-500/20">
            你编辑期间记忆在后台更新过。直接保存即可：你的改动和后台新写的内容会自动合并。
          </div>
        )}

        {viewingHistory ? (
          <div className="flex-1 min-h-[240px] overflow-y-auto px-2 py-2">
            {history.length === 0 && (
              <div className="px-2 py-3 text-[11px] text-muted-foreground/60">
                还没有历史版本。记忆每被改写一次（后台整理、AI 写入、你保存或导入），改写前的内容都会留一份在这里。
              </div>
            )}
            {history.map((v) => (
              <div key={v.at} className="rounded hover:bg-muted/40 transition-colors">
                <button
                  onClick={() => setOpenVersion(openVersion === v.at ? null : v.at)}
                  className="w-full flex items-center gap-2 px-2 py-1.5 text-left"
                >
                  <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/70">{formatTime(v.at)}</span>
                  <span className="shrink-0 text-[12px] text-foreground">{SOURCE_LABEL[v.source] || "改写前"}</span>
                  <span className="flex-1 min-w-0 truncate text-[11px] text-muted-foreground/60">
                    {v.content.split("\n").find((l) => l.trim() && !l.startsWith("#"))?.trim() || ""}
                  </span>
                  <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/60">{v.content.length} 字</span>
                </button>
                {openVersion === v.at && (
                  <div className="px-2 pb-2">
                    <pre className="max-h-56 overflow-y-auto whitespace-pre-wrap rounded border border-border bg-muted/30 px-3 py-2 text-[11.5px] leading-relaxed text-foreground/80">{v.content}</pre>
                    <button
                      onClick={() => { onRestore(v.at); setViewingHistory(false); }}
                      className="mt-1.5 flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                      恢复到这个版本
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        ) : picking ? (
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

        {(showEditor || picking || viewingHistory) && (
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
            onClick={() => (viewingHistory ? setViewingHistory(false) : openHistory())}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded text-xs text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            {viewingHistory ? "返回" : "历史版本"}
          </button>
          <button
            onClick={() => (picking ? setPicking(false) : (setViewingHistory(false), void openPicker()))}
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
            onClick={save}
            disabled={!dirty || viewingHistory}
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

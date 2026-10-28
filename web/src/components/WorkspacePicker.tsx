/**
 * 工作区目录选择器
 *
 * 通过后端 /api/fs/list 逐层下钻浏览服务器文件系统，选择一个目录作为工作区。
 * 绕开浏览器无法获取绝对路径的限制（由后端 Node fs 提供真实路径）。
 */

import { useState, useEffect, useCallback } from "react";
import { Folder, HardDrive, ChevronRight, Loader2, ArrowLeft, Check, Sparkles } from "lucide-react";
import { browseDirectory, type BrowseResult } from "@/lib/apiClient";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

interface WorkspacePickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 当前工作区（打开时定位用，可选） */
  initialPath?: string;
  /** 确认选择回调，参数为选中目录的绝对路径 */
  onSelect: (path: string) => void;
  /** 可选：用户明确确认后初始化该目录的 .axon；普通选择不会触发 */
  onInitialize?: (path: string) => void;
  onPropose?: (path: string) => void;
  proposal?: { workspace: string; content: string } | null;
  proposalLoading?: boolean;
  onAcceptProposal?: (workspace: string, content: string) => void;
  onCloseProposal?: () => void;
  /** 对话框标题。缺省为「选择工作区目录」；复用为其它用途（如选文档产出目录）时传入 */
  title?: string;
  /** 确认按钮文案。缺省为「选为工作区」 */
  confirmLabel?: string;
}

export function WorkspacePicker({
  open, onOpenChange, initialPath, onSelect,
  onInitialize,
  onPropose,
  proposal,
  proposalLoading,
  onAcceptProposal,
  onCloseProposal,
  title = "选择工作区目录",
  confirmLabel = "选为工作区",
}: WorkspacePickerProps) {
  const [result, setResult] = useState<BrowseResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [confirmInitialize, setConfirmInitialize] = useState(false);

  const browse = useCallback(async (path?: string) => {
    setLoading(true);
    setError("");
    try {
      const data = await browseDirectory(path);
      setResult(data);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  // 打开时定位到初始路径（或盘符列表）
  useEffect(() => {
    if (open) {
      browse(initialPath || undefined);
    }
  }, [open, initialPath, browse]);

  const current = result?.current || "";
  const canSelect = !!current && !result?.isRoot;

  const close = (next: boolean) => {
    if (next) setConfirmInitialize(false);
    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="!max-w-[600px] w-[600px] max-h-[70vh] !flex flex-col gap-0 p-0 overflow-hidden">
        <DialogHeader className="px-4 py-3 pr-12 border-b border-border space-y-0 shrink-0">
          <DialogTitle className="text-sm">{title}</DialogTitle>
        </DialogHeader>

        {/* 当前路径 / 面包屑 */}
        <div className="flex items-center gap-2 px-4 py-2 border-b border-border bg-muted/30 text-xs">
          <button
            onClick={() => browse(result?.parent ?? undefined)}
            disabled={result?.parent === null || loading}
            className="p-1 rounded hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            title="上级目录"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <span className="font-mono text-muted-foreground truncate flex-1">
            {result?.isRoot ? "此电脑（选择驱动器）" : current || "/"}
          </span>
        </div>

        {/* 目录列表 */}
        <div className="flex-1 min-h-[280px] max-h-[45vh] overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center h-40 text-muted-foreground">
              <Loader2 className="w-5 h-5 animate-spin" />
            </div>
          ) : error ? (
            <div className="p-4 text-sm text-destructive">{error}</div>
          ) : result && result.entries.length > 0 ? (
            <ul className="py-1">
              {result.entries.map((entry) => (
                <li key={entry.path}>
                  <button
                    onClick={() => browse(entry.path)}
                    className="flex items-center gap-2.5 w-full px-4 py-1.5 text-sm text-left hover:bg-muted/60 transition-colors"
                  >
                    {result.isRoot
                      ? <HardDrive className="w-4 h-4 shrink-0 text-muted-foreground" />
                      : <Folder className="w-4 h-4 shrink-0 text-blue-500" />}
                    <span className="truncate flex-1">{entry.name}</span>
                    <ChevronRight className="w-3.5 h-3.5 shrink-0 text-muted-foreground/50" />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <div className="flex items-center justify-center h-40 text-sm text-muted-foreground">
              此目录下没有子文件夹
            </div>
          )}
        </div>

        {/* 底部操作栏 */}
        <div className="flex items-center justify-between gap-3 px-4 py-3 border-t border-border shrink-0">
          <span className="text-xs text-muted-foreground truncate flex-1 min-w-0">
            {canSelect ? `将选择：${current}` : "进入一个目录后即可选择"}
          </span>
          <div className="flex gap-2 shrink-0">
            <Button variant="ghost" size="sm" onClick={() => close(false)}>取消</Button>
            {onInitialize && canSelect && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setConfirmInitialize(true)}
              >
                <Sparkles className="w-4 h-4 mr-1" />
                初始化 Axon
              </Button>
            )}
            <Button
              size="sm"
              disabled={!canSelect}
              onClick={() => { onSelect(current); close(false); }}
            >
              <Check className="w-4 h-4 mr-1" />
              {confirmLabel}
            </Button>
          </div>
        </div>
        {proposal && onAcceptProposal ? (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/90 p-5">
            <div className="flex h-full max-h-[620px] w-full max-w-[560px] flex-col rounded-xl border border-border bg-background p-4 shadow-lg">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Sparkles className="h-4 w-4 text-primary" />
                AXON.md 草案
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                这是只读分析生成的草案，AI 没有写入文件。请审阅后再决定是否采用。
              </p>
              <textarea
                value={proposal.content}
                readOnly
                spellCheck={false}
                className="mt-3 min-h-0 flex-1 resize-none rounded-md border border-border bg-muted/20 p-3 font-mono text-[11px] leading-relaxed text-foreground outline-none"
              />
              <div className="mt-3 flex justify-end gap-2">
                <Button variant="ghost" size="sm" onClick={onCloseProposal}>返回</Button>
                <Button size="sm" onClick={() => { onAcceptProposal(proposal.workspace, proposal.content); close(false); }}>
                  <Check className="mr-1 h-4 w-4" />采用并初始化
                </Button>
              </div>
            </div>
          </div>
        ) : confirmInitialize && onInitialize ? (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/80 p-6">
            <div className="w-full max-w-[430px] rounded-xl border border-border bg-background p-4 shadow-lg">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Sparkles className="w-4 h-4 text-primary" />
                初始化 Axon 工作区
              </div>
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                将在该目录创建缺失的 `.axon/AXON.md`、`.axon/settings.json` 以及配置子目录。
                已存在的文件不会覆盖，普通选择工作区不会创建任何文件。
              </p>
              <code className="mt-3 block max-h-20 overflow-auto rounded bg-muted/50 px-2 py-1.5 text-[11px] text-muted-foreground">
                {current}/.axon/
              </code>
              <div className="mt-4 flex justify-end gap-2">
                <Button variant="ghost" size="sm" onClick={() => setConfirmInitialize(false)}>返回</Button>
                {onPropose && (
                  <Button variant="outline" size="sm" disabled={proposalLoading} onClick={() => onPropose(current)}>
                    {proposalLoading ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Sparkles className="mr-1 h-4 w-4" />}
                    让 AI 生成草案
                  </Button>
                )}
                <Button size="sm" onClick={() => { onInitialize(current); setConfirmInitialize(false); close(false); }}>
                  确认初始化
                </Button>
              </div>
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

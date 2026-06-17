/**
 * 工作区目录选择器
 *
 * 通过后端 /api/fs/list 逐层下钻浏览服务器文件系统，选择一个目录作为工作区。
 * 绕开浏览器无法获取绝对路径的限制（由后端 Node fs 提供真实路径）。
 */

import { useState, useEffect, useCallback } from "react";
import { Folder, HardDrive, ChevronRight, Loader2, ArrowLeft, Check } from "lucide-react";
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
}

export function WorkspacePicker({
  open, onOpenChange, initialPath, onSelect,
}: WorkspacePickerProps) {
  const [result, setResult] = useState<BrowseResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="!max-w-[600px] w-[600px] max-h-[70vh] !flex flex-col gap-0 p-0 overflow-hidden">
        <DialogHeader className="px-4 py-3 pr-12 border-b border-border space-y-0 shrink-0">
          <DialogTitle className="text-sm">选择工作区目录</DialogTitle>
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
            <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>取消</Button>
            <Button
              size="sm"
              disabled={!canSelect}
              onClick={() => { onSelect(current); onOpenChange(false); }}
            >
              <Check className="w-4 h-4 mr-1" />
              选为工作区
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

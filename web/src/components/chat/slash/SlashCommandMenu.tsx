/**
 * 斜杠命令菜单 —— 纯展示组件（无业务逻辑、无 IDE 依赖）
 *
 * 查询串来自编辑器里的 “/query”，菜单本身不含输入框：
 *  - commands：命令列表；无匹配命令时展示文件兜底结果
 *  - search：进入某命令后的资源结果（顶部面包屑提示当前范围）
 *
 * 定位：绝对定位贴在输入框上方（父容器需 position: relative）。键盘导航由上层 hook 处理。
 */

import { useEffect, useRef } from "react";
import { Loader2, ChevronRight, FileText, Folder } from "lucide-react";
import type { ResourceItem, SlashCommand } from "./types";

interface SlashCommandMenuProps {
  mode: "commands" | "search";
  breadcrumb?: string | null;
  commandItems: SlashCommand[];
  fallbackResults: ResourceItem[];
  results: ResourceItem[];
  loading: boolean;
  activeIndex: number;
  onHover: (index: number) => void;
  onSelect: (index: number) => void;
  onRequestClose: () => void;
  /** 点击该元素内部不触发关闭（通常是输入框） */
  ignoreRef?: React.RefObject<HTMLElement | null>;
}

export function SlashCommandMenu({
  mode,
  breadcrumb,
  commandItems,
  fallbackResults,
  results,
  loading,
  activeIndex,
  onHover,
  onSelect,
  onRequestClose,
  ignoreRef,
}: SlashCommandMenuProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const activeItemRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    activeItemRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, mode, results.length, commandItems.length, fallbackResults.length]);

  useEffect(() => {
    const onDocMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (containerRef.current?.contains(target)) return;
      if (ignoreRef?.current?.contains(target)) return;
      onRequestClose();
    };
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [onRequestClose, ignoreRef]);

  const renderRow = (key: string, index: number, icon: React.ReactNode, title: string, subtitle: string) => {
    const active = index === activeIndex;
    return (
      <button
        key={key}
        ref={active ? activeItemRef : undefined}
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onMouseEnter={() => onHover(index)}
        onClick={() => onSelect(index)}
        className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs transition-colors ${
          active ? "bg-primary/10 text-foreground" : "text-foreground/90 hover:bg-muted/50"
        }`}
      >
        <span className="shrink-0 text-muted-foreground">{icon}</span>
        <span
          className="min-w-0 flex-1 truncate font-medium"
          title={title}
        >
          {title}
        </span>
        <span
          className="ml-2 max-w-[45%] min-w-0 shrink truncate text-right text-[10px] text-muted-foreground/70"
          title={subtitle}
        >
          {subtitle}
        </span>
      </button>
    );
  };

  const resourceRow = (item: ResourceItem, index: number) =>
    renderRow(
      item.path || item.relativePath,
      index,
      item.kind === "folder" ? <Folder className="h-3.5 w-3.5" /> : <FileText className="h-3.5 w-3.5" />,
      item.name,
      item.relativePath,
    );

  return (
    <div
      ref={containerRef}
      className="absolute bottom-full left-0 right-0 z-30 mb-2 flex max-h-72 flex-col overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-lg"
    >
      {(mode === "search" || loading) && (
        <div className="flex items-center gap-1.5 border-b border-border/60 px-2.5 py-1.5 text-[11px] text-muted-foreground">
          {breadcrumb && (
            <span className="flex shrink-0 items-center gap-1">
              {breadcrumb}
              <ChevronRight className="h-3 w-3" />
            </span>
          )}
          <span className="flex-1 truncate">{mode === "search" ? "搜索结果" : "搜索中…"}</span>
          {loading && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />}
        </div>
      )}
      <div className="overflow-y-auto py-1">
        {mode === "search" ? (
          results.length > 0 ? (
            results.map((item, index) => resourceRow(item, index))
          ) : (
            <div className="px-2.5 py-3 text-center text-[11px] text-muted-foreground">{loading ? "搜索中…" : "无匹配结果"}</div>
          )
        ) : commandItems.length > 0 ? (
          commandItems.map((cmd, index) => {
            const Icon = cmd.icon;
            return renderRow(cmd.id, index, <Icon className="h-3.5 w-3.5" />, cmd.label, cmd.description);
          })
        ) : fallbackResults.length > 0 ? (
          fallbackResults.map((item, index) => resourceRow(item, index))
        ) : (
          <div className="px-2.5 py-3 text-center text-[11px] text-muted-foreground">{loading ? "搜索中…" : "无匹配命令"}</div>
        )}
      </div>
    </div>
  );
}

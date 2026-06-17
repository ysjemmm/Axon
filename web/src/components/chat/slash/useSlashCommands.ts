/**
 * 斜杠命令交互编排 hook（contentEditable 版）
 *
 * 与 MentionEditor 协作：检测从编辑器传入的“光标前文本”里的 “/query”，维护两级菜单
 * （命令列表 / 进入某命令后的资源搜索），处理键盘导航与选择，选择后剥离编辑器里的 “/query”。
 *
 * 统一用编辑器里的 “/query” 作为查询源（不再有独立搜索输入框）：
 *  - 未进入搜索范围：展示匹配命令；无匹配命令则按文件名兜底搜索。
 *  - 选中“文件/文件夹”命令：设置 activeScope，保留 “/query” 继续驱动该范围的搜索。
 *  - 选中资源或动作命令：剥离 “/query” 并触发对应上下文注入。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ResourceItem, ResourceScope, SlashCommand, SlashCommandHost } from "./types";
import { DEFAULT_SLASH_COMMANDS } from "./commands";

export type SlashMode = "commands" | "search";

interface EditorBridge {
  deleteBeforeCaret: (len: number) => void;
  focus: () => void;
}

interface UseSlashCommandsOptions {
  host: SlashCommandHost;
  editor: EditorBridge;
  commands?: SlashCommand[];
}

export interface UseSlashCommandsResult {
  open: boolean;
  mode: SlashMode;
  activeCommand: SlashCommand | null;
  commandItems: SlashCommand[];
  fallbackResults: ResourceItem[];
  results: ResourceItem[];
  loading: boolean;
  activeIndex: number;
  /** 编辑器内容变化时调用，传入光标前文本 */
  handleTextChange: (textBeforeCaret: string) => void;
  /** 编辑器 onKeyDown 接线：返回 true 表示已被菜单消费 */
  handleKeyDown: (e: React.KeyboardEvent) => boolean;
  setActiveIndex: (i: number) => void;
  selectAt: (i: number) => void;
  close: () => void;
}

export function useSlashCommands(opts: UseSlashCommandsOptions): UseSlashCommandsResult {
  const { host, editor } = opts;
  const commands = opts.commands ?? DEFAULT_SLASH_COMMANDS;

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeScope, setActiveScope] = useState<ResourceScope | null>(null);
  const [activeCommand, setActiveCommand] = useState<SlashCommand | null>(null);
  const [results, setResults] = useState<ResourceItem[]>([]);
  const [fallbackResults, setFallbackResults] = useState<ResourceItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);

  const mode: SlashMode = activeScope ? "search" : "commands";

  const commandItems = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter((c) => [c.label, c.id, ...(c.keywords ?? [])].join(" ").toLowerCase().includes(q));
  }, [commands, query]);

  const visible: Array<SlashCommand | ResourceItem> = activeScope
    ? results
    : commandItems.length > 0
      ? commandItems
      : fallbackResults;
  const lenRef = useRef(0);
  lenRef.current = visible.length;

  useEffect(() => {
    setActiveIndex((i) => (visible.length === 0 ? 0 : Math.min(i, visible.length - 1)));
  }, [visible.length]);

  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
    setActiveScope(null);
    setActiveCommand(null);
    setResults([]);
    setFallbackResults([]);
    setActiveIndex(0);
    setLoading(false);
  }, []);

  // 检测 “/query” 触发
  const handleTextChange = useCallback(
    (before: string) => {
      const slashIdx = before.lastIndexOf("/");
      const q = slashIdx >= 0 ? before.slice(slashIdx + 1) : "";
      const prev = slashIdx > 0 ? before[slashIdx - 1] : "";
      const valid = slashIdx >= 0 && !/[\s/]/.test(q) && prev !== "/" && prev !== ":";
      if (valid) {
        setQuery(q);
        setActiveIndex(0);
        setOpen(true);
      } else if (open) {
        close();
      }
    },
    [open, close],
  );

  // 剥离编辑器里的 “/query”（query 个字符 + 1 个 “/”）
  const stripToken = useCallback(() => {
    editor.deleteBeforeCaret(query.length + 1);
  }, [editor, query]);

  // 进入搜索范围后：query 变化触发该范围的防抖搜索
  useEffect(() => {
    if (!activeScope) return;
    let cancelled = false;
    setLoading(true);
    const scope = activeScope;
    const timer = window.setTimeout(async () => {
      const found = await host.searchResources(query, scope);
      if (cancelled) return;
      setResults(found);
      setLoading(false);
      setActiveIndex(0);
    }, 120);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [activeScope, query, host]);

  // 命令模式兜底：无匹配命令时按文件名搜索
  useEffect(() => {
    if (activeScope) return;
    const q = query.trim();
    if (q === "" || commandItems.length > 0) {
      setFallbackResults([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const timer = window.setTimeout(async () => {
      const found = await host.searchResources(q, "file");
      if (cancelled) return;
      setFallbackResults(found);
      setLoading(false);
      setActiveIndex(0);
    }, 150);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [activeScope, query, commandItems.length, host]);

  const pickResource = useCallback(
    (item: ResourceItem) => {
      stripToken();
      host.addResourceContext(item);
      close();
      requestAnimationFrame(() => editor.focus());
    },
    [stripToken, host, close, editor],
  );

  const pickCommand = useCallback(
    (cmd: SlashCommand) => {
      if (cmd.kind === "action") {
        stripToken();
        cmd.run?.(host);
        close();
        requestAnimationFrame(() => editor.focus());
        return;
      }
      // 搜索类命令：设范围、保留 “/query” 继续驱动搜索
      setActiveScope(cmd.scope ?? "file");
      setActiveCommand(cmd);
      setResults([]);
      setActiveIndex(0);
      setOpen(true);
    },
    [stripToken, host, close, editor],
  );

  const selectAt = useCallback(
    (index: number) => {
      if (activeScope) {
        const item = results[index];
        if (item) pickResource(item);
        return;
      }
      if (commandItems.length > 0) {
        const cmd = commandItems[index];
        if (cmd) pickCommand(cmd);
        return;
      }
      const item = fallbackResults[index];
      if (item) pickResource(item);
    },
    [activeScope, results, commandItems, fallbackResults, pickResource, pickCommand],
  );

  const move = useCallback((delta: number) => {
    setActiveIndex((i) => {
      const n = lenRef.current;
      if (n === 0) return 0;
      return (i + delta + n) % n;
    });
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent): boolean => {
      if (!open) return false;
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          move(1);
          return true;
        case "ArrowUp":
          e.preventDefault();
          move(-1);
          return true;
        case "Enter":
        case "Tab":
          e.preventDefault();
          selectAt(activeIndex);
          return true;
        case "Escape":
          e.preventDefault();
          close();
          return true;
        default:
          return false;
      }
    },
    [open, move, selectAt, activeIndex, close],
  );

  return {
    open,
    mode,
    activeCommand,
    commandItems,
    fallbackResults,
    results,
    loading,
    activeIndex,
    handleTextChange,
    handleKeyDown,
    setActiveIndex,
    selectAt,
    close,
  };
}

/**
 * SessionContainer —— 多会话面板生命周期管理器
 *
 * 管理多个 ChatPanel 实例（跨 AXON/QUEST 两种模式共存）：
 * - 当前激活 tab 的面板始终挂载且可见。
 * - RUNNING（流式中）的其他会话面板保留挂载，仅隐藏——切走不中断，切回无缝（含跨模式：
 *   切到 QUEST 时正在跑的 AGENT 会话面板继续后台运行）。
 * - IDLE 的非当前会话面板延迟 30s 卸载，释放内存；再切回时重新挂载并从持久化恢复。
 *
 * 每个 tab 有稳定的 `key`，同时用作面板的 clientId（事件总线路由 + 命令打标），跨切换保持稳定。
 */

import { useState, useRef, useEffect, useCallback } from "react";
import { ChatPanel } from "./ChatPanel";

export interface SessionTab {
  /** null = 新会话（尚未创建） */
  id: string | null;
  title: string;
  /** 稳定的面板标识（同时作为 clientId），由 App 创建 tab 时生成 */
  key: string;
  /** 会话模式：agent=智能体，quest=纯问答 */
  mode: "agent" | "quest";
}

interface SessionContainerProps {
  /** 全部 tab（AXON + QUEST 并集，保证切换模式时另一模式 running 面板仍挂载） */
  tabs: SessionTab[];
  /** 当前激活（可见）的 tab key */
  activeKey: string | null;
  connected: boolean;
  send: (cmd: Record<string, unknown>) => void;
  /** 会话被创建后回传（按 tab key 定位），供 App 更新对应 tab 的 id */
  onSessionCreated: (key: string, id: string) => void;
  /** 压缩迁移：当前 tab 会话已迁移到新会话，App 应打开新 tab */
  onCompactionMigrated?: (newSessionId: string) => void;
}

/** IDLE 面板卸载延迟（ms） */
const IDLE_UNMOUNT_DELAY = 30_000;

export function SessionContainer({ tabs, activeKey, connected, send, onSessionCreated, onCompactionMigrated }: SessionContainerProps) {
  // 当前应挂载的面板 key 集合
  const [aliveKeys, setAliveKeys] = useState<Set<string>>(() => new Set(activeKey ? [activeKey] : []));
  const runningRef = useRef<Set<string>>(new Set());
  const idleTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const cancelIdleTimer = useCallback((key: string) => {
    const t = idleTimers.current.get(key);
    if (t) { clearTimeout(t); idleTimers.current.delete(key); }
  }, []);

  const scheduleUnmount = useCallback((key: string) => {
    cancelIdleTimer(key);
    const t = setTimeout(() => {
      idleTimers.current.delete(key);
      setAliveKeys((prev) => {
        if (!prev.has(key)) return prev;
        const n = new Set(prev);
        n.delete(key);
        return n;
      });
    }, IDLE_UNMOUNT_DELAY);
    idleTimers.current.set(key, t);
  }, [cancelIdleTimer]);

  // 当前激活 tab 变化：确保其挂载且不被卸载；非当前、非 RUNNING 的面板安排卸载
  useEffect(() => {
    if (!activeKey) return;
    cancelIdleTimer(activeKey);
    setAliveKeys((prev) => (prev.has(activeKey) ? prev : new Set(prev).add(activeKey)));
    aliveKeys.forEach((key) => {
      if (key !== activeKey && !runningRef.current.has(key)) scheduleUnmount(key);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeKey, cancelIdleTimer, scheduleUnmount]);

  // tab 被关闭（从 tabs 移除）：立即卸载其面板并清理
  useEffect(() => {
    const validKeys = new Set(tabs.map((t) => t.key));
    setAliveKeys((prev) => {
      let changed = false;
      const n = new Set(prev);
      prev.forEach((k) => {
        if (!validKeys.has(k)) {
          n.delete(k);
          changed = true;
          cancelIdleTimer(k);
          runningRef.current.delete(k);
        }
      });
      return changed ? n : prev;
    });
  }, [tabs, cancelIdleTimer]);

  useEffect(() => {
    const timers = idleTimers.current;
    return () => { timers.forEach((t) => clearTimeout(t)); timers.clear(); };
  }, []);

  const handleStreamingChange = useCallback((key: string, streaming: boolean) => {
    if (streaming) {
      runningRef.current.add(key);
      cancelIdleTimer(key);
      setAliveKeys((prev) => (prev.has(key) ? prev : new Set(prev).add(key)));
    } else {
      runningRef.current.delete(key);
      if (key !== activeKey) scheduleUnmount(key);
    }
  }, [activeKey, cancelIdleTimer, scheduleUnmount]);

  // 实际渲染集合：始终包含当前激活 tab（避免首帧缺失），叠加保活集合
  const keysToRender = new Set(aliveKeys);
  if (activeKey) keysToRender.add(activeKey);

  return (
    <>
      {tabs.filter((t) => keysToRender.has(t.key)).map((t) => {
        const isActive = t.key === activeKey;
        return (
          <div
            key={t.key}
            // 过场：进入的面板从右侧快速滑入（easeOutQuint，无淡入淡出）；离开的瞬时隐藏，不留鬼影
            className="absolute inset-0"
            style={{
              opacity: isActive ? 1 : 0,
              transform: isActive ? "translateX(0)" : "translateX(36px)",
              transition: isActive ? "transform 240ms cubic-bezier(0.22, 1, 0.36, 1)" : "none",
              pointerEvents: isActive ? "auto" : "none",
              zIndex: isActive ? 1 : 0,
              willChange: "transform",
            }}
            aria-hidden={!isActive}
          >
            <ChatPanel
              clientId={t.key}
              sessionId={t.id}
              mode={t.mode}
              connected={connected}
              active={isActive}
              send={send}
              onSessionCreated={(id) => onSessionCreated(t.key, id)}
              onCompactionMigrated={onCompactionMigrated}
              onStreamingChange={(streaming) => handleStreamingChange(t.key, streaming)}
            />
          </div>
        );
      })}
    </>
  );
}

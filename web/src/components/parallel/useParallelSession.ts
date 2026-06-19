/**
 * 并行工作流 Hook —— 管理并行面板的状态与事件处理
 *
 * 职责：
 * - 维护 ParallelBatch 列表状态（含 localStorage 持久化）
 * - 监听后端事件（parallel_execute_start / sub_agent_event / sub_agent_end / parallel_execute_end）
 * - 将事件路由到对应 batch 的对应 agent，更新其 inner segments
 * - 提供 submit / cancel 方法
 */

import { useState, useCallback, useEffect, useRef } from "react";
import { sessionEventBus } from "@/hooks/useSessionEvents";
import { applyEventToSubAgent } from "../chat/subAgentEvents";
import type { ParallelBatch, ParallelAgent, ParallelState } from "./types";
import type { WsMessage } from "@/hooks/useWebSocket";

/** 并行面板使用的固定 clientId（所有并行事件路由到此） */
export const PARALLEL_CLIENT_ID = "parallel-panel";

/** localStorage key */
const STORAGE_KEY = "axon_parallel_batches";

/** 从 localStorage 恢复历史批次（仅已完成的） */
function loadPersistedBatches(): ParallelBatch[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as ParallelBatch[];
    if (!Array.isArray(parsed)) return [];
    // 运行中的视为中断（reload 后后端已无该执行），inner 保留以便查看执行记录
    return parsed.map((b) => ({
      ...b,
      status: b.status === "running" ? "partial_failed" : b.status,
      agents: b.agents.map((a) => ({
        ...a,
        status: a.status === "running" ? "failed" : a.status,
        innerStreaming: false,
        inner: Array.isArray(a.inner) ? a.inner : [],
      })),
    }));
  } catch {
    return [];
  }
}

/** 裁剪 inner 中的大字段（diff 正文 / 命令输出 / 搜索结果），保留结构与路径供持久化 */
function trimInnerForStorage(inner: ParallelAgent["inner"]): ParallelAgent["inner"] {
  return inner.map((seg) => {
    if (seg.type !== "tool") return seg;
    return {
      ...seg,
      // 保留 diff 的 path/editId（文件清单依赖），清空大文本正文
      diff: seg.diff ? { path: seg.diff.path, oldContent: "", newContent: "", editId: seg.diff.editId } : undefined,
      diffs: seg.diffs?.map((d) => ({ path: d.path, absPath: d.absPath, oldContent: "", newContent: "", editId: d.editId })),
      output: seg.output ? seg.output.slice(0, 300) : undefined,
      searchResults: undefined,
      fetchResult: undefined,
    };
  });
}

/** 持久化批次到 localStorage（只保留最近 20 条，裁剪 inner 大字段） */
function persistBatches(batches: ParallelBatch[]): void {
  try {
    const toSave = batches.slice(0, 20).map((b) => ({
      ...b,
      agents: b.agents.map((a) => ({
        ...a,
        inner: trimInnerForStorage(a.inner),
        innerStreaming: false,
      })),
    }));
    localStorage.setItem(STORAGE_KEY, JSON.stringify(toSave));
  } catch { /* ignore quota exceeded */ }
}

interface UseParallelSessionOptions {
  connected: boolean;
  send: (cmd: Record<string, unknown>) => void;
}

export function useParallelSession({ connected, send }: UseParallelSessionOptions) {
  const [state, setState] = useState<ParallelState>(() => ({
    batches: loadPersistedBatches(),
    activeBatchId: null,
  }));

  // 正在等待后端拆分任务（submit 后到 parallel_execute_start 之间）
  const [thinking, setThinking] = useState(false);
  // thinking 阶段 AI 的中间状态（正在做什么）
  const [thinkingStatus, setThinkingStatus] = useState("");

  // delegateId → batchId 映射（快速查找事件归属哪个批次）
  const delegateMapRef = useRef<Map<string, string>>(new Map());

  // 当前正在运行的批次关联的 sessionId（用于取消）
  const batchSessionRef = useRef<Map<string, string>>(new Map());

  // AI 拒绝并行时的文字回复（现在作为特殊批次记录，不再需要独立状态）
  const streamingText = useRef("");
  // 标记：本轮已经成功触发了 parallel_execute（后续 stream_end 是正常收尾，不是拒绝）
  const parallelTriggered = useRef(false);

  // 批次变化时持久化
  useEffect(() => {
    persistBatches(state.batches);
  }, [state.batches]);

  /** 提交并行执行请求 */
  const submit = useCallback((content: string, model?: string, provider?: string) => {
    if (!connected || !content.trim()) return;
    setThinking(true);
    setThinkingStatus("正在分析需求...");
    streamingText.current = "";
    parallelTriggered.current = false;
    send({
      type: "user_message",
      clientId: PARALLEL_CLIENT_ID,
      content,
      mode: "parallel",
      model: model || undefined,
      provider: provider || undefined,
    });
  }, [connected, send]);

  /** 取消正在运行的批次 */
  const cancelBatch = useCallback((batchId: string) => {
    // 发送取消命令给后端
    send({
      type: "cancel",
      clientId: PARALLEL_CLIENT_ID,
    });
    // 前端立即标记为取消
    setState((prev) => ({
      ...prev,
      batches: prev.batches.map((batch) => {
        if (batch.batchId !== batchId || batch.status !== "running") return batch;
        return {
          ...batch,
          status: "partial_failed" as const,
          agents: batch.agents.map((a) =>
            a.status === "running"
              ? { ...a, status: "failed" as const, conclusion: "已取消", innerStreaming: false }
              : a
          ),
        };
      }),
    }));
    // 清理 delegate 映射
    delegateMapRef.current.forEach((bid, did) => {
      if (bid === batchId) delegateMapRef.current.delete(did);
    });
  }, [send]);

  /** 删除历史批次 */
  const deleteBatch = useCallback((batchId: string) => {
    setState((prev) => ({
      ...prev,
      batches: prev.batches.filter((b) => b.batchId !== batchId),
      activeBatchId: prev.activeBatchId === batchId ? null : prev.activeBatchId,
    }));
  }, []);

  /** 回滚某个并行写入的文件 */
  const undoFile = useCallback((path: string) => {
    send({ type: "undo_parallel_file", path, clientId: PARALLEL_CLIENT_ID });
  }, [send]);

  /** 处理后端事件 */
  const handleEvent = useCallback((msg: WsMessage) => {
    const type = msg.type;

    // 并行执行开始：创建新 batch
    if (type === "parallel_execute_start") {
      setThinking(false);
      streamingText.current = "";
      parallelTriggered.current = true;
      const { batchId, intent, tasks, relayId } = msg as any;
      const agents: ParallelAgent[] = (tasks || []).map((t: any) => ({
        delegateId: t.delegateId,
        intent: t.intent || "",
        fileScope: t.fileScope || [],
        status: "running" as const,
        inner: [],
        innerStreaming: false,
      }));
      // 注册 delegateId → batchId 映射
      agents.forEach((a) => delegateMapRef.current.set(a.delegateId, batchId));

      const batch: ParallelBatch = {
        batchId,
        intent: intent || "",
        createdAt: Date.now(),
        status: "running",
        agents,
        relayId: relayId || undefined,
      };
      setState((prev) => ({
        batches: [batch, ...prev.batches],
        activeBatchId: batchId,
      }));
      return;
    }

    // 记录 session 关联（用于取消路由）
    if (type === "session_created") {
      const sessionId = (msg as any).sessionId;
      if (sessionId) {
        // 找到最近的 running batch 并关联
        setState((prev) => {
          const running = prev.batches.find((b) => b.status === "running");
          if (running) batchSessionRef.current.set(running.batchId, sessionId);
          return prev;
        });
      }
      return;
    }

    // 子 Agent 内部事件：路由到对应 agent 的 inner segments
    if (type === "sub_agent_event") {
      const { delegateId, event } = msg as any;
      const batchId = delegateMapRef.current.get(delegateId);
      if (!batchId) return;

      setState((prev) => ({
        ...prev,
        batches: prev.batches.map((batch) => {
          if (batch.batchId !== batchId) return batch;
          return {
            ...batch,
            agents: batch.agents.map((agent) => {
              if (agent.delegateId !== delegateId) return agent;
              const fakeSubAgent = {
                type: "subagent" as const,
                id: delegateId,
                intent: agent.intent,
                prompt: "",
                status: "running" as const,
                inner: agent.inner,
                innerStreaming: agent.innerStreaming,
              };
              const updated = applyEventToSubAgent(fakeSubAgent, event);
              return {
                ...agent,
                inner: updated.inner,
                innerStreaming: updated.innerStreaming,
              };
            }),
          };
        }),
      }));
      return;
    }

    // 单路 Agent 完成
    if (type === "sub_agent_end") {
      const { delegateId, result } = msg as any;
      const batchId = delegateMapRef.current.get(delegateId);
      if (!batchId) return;

      setState((prev) => ({
        ...prev,
        batches: prev.batches.map((batch) => {
          if (batch.batchId !== batchId) return batch;
          return {
            ...batch,
            agents: batch.agents.map((agent) => {
              if (agent.delegateId !== delegateId) return agent;
              return {
                ...agent,
                status: "done" as const,
                conclusion: result || "",
                innerStreaming: false,
              };
            }),
          };
        }),
      }));
      return;
    }

    // 整个批次完成
    if (type === "parallel_execute_end") {
      const { batchId, results, elapsed, totalTokens } = msg as any;
      setState((prev) => ({
        ...prev,
        batches: prev.batches.map((batch) => {
          if (batch.batchId !== batchId) return batch;
          const updatedAgents = batch.agents.map((agent) => {
            const r = (results || []).find((x: any) => x.delegateId === agent.delegateId);
            if (r && !r.ok && agent.status !== "done") {
              return { ...agent, status: "failed" as const };
            }
            return agent.status === "running" ? { ...agent, status: "done" as const } : agent;
          });
          const hasFailed = updatedAgents.some((a) => a.status === "failed");
          return {
            ...batch,
            status: hasFailed ? "partial_failed" as const : "done" as const,
            agents: updatedAgents,
            elapsed,
            totalTokens,
          };
        }),
      }));
      // 清理映射
      delegateMapRef.current.forEach((bid, did) => {
        if (bid === batchId) delegateMapRef.current.delete(did);
      });
      batchSessionRef.current.delete(batchId);
      return;
    }

    // AI 拒绝并行或出错时（stream_end / error 到达但没有 parallel_execute_start），关闭 thinking
    if (type === "stream_end" || type === "error") {
      setThinking(false);
      // 只有本轮没触发过 parallel_execute 时，才把文字回复作为"拒绝"批次
      // （触发过的话，stream_end 是并行完成后的正常总结，不应创建新 tab）
      if (!parallelTriggered.current && streamingText.current.trim()) {
        const replyBatch: ParallelBatch = {
          batchId: `reply-${Date.now()}`,
          intent: "AI 未使用并行执行",
          createdAt: Date.now(),
          status: "partial_failed",
          agents: [{
            delegateId: `reply-agent-${Date.now()}`,
            intent: "AI 回复",
            fileScope: [],
            status: "done",
            inner: [],
            conclusion: streamingText.current,
          }],
        };
        setState((prev) => ({
          batches: [replyBatch, ...prev.batches],
          activeBatchId: replyBatch.batchId,
        }));
      }
      streamingText.current = "";
      return;
    }

    // 收集 AI 流式文字（可能是拒绝并行的理由说明）
    if (type === "stream_delta") {
      streamingText.current += (msg as any).content || "";
      return;
    }
    if (type === "stream_start") {
      streamingText.current = "";
      return;
    }

    // AI 思考阶段的状态提示（正在读文件/执行命令/搜索等）
    if (type === "status" && thinking) {
      const content = (msg as any).content;
      if (content) setThinkingStatus(content);
      return;
    }

    // AI 思考阶段调用了工具（读文件/列目录/搜索等），更新状态
    if (type === "tool_call" && thinking) {
      const name = (msg as any).name || "";
      const statusMap: Record<string, string> = {
        read_file: "正在读取文件...",
        search: "正在搜索工作区...",
        list_dir: "正在浏览目录...",
        execute_command: "正在执行命令...",
        web_search: "正在搜索网络...",
      };
      setThinkingStatus(statusMap[name] || `正在执行 ${name}...`);
      return;
    }

    // 工具结果（thinking 阶段忽略，不影响状态）
    if (type === "tool_result" && thinking) {
      return;
    }

    // 并行文件回滚结果：成功则把对应文件的 tool segment 标记为已撤销
    if (type === "parallel_file_reverted") {
      const { path, ok } = msg as any;
      if (!ok) return;
      setState((prev) => ({
        ...prev,
        batches: prev.batches.map((batch) => ({
          ...batch,
          agents: batch.agents.map((agent) => ({
            ...agent,
            inner: agent.inner.map((seg) => {
              if (seg.type !== "tool") return seg;
              const matchSingle = seg.diff?.path === path;
              const matchMulti = seg.diffs?.some((d) => d.path === path);
              if (!matchSingle && !matchMulti) return seg;
              return {
                ...seg,
                reverted: matchSingle ? true : seg.reverted,
                revertedPaths: matchMulti
                  ? [...(seg.revertedPaths || []), path]
                  : seg.revertedPaths,
              };
            }),
          })),
        })),
      }));
      return;
    }
  }, []);

  // 监听事件总线
  useEffect(() => {
    const unsubscribe = sessionEventBus.subscribe(PARALLEL_CLIENT_ID, handleEvent);
    return unsubscribe;
  }, [handleEvent]);

  // 监听跨 webview 导航（从 Relay Tab 跳转过来，定位指定 batchId）
  useEffect(() => {
    const handler = (msg: WsMessage) => {
      if (msg.type !== "navigate_parallel") return;
      const targetBatchId = (msg as any).batchId as string | null;
      const targetRelayId = (msg as any).relayId as string | null;
      if (targetBatchId) {
        // 精确定位 batchId
        setState((prev) => ({ ...prev, activeBatchId: targetBatchId }));
      } else if (targetRelayId) {
        // 按 relayId 找到关联的批次
        setState((prev) => {
          const found = prev.batches.find((b) => b.relayId === targetRelayId);
          return found ? { ...prev, activeBatchId: found.batchId } : prev;
        });
      }
    };
    // 监听全局广播（无 clientId 的事件会广播给所有面板）
    const unsubGlobal = sessionEventBus.subscribe("__global_navigate__", handler);
    // 也直接监听 window message（兜底：App.tsx dispatch 的可能没到 bus）
    const windowHandler = (e: MessageEvent) => {
      if (e.data?.type === "navigate_parallel") handler(e.data);
    };
    window.addEventListener("message", windowHandler);
    return () => { unsubGlobal(); window.removeEventListener("message", windowHandler); };
  }, []);

  /** 切换查看的 batch */
  const setActiveBatch = useCallback((batchId: string | null) => {
    setState((prev) => ({ ...prev, activeBatchId: batchId }));
  }, []);

  return {
    state,
    thinking,
    thinkingStatus,
    submit,
    cancelBatch,
    deleteBatch,
    undoFile,
    setActiveBatch,
    connected,
  };
}

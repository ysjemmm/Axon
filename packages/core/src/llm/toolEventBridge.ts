/**
 * ToolEventBridge —— 把统一 ToolEvent 翻译成现网前端事件载荷（方案 B：事件桥，纯逻辑可测试）
 *
 * 背景：
 * - 新架构的工具轮由 DefaultToolDispatchHandler 驱动，产出统一的 ToolEvent（planned/executing/
 *   completed/failed/cancelled）。但前端只认现网的 tool_call / tool_result 两类事件载荷。
 * - 要让 orchestrator 的产物直接驱动前端（而不是回调老 executeSingleToolCall 发事件），
 *   必须有一层把 ToolEvent → 前端事件载荷 的翻译。本组件就是这座桥。
 *
 * 设计要点（关键安全约束）：
 * - 纯函数：只做「事件形状翻译」，不 send 前端、不写消息历史、不执行任何副作用。
 *   真正 send 由调用方（agentSession）负责，本层只产出「该发什么」的结构化描述。
 * - 休眠不接生产：现网 canary 的前端事件仍由 executeSingleToolCall 发出；本桥当前仅供
 *   单测与后续「执行核改为纯执行」的合并步骤使用。二者不可同时驱动前端，否则卡片双发。
 * - 与现网字段对齐：ToolCallStatus 的字符串值（pending/executing/success/error/cancelled）
 *   与 tools/catalog.ts 的 enum 完全一致，避免前端镜像常量对不上。
 */

import type { ToolEvent } from "./toolEventModel.js";

/** 前端事件的两种类型（与现网 send 的事件名一致）。 */
export type FrontendToolEventType = "tool_call" | "tool_result";

/** 现网 ToolCallStatus 的字符串值（与 tools/catalog.ts enum 对齐，前端镜像常量依赖它）。 */
export type FrontendToolStatus = "pending" | "executing" | "success" | "error" | "cancelled";

/**
 * 一条翻译后的前端事件描述：type + 载荷。
 *
 * 说明：
 * - 调用方按 type 走 this.send(type, payload)；payload 字段与现网 tool_call/tool_result 对齐。
 * - 本描述不含 cwd / mcpMeta / fileDiff 等「执行期才知道」的运行时补充字段——
 *   那些由调用方在 send 时按需合并，本纯层不臆造。
 */
export interface FrontendToolEvent {
  type: FrontendToolEventType;
  payload: {
    id: string;
    name: string;
    args?: Record<string, unknown>;
    status: FrontendToolStatus;
    /** tool_result 专用：给前端展示的结果文本（已由调用方截断）。 */
    result?: string;
    /** tool_result 专用：给用户看的简短文案（区别于给 AI 的完整 result）。 */
    userMessage?: string;
  };
}

/** 工具阶段 → 前端状态的映射。 */
function phaseToStatus(event: ToolEvent): FrontendToolStatus {
  switch (event.phase) {
    case "planned":
      // planned 阶段若挂了门控则仍是 pending（等待确认）；否则也是 pending（准备执行）。
      return "pending";
    case "executing":
      return "executing";
    case "completed":
      return "success";
    case "failed":
      return "error";
    case "cancelled":
      // 被门控拦截（blocked）在产品语义上按 error 展示（给用户明确的未执行原因）；
      // 普通取消（用户中止）按 cancelled 展示。
      return event.gateState === "blocked" ? "error" : "cancelled";
  }
}

/**
 * 把单条 ToolEvent 翻译成 0 或 1 条前端事件描述。
 *
 * 映射规则：
 * - planned   → tool_call(pending)：卡片出现，等待/准备执行。
 * - executing → tool_call(executing)：参数就绪，开始执行。
 * - completed → tool_result(success)：成功终态，带结果文本。
 * - failed    → tool_result(error)：失败终态，带错误文本。
 * - cancelled → tool_result(error|cancelled)：拦截按 error、普通取消按 cancelled。
 *
 * 返回 null 表示该事件不需要驱动前端（预留给未来「suppressed / debug_only」可见性语义）。
 */
export function toolEventToFrontend(event: ToolEvent): FrontendToolEvent | null {
  // 可见性为 suppressed / debug_only 的事件不驱动普通前端 UI。
  if (event.visibility === "suppressed" || event.visibility === "debug_only") return null;

  const status = phaseToStatus(event);
  const isResult = event.phase === "completed" || event.phase === "failed" || event.phase === "cancelled";

  if (isResult) {
    return {
      type: "tool_result",
      payload: {
        id: event.callId,
        name: event.toolName,
        args: event.parsedArgs,
        status,
        result: event.aiPayload?.ok ? event.aiPayload?.result : event.aiPayload?.error,
      },
    };
  }

  // planned / executing → tool_call
  return {
    type: "tool_call",
    payload: {
      id: event.callId,
      name: event.toolName,
      args: event.phase === "executing" ? event.parsedArgs : undefined,
      status,
    },
  };
}

/**
 * 把一串 ToolEvent 批量翻译成前端事件序列（过滤掉不驱动 UI 的事件）。
 *
 * 用途：DefaultToolDispatchHandler 产出的 runtimeEvents 里筛出 tool.phase 事件后，
 * 一次性翻译成有序的前端事件流，供调用方按序 send。
 */
export function toolEventsToFrontend(events: ToolEvent[]): FrontendToolEvent[] {
  const out: FrontendToolEvent[] = [];
  for (const e of events) {
    const fe = toolEventToFrontend(e);
    if (fe) out.push(fe);
  }
  return out;
}

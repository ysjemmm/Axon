/**
 * CommandGateToolDecider —— 把现网命令信任门翻译成 pipeline 的 ToolGateDecider（方案 B：命令门下沉）
 *
 * 背景：
 * - 现网 execute_command / start_process 的三档授权（灾难硬拦 → 白名单 → 未信任弹审批）
 *   由 agentSession 内的 gateCommand(command, toolCallId) 承担，返回 GateOutcome。
 * - 方案 B 要把「execute 之前的门控决策」下沉进 DefaultToolDispatchHandler，由注入的
 *   ToolGateDecider 统一决策。本组件就是「命令门」这一具体决策器：把 GateOutcome 翻译成
 *   ToolGateDecision，让 handler 无需感知命令门内部细节。
 *
 * 设计要点（关键安全约束）：
 * - 只对命令类工具（execute_command / start_process）做门控；其余工具一律放行（action=allow）。
 * - 纯翻译：本组件不弹 UI、不改状态，真正的三档授权交互仍在注入的 gateFn（即 gateCommand）内部完成。
 * - 字段映射与现网 dispatchToolCall 的命令分支严格对齐：
 *   · GateOutcome.allow=false → block，aiMessage 作为给 AI 的 reason，userMessage 透传。
 *   · GateOutcome.editedCommand → allow + editedArgs（把 command 换成用户编辑后的版本）。
 *   · GateOutcome.allow=true 且无 editedCommand → 直接放行，参数不变。
 * - 休眠不接生产：本决策器当前仅供单测与后续 3.5 合并接线使用；现网 canary 的命令门仍在
 *   executeSingleToolCall 内部走 gateCommand，二者不可同时生效，否则命令门会弹两次。
 */

import type { ToolGateDecider, ToolGateRequest, ToolGateDecision } from "./toolGateDecider.js";

/** 命令门返回结构（与 tools/commandGate.ts 的 GateOutcome 对齐，此处只依赖用到的字段）。 */
export interface CommandGateOutcome {
  allow: boolean;
  /** 不放行时给 AI 的清晰、可恢复错误文案。 */
  aiMessage?: string;
  /** 给用户看的简短文案。 */
  userMessage?: string;
  /** 用户编辑后的替代命令（有值时用它执行）。 */
  editedCommand?: string;
}

/** 命令门决策函数（即 agentSession.gateCommand 的形状）。 */
export type CommandGateFn = (command: string, toolCallId?: string) => Promise<CommandGateOutcome>;

/** 需要经过命令信任门的工具名集合。 */
const COMMAND_TOOLS: ReadonlySet<string> = new Set(["execute_command", "start_process"]);

/**
 * 命令门决策器：仅对命令类工具调用注入的 gateFn 做三档授权，其余工具放行。
 *
 * 用法：new CommandGateToolDecider((cmd, id) => this.gateCommand(cmd, id))，注入 DefaultToolDispatchHandler。
 */
export class CommandGateToolDecider implements ToolGateDecider {
  constructor(private readonly gateFn: CommandGateFn) {}

  async decide(req: ToolGateRequest): Promise<ToolGateDecision> {
    // 非命令类工具：不经命令门，直接放行。
    if (!COMMAND_TOOLS.has(req.toolName)) {
      return { action: "allow" };
    }

    // 取出命令文本（缺失时按空串交给门控，由门控内部决定如何处理）。
    const command = String((req.parsedArgs as { command?: unknown } | undefined)?.command ?? "");
    const outcome = await this.gateFn(command, req.callId);

    // 不放行：翻译成 block，把给 AI 的文案与给用户的文案分别透传。
    if (!outcome.allow) {
      return {
        action: "block",
        reason: outcome.aiMessage || "命令未执行。",
        userMessage: outcome.userMessage,
      };
    }

    // 放行且用户编辑过命令：用编辑后的命令替换 command 参数执行（保留其余参数不变）。
    if (outcome.editedCommand) {
      return {
        action: "allow",
        editedArgs: { ...(req.parsedArgs ?? {}), command: outcome.editedCommand },
      };
    }

    // 放行且未编辑：参数原样执行。
    return { action: "allow" };
  }
}

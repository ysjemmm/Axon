/**
 * CommandGateController —— 命令信任门（从 AgentSession 解耦，状态自持）
 *
 * 把 execute_command 的"灾难硬拦 + 白名单 + 人工授权（含危险确认）"收敛到一处：
 * 主循环与子 Agent 共用同一个 gate，保证三层语义一致、批准结果父子共享。
 *
 * 与其它协作者不同，本控制器【自持全部相关状态】（CommandGate 实例、审批 resolver 表、
 * 自增序号、信任规则持久化回调）——这些状态原本只被本组方法使用，搬迁后是真正的状态内聚，
 * 不依赖 session 的 @internal 字段；仅通过 session.send 向前端发审批/拦截事件。
 */

import { CommandGate, type ApprovalDecision, type TrustRule, type GateOutcome } from "../tools/index.js";
import type { AgentSession } from "../agentSession.js";

export class CommandGateController {
  // 审批门：按 requestId 多路挂起 resolver。并发安全——parallel_research / 多个子 Agent
  // 可能同时请求授权，各自的等待用独立 requestId 路由，互不覆盖。
  private readonly commandApprovalResolvers = new Map<string, (d: ApprovalDecision) => void>();
  // 审批请求自增序号，与时间戳一起保证 requestId 在并发下唯一
  private approvalSeq = 0;
  // 新批准信任规则的持久化回调（host 注入：写 VS Code 设置 / JSON 存储）
  private onApproved?: (rule: TrustRule, target?: "user" | "workspace") => void;

  constructor(
    private readonly s: AgentSession,
    /** 共享的全局命令信任 trie（sessionHub 持有，所有会话共用一份） */
    private readonly commandGate: CommandGate,
  ) {}

  /** 注入持久化的命令信任白名单（host 从 VS Code 设置/JSON 存储读出后调用） */
  setTrustedPatterns(patterns: string[]): void {
    this.commandGate.setTrustedPatterns(patterns);
  }

  /** 注册"新批准规则"持久化回调（host 据此写回设置/存储） */
  setOnApproved(cb: (rule: TrustRule, target?: "user" | "workspace") => void): void {
    this.onApproved = cb;
  }

  /** 当前命令信任白名单（供管理面板展示） */
  listRules(): TrustRule[] {
    return this.commandGate.listRules();
  }

  /** 外部 resolve 命令审批门（由 SessionHub.dispatch confirm_command 调用） */
  resolveApproval(requestId: string, decision: ApprovalDecision): void {
    const resolve = this.commandApprovalResolvers.get(requestId);
    if (resolve) {
      this.commandApprovalResolvers.delete(requestId);
      resolve(decision);
    }
  }

  /**
   * 命令信任门（共享）：主循环与子 Agent 的 execute_command 都走这一个 gate，
   * 保证白名单、灾难硬拦、人工授权三层语义一致，且批准结果在父子间共享。
   * @param toolCallId 触发该命令的工具调用 id，透传给前端做内联审批定位
   */
  gate(command: string, toolCallId?: string): Promise<GateOutcome> {
    return this.commandGate.gate(command, {
      requestApproval: (cmd, options, danger) => this.requestCommandApproval(cmd, options, toolCallId, danger),
      requestDangerousApproval: (cmd, reason) => this.requestDangerousCommandApproval(cmd, reason),
      emitBlocked: (cmd, reason) => this.s.send("command_blocked", { command: cmd, reason }),
      persist: (rule, target) => this.onApproved?.(rule, target),
    });
  }

  /** 弹出命令审批请求并阻塞，等待用户三档决策（exact/prefix/all/once/reject） */
  private requestCommandApproval(
    command: string,
    options: { choice: "exact" | "prefix" | "all"; pattern: string; label: string }[],
    toolCallId?: string,
    danger?: string,
  ): Promise<ApprovalDecision> {
    const requestId = `cmd_${Date.now()}_${this.approvalSeq++}`;
    // 带上 toolCallId：前端据此把审批按钮内联到对应的命令卡片上（无感模式），而非弹独立模态框
    // danger 非空时前端卡片闪烁红色警示
    this.s.send("confirm_command_request", { requestId, command, options, id: toolCallId, danger });
    return new Promise<ApprovalDecision>((resolve) => {
      this.commandApprovalResolvers.set(requestId, resolve);
    });
  }

  /**
   * 危险命令确认弹窗：发送 command_blocked（带 requestId），等待用户点"拒绝"或"仍要执行"。
   * 返回 true=仍要执行，false=拒绝。
   */
  private requestDangerousCommandApproval(command: string, reason: string): Promise<boolean> {
    const requestId = `danger_${Date.now()}_${this.approvalSeq++}`;
    this.s.send("command_blocked", { requestId, command, reason, dangerous: true });
    return new Promise<boolean>((resolve) => {
      this.commandApprovalResolvers.set(requestId, (decision) => {
        resolve(decision.choice === "once"); // "once" = 仍要执行，"reject" = 拒绝
      });
    });
  }
}

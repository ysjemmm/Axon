/**
 * DelegateRunner —— delegate_task 子 Agent 委托执行（从 AgentSession 解耦）
 *
 * 职责单一：加载 skill（可选）→ 启动隔离子 Agent → 实时转发其事件 → 累加 token → 回填结论。
 * 子 Agent 在隔离上下文运行（看不到主对话），事件用 sub_agent_event 包装（带 delegateId）转发前端。
 *
 * 通过构造注入的 session 引用访问运行时状态与能力（@internal）：会话标识/工作区/host/中止信号/
 * skill 注册表/命令信任门 gateCommand/子 Agent token 累加等。
 */

import { getStrategy, getClient } from "../providers.js";
import { deriveSubAgentHost } from "../host/index.js";
import { SubAgentRunner, type SubAgentResult } from "../skills/subAgentRunner.js";
import type { LoadedSkill } from "../skills/skillLoader.js";
import type { AgentSession } from "../agentSession.js";

export class DelegateRunner {
  constructor(private readonly s: AgentSession) {}

  /**
   * 执行 delegate_task：加载 skill（若指定）→ 启动隔离子 agent → 实时转发事件 → 返回最终结论。
   * 子 agent 的所有中间事件用 sub_agent_event 包装（带 delegateId），前端路由进对应折叠卡片。
   */
  async run(args: Record<string, unknown>, toolCallId: string): Promise<string> {
    const prompt = typeof args.prompt === "string" ? args.prompt : "";
    const intent = typeof args.intent === "string" ? args.intent : "";
    const skillName = typeof args.skill === "string" ? args.skill.trim() : "";
    if (!prompt.trim()) {
      throw new Error("delegate_task 需要非空的 prompt");
    }

    // 为本次委托生成唯一 id，关联前端折叠卡片与内部事件流
    const delegateId = `delegate-${Date.now()}-${++this.s.delegateSeq}`;

    // 加载 skill（可选）
    let skill: LoadedSkill | null = null;
    if (skillName) {
      skill = await this.s.skillRegistry.load(skillName);
      if (!skill) {
        console.warn(`[skill] 未找到 skill "${skillName}"，子 Agent 将以通用任务模式执行`);
      }
    }

    // 通知前端：委托开始（携带 delegateId、skill、prompt，供卡片展开展示）
    this.s.send("sub_agent_start", {
      delegateId,
      toolCallId,
      intent,
      skill: skill?.name || skillName || null,
      prompt,
    });

    // 子 agent 事件回调：包装成 sub_agent_event 转发给前端
    const emit = (type: string, data: Record<string, unknown>): void => {
      this.s.send("sub_agent_event", { delegateId, event: { type, ...data } });
    };

    const runner = new SubAgentRunner({
      strategy: getStrategy(this.s.provider, this.s.model),
      model: this.s.model,
      cwd: this.s.cwd,
      workspaces: this.s.workspaces,
      host: deriveSubAgentHost(this.s.host),
      signal: this.s.abortSignal,
      emit,
      skillLoader: this.s.loadSkillForTool,
      web: this.s.web,
      // 子 Agent 也共享父会话的 LLM client，用于卡住时的"摘要重启"
      client: getClient(this.s.provider, this.s.model),
      // 子 Agent 的 execute_command 复用父会话的信任门：灾难硬拦 + 白名单 + 冒泡到用户审批
      gateCommand: (command, toolCallId) => this.s.gateCommand(command, toolCallId),
    });

    let result: SubAgentResult;
    try {
      result = await runner.run(prompt, skill);
    } catch (err) {
      // 子 agent 被取消/抛错：累加它中断前已消耗的 token（不漏算），再通知前端结束
      this.s.addSubAgentTokens(runner.getTokensUsed());
      const aborted = `（子 Agent 已${this.s.isCancelled ? "取消" : "中断"}）`;
      this.s.send("sub_agent_end", { delegateId, result: aborted });
      throw err; // 继续上抛，由主循环的取消检查处理
    }

    // 通知前端：委托结束（携带最终文本）
    this.s.send("sub_agent_end", { delegateId, result: result.text });
    // 子 Agent 消耗的 token 累加到本会话总量
    this.s.addSubAgentTokens(result.tokens);

    const skillNote = skill ? `（已使用 skill：${skill.name}）` : "";

    // 成功与失败区别回填，避免主 agent 把失败结论当权威结果、被错误框架带偏
    if (result.ok) {
      // 成功：这是可信结论，要求主 agent 完整呈现
      return (
        `子 Agent 已完成任务${skillNote}。以下是子 Agent 的完整结论，请直接呈现给用户` +
        `（可适当排版，但不要丢失内容，不要只写一句"已完成"）：\n\n${result.text}`
      );
    }
    // 失败：明确标注这不是结论，要求主 agent 抛开子 agent 的猜测、用自己的上下文重新独立完成
    return (
      `子 Agent 未能完成本次委托${skillNote}，下面是它的尝试过程与失败说明（仅供参考，不是可信结论）：\n\n` +
      `${result.text}\n\n` +
      `⚠️ 重要：不要把上面的内容当作答案呈现给用户，也不要沿用其中的猜测、假设或文件路径。` +
      `请基于你自己已有的上下文，从头独立完成这个任务（亲自用 read_file/search 等工具核实），` +
      `不要被子 Agent 的失败框架带偏。`
    );
  }
}

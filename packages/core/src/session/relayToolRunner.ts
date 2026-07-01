/**
 * RelayToolRunner —— Relay 长任务工作流的工具执行（从 AgentSession 解耦）
 *
 * 职责单一：承载 relay_create / relay_save_doc / relay_advance / relay_update_task / relay_review_task
 * 五个工具的执行逻辑——创建工作流、写阶段文档、确认门推进、任务状态机回写、两阶段只读评审。
 * 含两道硬门：确认门（一条用户消息最多推进一个阶段）、评审门（未通过评审不得标记完成）。
 *
 * 通过构造注入的 session 引用访问 relayStore / 活动任务上下文 / 本轮推进标记 / 子 Agent 能力（@internal）。
 */

import { getStrategy } from "../providers.js";
import { deriveSubAgentHost } from "../host/index.js";
import type { RelayPhase, RelayQualityConfig } from "../relay/types.js";
import { nextPhase, PHASE_DOC_FILE } from "../relay/types.js";
import { runTwoStageReview, buildReviewFeedback, type ReviewContext } from "../relay/reviewAgent.js";
import type { AgentSession } from "../agentSession.js";

export class RelayToolRunner {
  constructor(private readonly s: AgentSession) {}

  /** 执行 relay_create：创建一个新的 Relay 长任务工作流，通知前端打开/刷新面板。 */
  async create(args: Record<string, unknown>): Promise<string> {
    const title = typeof args.title === "string" ? args.title.trim() : "";
    const summary = typeof args.summary === "string" ? args.summary.trim() : "";
    if (!title) throw new Error("relay_create 需要非空的 title");
    const quality: RelayQualityConfig = {
      tdd: args.tdd === true,
      review: args.review !== false, // 默认开启评审
    };
    const relay = await this.s.relayStore.create({ title, summary, sessionId: this.s.currentRelaySessionId, quality });
    this.s.send("relay_updated", { relay });
    const qualityNote = `质量门：评审${quality.review ? "开启" : "关闭"}，TDD ${quality.tdd ? "强制" : "不强制"}。`;
    return (
      `已创建 Relay 长任务工作流「${relay.title}」（id: ${relay.id}），当前处于需求澄清（brainstorm）阶段。${qualityNote}\n` +
      `接下来请与用户澄清需求要点（目标、范围、验收标准），然后用 relay_save_doc(phase="brainstorm") 写入需求文档，` +
      `分段呈现给用户确认。不要跳过澄清直接写文档。`
    );
  }

  /** 执行 relay_save_doc：写入某阶段文档，通知前端刷新。 */
  async saveDoc(args: Record<string, unknown>): Promise<string> {
    const id = typeof args.id === "string" ? args.id : "";
    const phase = args.phase as RelayPhase;
    const content = typeof args.content === "string" ? args.content : "";
    if (!id) throw new Error("relay_save_doc 需要 id");
    if (!PHASE_DOC_FILE[phase]) throw new Error(`relay_save_doc 的 phase 非法：${String(args.phase)}`);
    if (!content.trim()) throw new Error("relay_save_doc 需要非空的 content");
    const relay = await this.s.relayStore.saveDoc(id, phase, content);
    if (!relay) throw new Error(`未找到 relay：${id}`);
    this.s.send("relay_updated", { relay });
    const fileName = PHASE_DOC_FILE[phase];
    const taskNote = phase === "plan" ? `已解析出 ${relay.tasks.length} 个任务。` : "";
    return (
      `已写入 ${fileName}。${taskNote}\n` +
      `现在请把这份${phase === "brainstorm" ? "需求" : phase === "design" ? "设计" : "计划"}的要点分段、简洁地呈现给用户，` +
      `请用户确认。用户认可后再调用 relay_advance(phase="${phase}") 推进到下一阶段。不要自己直接推进。`
    );
  }

  /** 执行 relay_advance：用户确认后推进阶段（确认门）。 */
  async advance(args: Record<string, unknown>): Promise<string> {
    const id = typeof args.id === "string" ? args.id : "";
    const phase = args.phase as RelayPhase;
    if (!id) throw new Error("relay_advance 需要 id");

    // 硬门：推进前校验当前阶段的产出文档确实已写入（防止跳过阶段、未出文档就推进）
    const cur = await this.s.relayStore.get(id);
    if (!cur) throw new Error(`未找到 relay：${id}`);
    const docMap: Partial<Record<RelayPhase, string>> = {
      brainstorm: cur.requirements,
      design: cur.design,
      plan: cur.plan,
    };
    if (phase in docMap && !(docMap[phase] || "").trim()) {
      throw new Error(
        `当前阶段 ${phase} 的文档还没写，不能推进。请先用 relay_save_doc(phase="${phase}") 写好文档、` +
        `呈现给用户并获得明确确认后，再推进。`,
      );
    }

    // 确认门铁律（硬门）：一条用户消息最多推进一个文档阶段。若本轮已经推进过，拒绝再次推进——
    // 强制模型把文档呈现给用户、等用户【下一条消息】明确确认后才能继续。这从根上杜绝
    // "一次确认被模型连跨需求→设计→计划多个阶段"。
    if (this.s.relayAdvancedThisTurn) {
      throw new Error(
        `本轮已经推进过一个阶段了。Relay 确认门要求：每个阶段的产出必须分别经过用户确认。` +
        `请先把当前阶段的文档要点呈现给用户，停下来等用户在【下一条消息】里明确认可后，再推进下一阶段。` +
        `不要在同一回合里连续跨多个阶段。`,
      );
    }
    this.s.relayAdvancedThisTurn = true;

    const to = nextPhase(phase);
    const relay = await this.s.relayStore.advancePhase(id, phase, to);
    if (!relay) throw new Error(`未找到 relay：${id}`);
    this.s.send("relay_updated", { relay });
    if (to === "executing") {
      // 找出无依赖（或 deps 全部已完成）的 pending 任务
      const completedIds = new Set(relay.tasks.filter((t) => t.status === "completed").map((t) => t.id));
      const readyTasks = relay.tasks.filter((t) =>
        t.status === "pending" && (!t.deps || t.deps.length === 0 || t.deps.every((d) => completedIds.has(d)))
      );
      const parallelHint = readyTasks.length >= 2
        ? `\n\n【并行加速】当前有 ${readyTasks.length} 个无依赖的就绪任务（${readyTasks.map((t) => t.id).join(", ")}），` +
          `它们互不依赖，优先使用 parallel_execute 并行派发执行以提升效率。` +
          `每个子任务的 prompt 需自包含（背景+目标+验收标准+涉及文件），fileScope 从任务详情中提取。`
        : "";
      return (
        `阶段已推进到执行（executing）。计划共 ${relay.tasks.length} 个任务。\n` +
        `请开始执行：每个任务开始前用 relay_update_task 设为 in_progress，完成并验证后设为 completed。` +
        parallelHint
      );
    }
    if (to === "done") {
      return `Relay「${relay.title}」已全部完成。`;
    }
    return `阶段已推进到 ${to}。请产出该阶段的文档（relay_save_doc），再次分段呈现给用户确认。`;
  }

  /** 执行 relay_update_task：更新任务状态并回写 plan.md 复选框。 */
  async updateTask(args: Record<string, unknown>): Promise<string> {
    const id = typeof args.id === "string" ? args.id : "";
    const taskId = typeof args.taskId === "string" ? args.taskId : "";
    const status = args.status as "pending" | "in_progress" | "completed";
    if (!id || !taskId) throw new Error("relay_update_task 需要 id 和 taskId");

    // 开始执行某任务：建立活动任务上下文，开始记录该任务改动的文件（供评审定位）
    if (status === "in_progress") {
      this.s.activeRelayTask = { relayId: id, taskId, changedFiles: new Set() };
    }

    // 标记完成时：若启用了评审且该任务还没评审通过，【拒绝】标记完成（硬门，不再是软提醒）
    if (status === "completed") {
      const cur = await this.s.relayStore.get(id);
      const task = cur?.tasks.find((t) => t.id === taskId);
      const reviewEnabled = cur?.quality?.review !== false;
      // 仅对叶子任务做评审门：父任务（有子任务）不作为执行/评审单元，完成与否由子任务决定
      const isParent = !!cur?.tasks.some((t) => t.id !== taskId && t.id.startsWith(taskId + "."));
      if (reviewEnabled && !isParent && task && task.reviewStatus !== "passed") {
        throw new Error(
          `任务 ${taskId} 尚未通过两阶段评审，不能标记完成。请先调用 relay_review_task(id="${id}", taskId="${taskId}") 评审，` +
          `通过后再标记 completed；若评审打回，按反馈修复后重审。`,
        );
      }
    }

    const relay = await this.s.relayStore.setTaskStatus(id, taskId, status);
    if (!relay) throw new Error(`未找到 relay：${id}`);
    if (status === "completed" && this.s.activeRelayTask?.taskId === taskId) {
      this.s.activeRelayTask = null;
    }

    this.s.send("relay_updated", { relay });
    const done = relay.tasks.filter((t) => t.status === "completed").length;
    if (relay.phase === "done") {
      return `任务 ${taskId} 已标记 ${status}。所有任务完成，Relay「${relay.title}」进入 done。`;
    }
    return `任务 ${taskId} 已标记 ${status}（进度 ${done}/${relay.tasks.length}）。继续下一个任务。`;
  }

  /**
   * 执行 relay_review_task：对指定任务跑两阶段只读评审，结果落盘并回填给主 Agent。
   * 评审子 Agent 的事件用 sub_agent_event 包装（带独立 reviewId），前端各自渲染卡片。
   */
  async reviewTask(args: Record<string, unknown>): Promise<string> {
    const id = typeof args.id === "string" ? args.id : "";
    const taskId = typeof args.taskId === "string" ? args.taskId : "";
    if (!id || !taskId) throw new Error("relay_review_task 需要 id 和 taskId");

    const relay = await this.s.relayStore.get(id);
    if (!relay) throw new Error(`未找到 relay：${id}`);
    if (relay.quality?.review === false) {
      return `该 Relay 未启用评审（review=false），无需评审。可直接 relay_update_task 标记完成。`;
    }
    const task = relay.tasks.find((t) => t.id === taskId);
    if (!task) throw new Error(`未找到任务：${taskId}`);

    // 标记评审中
    await this.s.relayStore.setTaskReview(id, taskId, "reviewing");
    this.s.send("relay_updated", { relay: await this.s.relayStore.get(id) });

    // 收集该任务改动过的文件（活动任务上下文里记录的）
    const changedFiles = this.s.activeRelayTask?.relayId === id && this.s.activeRelayTask.taskId === taskId
      ? [...this.s.activeRelayTask.changedFiles]
      : [];

    const ctx: ReviewContext = {
      relayTitle: relay.title,
      taskId,
      taskTitle: task.title,
      taskDetails: task.details,
      requirements: relay.requirements,
      design: relay.design,
      changedFiles,
    };

    const emitFor = (reviewId: string) => {
      return (type: string, data: Record<string, unknown>) =>
        this.s.send("sub_agent_event", { delegateId: reviewId, event: { type, ...data } });
    };

    // 通知前端：评审开始
    const reviewBatchId = `review-${id}-${taskId}-${Date.now()}`;
    this.s.send("relay_review_start", { batchId: reviewBatchId, relayId: id, taskId });

    const { tokens: reviewTokens, ...review } = await runTwoStageReview(ctx, {
      strategy: getStrategy(this.s.provider, this.s.model),
      model: this.s.model,
      cwd: this.s.cwd,
      workspaces: this.s.workspaces,
      host: deriveSubAgentHost(this.s.host),
      signal: this.s.abortSignal,
      skillLoader: this.s.loadSkillForTool,
      web: this.s.web,
      emitFor,
    });
    // 评审子 Agent 消耗的 token 累加到会话总量
    this.s.addSubAgentTokens(reviewTokens);

    const reviewStatus = review.passed ? "passed" : "changes_requested";
    await this.s.relayStore.setTaskReview(id, taskId, reviewStatus, review);
    this.s.send("relay_updated", { relay: await this.s.relayStore.get(id) });
    this.s.send("relay_review_end", { batchId: reviewBatchId, relayId: id, taskId, passed: review.passed });

    if (review.passed) {
      return (
        `✅ 任务 ${taskId} 两阶段评审通过（规格符合性 + 代码质量）。\n` +
        `现在可以用 relay_update_task(status="completed") 把它标记完成，继续下一个任务。`
      );
    }
    const feedback = buildReviewFeedback(review);
    return (
      `❌ 任务 ${taskId} 评审未通过，需要修复后重审。评审反馈如下：\n\n${feedback}\n\n` +
      `请逐条修复上述问题（尤其 critical），改完后再次调用 relay_review_task 重审。不要带病推进。`
    );
  }
}

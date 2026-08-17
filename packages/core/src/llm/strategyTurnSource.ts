/**
 * StrategyTurnSource —— 把现网 LLMStrategy 适配成新 pipeline 的 LLMTurnSource（接现网桥接）
 *
 * 背景：
 * - 新 pipeline 的 LLMHandler 依赖 LLMTurnSource 抽象跑一次回合、拿结构化原始产物。
 * - 现网协议执行仍由 LLMStrategy（ChatCompletions / Responses）承担。
 * - 本适配器把两者对接：内部调用 strategy.runTurn，在流式回调里收集 reasoning 增量，
 *   把返回的 LLMTurnResult 归一化成 LLMTurnRawResult。
 *
 * 设计要点：
 * - 不改动 strategy 本身，只做“结果形状适配”，属于可零风险预制的桥接件。
 * - reasoning 增量通过 onReasoningDelta 回调按到达顺序收集，保留 partIndex / itemId 分段信息。
 * - 工具调用用 resolveToolKind 映射到 toolKind，parsedArgs 尽力 JSON.parse，失败则保留 rawArgsText。
 * - finishReason 直接采用 strategy 已填充的 normalizedFinishReason（产品语义唯一入口）。
 */

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { LLMStrategy, ToolDef } from "./types.js";
import type { LLMTurnSource, LLMTurnRawResult, LLMToolCallDraft } from "./llmTurnSource.js";
import type { ReasoningDeltaInput } from "./reasoningAssembler.js";
import { resolveToolKind } from "./toolKindResolver.js";

/** 适配器构造参数：一次会话内相对稳定的执行配置。 */
export interface StrategyTurnSourceOptions {
  strategy: LLMStrategy;
  model: string;
  /** 本轮可用工具定义；为空数组表示不提供工具（如强制总结收尾）。 */
  tools: ToolDef[];
  /** 采样温度（可选）。 */
  temperature?: number;
  /** 中断信号（可选）。 */
  signal?: AbortSignal;
  /** 是否请求模型思考（用户开关）。省略视为 true，见 RunTurnParams.think。 */
  think?: boolean;
  /** 模型声明的思考能力（provider 目录 / providers.json）。省略时策略回退启发式判定。 */
  modelSupportsThinking?: boolean;
  /** 模型声明的 cache_control 能力。省略时策略回退启发式判定。 */
  modelSupportsCacheControl?: boolean;
  /** 模型声明的 vision（多模态）能力。省略时策略回退启发式判定；显式 false 时剥离图片。 */
  modelSupportsVision?: boolean;
  /**
   * 可选：reasoning 流式回调。提供时在生成过程中按到达顺序实时回调（用于 canary 真正驱动 UI）；
   * 不提供时（如 shadow 只读对比）完全静默，保持零副作用——这是 shadow 只读保证的关键。
   */
  onReasoningDelta?: (text: string, partIndex?: number, itemId?: string) => void;
  /** 可选：正文流式回调。语义同上：提供才回调，用于 canary 边生成边推前端；shadow 不传即静默。 */
  onTextDelta?: (text: string) => void;
  /**
   * 可选：首次检测到工具调用（工具名已确定、参数还在流式累加）时回调。语义同上：提供才回调。
   *
   * 这是"卡片能多早出现"的唯一信号源。工具参数体（create_file 的 content、str_replace 的
   * new_str）往往就是模型输出的主体，几百到几千 token；等 run() 返回再发卡片，用户要盯着
   * 空白等好几秒。子 Agent 一直是对的（skills/subAgentRunner.ts 在此回调里直接发 pending 卡），
   * 主会话在迁移到本适配器时漏了透传，才退化成"流完才出卡"。
   */
  onToolCallDetected?: (name: string, id?: string) => void;
}

/** 把工具调用的原始 JSON 参数尽力解析为对象；失败返回 undefined（保留 rawArgsText 供排查）。 */
function tryParseArgs(raw: string): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 基于现网 LLMStrategy 的 LLMTurnSource 实现。
 *
 * 说明：
 * - 每次 run 独立收集本回合的 reasoning 增量，互不串扰。
 * - 只做形状适配，不引入任何新的业务判断，便于后续零风险接入主链路。
 */
export class StrategyTurnSource implements LLMTurnSource {
  constructor(private readonly opts: StrategyTurnSourceOptions) {}

  async run(messages: ChatCompletionMessageParam[]): Promise<LLMTurnRawResult> {
    const reasoningDeltas: ReasoningDeltaInput[] = [];
    let content = "";

    const turn = await this.opts.strategy.runTurn({
      model: this.opts.model,
      messages,
      tools: this.opts.tools,
      signal: this.opts.signal,
      temperature: this.opts.temperature,
      think: this.opts.think,
      modelSupportsThinking: this.opts.modelSupportsThinking,
      modelSupportsCacheControl: this.opts.modelSupportsCacheControl,
      modelSupportsVision: this.opts.modelSupportsVision,
      callbacks: {
        onReasoningDelta: (text, partIndex, itemId) => {
          if (text) reasoningDeltas.push({ text, partIndex, itemId });
          // 仅当上层显式提供回调时才转发（canary 驱动 UI）；shadow 不提供 → 完全静默。
          this.opts.onReasoningDelta?.(text, partIndex, itemId);
        },
        // 正文最终以 turn.content 为准；这里累计仅作兜底，避免依赖回调时序。
        onTextDelta: (text) => {
          if (text) content += text;
          this.opts.onTextDelta?.(text);
        },
        // 工具草案仍在 run 结束时从 turn.toolCalls 统一归一化；这里只把"检测到了"这个
        // 时间点转发给上层，供其提前渲染 loading 卡片。不提供回调时保持静默（shadow 零副作用）。
        onToolCallDetected: (name, id) => {
          this.opts.onToolCallDetected?.(name, id);
        },
      },
    });

    const toolCalls: LLMToolCallDraft[] = turn.toolCalls.map((tc) => ({
      callId: tc.id,
      toolName: tc.name,
      toolKind: resolveToolKind(tc.name),
      parsedArgs: tryParseArgs(tc.arguments),
      rawArgsText: tc.arguments,
    }));

    return {
      // 以 strategy 返回的完整 content 为准；流式累计仅在返回为空时兜底。
      content: turn.content || content,
      reasoningDeltas,
      toolCalls,
      finishReason: turn.normalizedFinishReason,
      // 透传真实 token 用量，供新链路收尾时精确计费/驱动压缩；provider 未返回则为 undefined。
      usage: turn.usage,
    };
  }
}

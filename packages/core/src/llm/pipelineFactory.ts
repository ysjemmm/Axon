/**
 * PipelineFactory —— 现网 pipeline 一键装配工厂（接现网前最后一块零风险预制件）
 *
 * 背景：
 * - 接现网时，agentSession 需要一个“配好的、可直接跑一轮”的 orchestrator。
 * - 如果让 agentSession 自己去 new 五个 handler、拼两个适配器，接线代码会又长又易错，
 *   而且把装配细节泄漏进主链路，违背“接线最小化”的切换纪律。
 * - 本工厂把 StrategyTurnSource + HostToolExecutor + 五段默认 handler 的装配收敛到一处，
 *   agentSession 只需给出会话级依赖，就能拿到一个可运行的 DefaultPipelineOrchestrator。
 *
 * 设计要点：
 * - 纯装配：不发请求、不执行工具、不改任何现网状态；只是把零件组装起来返回。
 * - 装配所需依赖与现网 strategy.runTurn / executeToolCall 的入参一一对应，不新增业务判断。
 * - 本工厂被调用不代表“已接管现网”——是否真正用它跑一轮，由 agentSession 的切换开关决定。
 */

import type { LLMStrategy, ToolDef } from "./types.js";
import type { AgentHost } from "../host/index.js";
import type { SkillLoaderFn, PowerLoaderFn, WebCapability } from "../tools/index.js";
import { StrategyTurnSource } from "./strategyTurnSource.js";
import { HostToolExecutor } from "./hostToolExecutor.js";
import { DefaultRequestContextHandler } from "./requestContextHandler.js";
import { DefaultTurnContextHandler } from "./turnContextHandler.js";
import { DefaultLLMHandler } from "./llmHandler.js";
import { DefaultToolDispatchHandler } from "./toolDispatchHandler.js";
import { DefaultOutputHandler } from "./outputHandler.js";
import { DefaultPipelineOrchestrator } from "./pipelineOrchestrator.js";

/** 装配一条现网 pipeline 所需的会话级依赖。 */
export interface PipelineFactoryDeps {
  /** LLM 协议执行策略（ChatCompletions / Responses）。 */
  strategy: LLMStrategy;
  /** 模型名。 */
  model: string;
  /** 本轮可用工具定义。 */
  tools: ToolDef[];
  /** 采样温度（可选）。 */
  temperature?: number;
  /** 中断信号（可选，LLM 与工具执行共用）。 */
  signal?: AbortSignal;
  /** 工具执行环境：当前工作目录。 */
  cwd: string;
  /** 宿主能力。 */
  host: AgentHost;
  /** 绑定的工作区根（可选）。 */
  workspaces?: string[];
  /** skill 加载器（可选）。 */
  skillLoader?: SkillLoaderFn;
  /** web 能力（可选，支持 web_search/web_fetch）。 */
  web?: WebCapability;
  /** power 加载器（可选）。 */
  powerLoader?: PowerLoaderFn;
}

/**
 * 用会话级依赖装配一条可运行的现网 pipeline。
 *
 * 返回一个 DefaultPipelineOrchestrator：其 LLMHandler 由 StrategyTurnSource 驱动、
 * ToolDispatchHandler 由 HostToolExecutor 驱动，request/turn/output 均用默认实现。
 */
export function createStrategyPipeline(deps: PipelineFactoryDeps): DefaultPipelineOrchestrator {
  const turnSource = new StrategyTurnSource({
    strategy: deps.strategy,
    model: deps.model,
    tools: deps.tools,
    temperature: deps.temperature,
    signal: deps.signal,
  });

  const toolExecutor = new HostToolExecutor({
    cwd: deps.cwd,
    host: deps.host,
    workspaces: deps.workspaces,
    skillLoader: deps.skillLoader,
    web: deps.web,
    powerLoader: deps.powerLoader,
    signal: deps.signal,
  });

  return new DefaultPipelineOrchestrator(
    new DefaultRequestContextHandler(),
    new DefaultTurnContextHandler(),
    new DefaultLLMHandler(turnSource),
    new DefaultToolDispatchHandler(toolExecutor),
    new DefaultOutputHandler(),
  );
}

/**
 * @axon/core —— Axon Agent 内核
 *
 * 零形态依赖：只面向两层抽象编程，由各形态在外部注入具体实现。
 *   · AgentHost    （./host）   执行端：fs / commands / diagnostics / browser / edits / ideContext
 *   · AgentChannel （./channel）呈现端：出站 AgentEvent / 入站 ControlCommand
 *
 * 阶段 1 将把 server/src 下的内核模块（agentSession / tools / agentGuards / relay /
 * skills / llm / compactor 等）迁入本包，并把对 node:fs / child_process / ws 的直接依赖
 * 改为走注入的 AgentHost / AgentChannel。
 *
 * 当前（阶段 0）：仅导出两层抽象契约，供下游包提前对齐接口实现。
 */

export * from "./host/index.js";
export * from "./channel/index.js";
export * from "./tools/index.js";
// DiagnosticFileResult 同时来自 host（含 details，规范版）与 tools/definitions（精简版），
// 显式以 host 版本为准消除 export * 的命名歧义。
export type { DiagnosticFileResult } from "./host/index.js";

// 阶段 1 迁入的纯逻辑/纯数据内核模块（零形态依赖：仅依赖 openai 与彼此类型）
export * from "./agentGuards.js";
export * from "./compactor.js";
export * from "./messageSanitizer.js";
export * from "./mcp/types.js";
export * from "./mcp/mcpRegistry.js";
export * from "./llm/types.js";
export * from "./llm/modelContext.js";
export * from "./llm/chatCompletionsStrategy.js";
export * from "./llm/responsesStrategy.js";
export * from "./relay/types.js";
export * from "./relay/planParser.js";
export * from "./storage/types.js";

// skills 运行时（迁自 server/src/skills）
export * from "./skills/builtinSkills.js";
export * from "./skills/skillLoader.js";
export * from "./skills/subAgentRunner.js";

// relay 运行时（迁自 server/src/relay）
export * from "./relay/relayStore.js";
export * from "./relay/reviewAgent.js";
export * from "./relay/parallelResearch.js";

// 系统提示、provider、Agent 会话、会话编排
export * from "./systemPrompt.js";
export * from "./providers.js";          // ESIGN_PROVIDER（再导出）、getClient/getStrategy/applyResolvedProviders/refreshProviders/...
export type * from "./providerTypes.js"; // 仅类型，避免 ESIGN_PROVIDER 值与 providers.js 双重星号导出冲突
export * from "./providerCatalog.js";    // BUILTIN_PROVIDERS / builtinModels / getBuiltinProvider
export * from "./providerRegistry.js";   // ProviderRegistry + 路径助手
export * from "./agentSession.js";
export * from "./session/index.js";

// web 能力（webSearch/webFetch，跨形态通用；形状即 WebCapability）
export * from "./web/webSearch.js";

// Powers 能力扩展包（MCP 服务器 + 文档 + 工作流引导）
export * from "./powers/powerLoader.js";

// Credits 计费系统（Token → Credits 换算）
export * from "./credits.js";

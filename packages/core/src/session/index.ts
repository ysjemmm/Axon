/**
 * 会话编排层出口。
 *
 * SessionHub 把会话生命周期与具体传输解耦：各形态（server WsChannel / VS Code 进程内）
 * 只需注入 SessionHubDeps，并把入站消息翻译成 ControlCommand 交给 hub.dispatch。
 */

export * from "./types.js";
export { CommandToolExecutor } from "./commandToolExecutor.js";
export { RelayToolExecutor } from "./relayToolExecutor.js";
export { DelegatedToolExecutor } from "./delegatedToolExecutor.js";
export { McpToolExecutor } from "./mcpToolExecutor.js";
export { GenericToolExecutor } from "./genericToolExecutor.js";
export { ToolOutcomeStateResolver } from "./toolOutcomeStateResolver.js";
export { ToolOutcomeRecorder } from "./toolOutcomeRecorder.js";
export { ToolOutcomePostSync } from "./toolOutcomePostSync.js";
export { TurnFinalizer } from "./turnFinalizer.js";
export { NoToolTurnDecider } from "./noToolTurnDecider.js";
export { ErrorTurnHandler } from "./errorTurnHandler.js";
export { ReflectionHandler } from "./reflectionHandler.js";
export { ToolCallExecutor, type TurnState } from "./toolCallExecutor.js";
export { SessionTraceWriter, truncateForTrace } from "./sessionTraceWriter.js";
export { resolveToolDispatchRoute } from "./toolDispatchRouter.js";
export { SessionHub } from "./sessionHub.js";

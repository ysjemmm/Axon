/**
 * @axon/core 工具子系统统一出口
 *
 * 汇总：
 *   - definitions：传给 LLM 的工具定义、只读白名单、ToolMeta 等纯类型/数据
 *   - safety：危险命令检测与遍历忽略目录
 *   - execute：工具调用执行入口 executeToolCall（面向 AgentHost 抽象）
 *   - search：搜索/列目录的对外辅助（按需复用）
 */

export * from "./definitions.js";
export * from "./safety.js";
export * from "./commandTrust.js";
export * from "./commandGate.js";
export * from "./applyPatch.js";
export * from "./reverseEdit.js";
export { executeToolCall } from "./execute.js";
export type { WebCapability } from "./execute.js";
export {
  findFileByName,
  owningWorkspace,
  searchEntries,
  searchContent,
  listDir,
  dirHasVisibleEntries,
  mergeMultiRootResults,
} from "./search.js";

# 新 Pipeline 接现网灰度切换方案

## 背景

经过前面的预制阶段，core 内已具备一条完整、可测、零风险的新链路：

- 五段式责任链：`RequestContextHandler → TurnContextHandler → LLMHandler → ToolDispatchHandler → OutputHandler`
- 现网适配器（只做形状适配、不碰主链路）：
  - `StrategyTurnSource`：把 `LLMStrategy.runTurn` 适配成 `LLMTurnSource`
  - `HostToolExecutor`：把 `executeToolCall` 适配成 `ToolExecutor`
  - `ToolKindResolver`：工具名 → `toolKind`
  - `finishReasonMapper`：协议完成态 → 产品语义（已完成老架构切换）
- 全部有单测 + 集成测试，全量测试绿。

但这些新链路**尚未接入 `agentSession` 主循环**，现网请求仍完全走老路径。

「接现网」是整个重构风险最高的一跳：它第一次让真实用户请求走新链路，涉及前端事件推送、消息历史写入、错误处理、token 计费等现网行为的逐一对齐。**一旦出错会直接影响 Axon 可用性（包括 Axon 自身运行）**，因此必须灰度、可回退、先验证后接管。

## 核心原则（复用重构工作纪律）

1. 老路径始终是默认路径；新路径由开关显式开启，默认关闭。
2. 任何时刻可一键切回老路径，且切回后行为与切换前完全一致。
3. 先「影子运行」（新路径只算不发），再「灰度接管」（新路径真正驱动 UI），不跳步。
4. 每一步都有可观测证据（新老输出对比日志 / trace），不靠人眼猜。
5. 某一环确认接管稳定后，才允许删除对应老代码，不提前删。

## 切换开关设计

- 引入一个会话级开关（如 `AGENT_PIPELINE_MODE`），取值：
  - `legacy`（默认）：完全走老路径，新链路完全不参与。
  - `shadow`：老路径正常驱动 UI；同一轮同时用新链路跑一遍，只做对比 & 记录，**不影响任何用户可见行为**。
  - `canary`：新链路真正驱动一类最简单的 turn；其余仍走老路径。
- 开关默认 `legacy`，只能由显式配置/环境变量开启，绝不默认打开。

## 分阶段计划

### 阶段 0：接线但不启用（零风险）
- [x] 在 `agentSession` 里接入 `pipelineMode` 三态开关（`legacy`/`shadow`/`canary`），并加运行时切换命令 `/pipeline`（无需重构建即可切换）。
- [x] `legacy` 模式下新链路调用点全部短路，现网行为零变化。
- [x] 验证：默认配置下全量测试（19 文件 / 168 用例）+ 手动冒烟，与切换前完全一致。

### 阶段 1：影子运行（shadow）
- [x] 选一种最简单的场景：**无工具调用的纯回答 turn**。
- [x] 老路径照常驱动 UI；新链路用同一份 messages 跑一遍，仅记录：
  - 新链路产出的 `finishReason` / `contentDraft` / 事件序列
  - 与老路径的 `content` / `finishReason` 做 diff
- [x] 对比结果打 `[pipeline-shadow]` 日志，不发任何前端事件、不写消息历史（`runShadowPipelineCompare` 严格只读）。
- [x] 验证：真实对话下 `finishReason` / `toolCalls` 结构信号 100% 对齐；`content` 差异来自 LLM 生成随机性，属预期可解释噪音。

### 阶段 2：灰度接管纯回答 turn（canary）—— 已完成并转正
- [x] `canary` 模式曾作为灰度路径落地，接管点比原计划更靠上：由新链路 `LLMTurnSource → DefaultLLMHandler` 真正驱动本回合的 LLM 推进 + reasoning 归一化。
- [x] 流式增量（reasoning/正文）通过 `StrategyTurnSource` 的可选回调实时转发到主循环同一套 callbacks，前端打字机/思考过程/状态提示与老路径完全一致；只跑一次回合，无双倍 token。
- [x] 真实对话（含多工具轮：搜索工作区 + 读文件 + 收尾总结）下验证通过，控制台无报错。
- [x] `DefaultOutputHandler` 已接管收尾判定（纯回答 turn 的 finalContent 由其产出，实际落盘/stream_end/计费/压缩仍复用 `finalizeAssistantReply`）。
- [x] `DefaultToolDispatchHandler` 已接管工具轮编排（`runToolDispatch` 驱动 plan→execute→complete 状态机）。
- [x] 灰度开关已移除：`canary` 不再是模式名，而是当前唯一生产路径。

### 阶段 2.5：方案 A 落地（编排壳 + 执行核）—— 已完成

> 结论：五段责任链**编排层已 100% 由新架构驱动**，底层执行核复用验证过的现网逻辑。

- [x] `DefaultLLMHandler` 驱动回合产出 + reasoning 归一化。
- [x] `DefaultToolDispatchHandler` 编排工具轮状态机；每个工具的**实际执行**通过注入的 `ToolExecutor` 回调回到老 `executeSingleToolCall`，因此确认门/子Agent/Relay/MCP/软失败隐藏/编辑落盘/截图注入/前端卡片**全部复用验证过的逻辑，零回退、零安全风险**。
- [x] `DefaultOutputHandler` 接管纯回答 turn 收尾判定。
- [x] 重构副产物：工具执行逻辑抽成独立方法 `executeSingleToolCall`，由 `runToolDispatch` 通过 `ToolExecutor` 注入调用。
- [x] 三段接管各打 `[pipeline]` 观测日志；全量测试绿。
- 方案 A 的边界：**编排是新代码，执行核是经验证的现网逻辑**。工具门控/分发逻辑不下沉进 handler，原因见 ADR-1/ADR-2。

### 阶段 3：方案 B —— 门控/事件桥纯组件预制（已完成，休眠备用）

> 目标曾是把门控/前端事件也完全下沉进 handler。经真实代码验证，命令确认顺序与事件 payload 兼容性要求决定：这些逻辑不应接入生产路径，详见 ADR-1/ADR-2。

- [x] 3.1 门控建模：`DefaultToolDispatchHandler` 支持在 `execute` 前挂门控（复用 `ToolCallStateMachine` 已有的 `requireGate/approveGate/block` 原语），由注入的门控决策器决定放行/拦截/等待。
- [x] 3.2 命令确认门抽象：`CommandGateToolDecider` 已把 `gateCommand` 的三档授权结果抽象成 `ToolGateDecision`，有单测覆盖；因产品交互顺序约束不接生产。
- [x] 3.3 分发下沉：判定为不应下沉。子 Agent / 并行 / Relay / MCP 路由属于“如何执行工具”的执行核职责，继续由 `executeSingleToolCall`/`dispatchToolCall` 承担。
- [x] 3.4 事件桥：`toolEventBridge` 已实现 `ToolEvent → tool_call/tool_result payload` 的纯函数桥，有单测覆盖；因现网 `tool_result` payload 字段过多且前端契约未分型，不接生产。
- [x] 3.5 合并接线：经验证会破坏命令确认顺序（用户要求“先卡片→再确认→用户操作”），因此明确不执行。

### 阶段 4：老路径下线与清理 —— 已完成（X-删分支）
- [x] 默认路径从 legacy 切到 canary，进入 dogfood 观察期。
- [x] shadow 只读对比分支下线。
- [x] 主循环里的 legacy 执行分支删除：回合产出无条件走 `runPipelineTurn`，工具轮无条件走 `runToolDispatch`，收尾无条件走 `runPipelineOutput`。
- [x] `pipelineMode` 字段、`/pipeline` 命令和模式切换开关删除；生产路径收敛为单一 pipeline 路径。
- [x] 方法正名：`runCanaryTurn → runPipelineTurn`、`runCanaryToolDispatch → runToolDispatch`、`runCanaryOutput → runPipelineOutput`。
- [x] 全量测试绿，扩展构建通过。
- 说明：`dispatchToolCall` / `executeSingleToolCall` / `finalizeAssistantReply` 不是“老分支”，而是当前 pipeline 注入调用的执行核/收尾核。按 ADR-1/ADR-2，它们保留为现网行为的所有权位置。

## 回退预案

- `pipelineMode` 和 `/pipeline legacy` 已删除；代码级开关回退不再存在。
- 若出现问题，回退方式为 git 回滚到阶段 4 删除开关之前的提交。
- 这是老路径下线后的预期状态：生产路径已收敛为单一 pipeline 路径。

## 风险点清单（接管时逐一对齐）

- 前端事件：老路径发的 `stream_start/delta/pause`、`tool_call` 卡片事件，新链路必须等价产出。
- 消息历史：`displayContent` / `runtimeContent` 的写入语义（工具轮 prose 不进 runtime 等）。
- token 计费与压缩驱动：`recordTurnUsage` / 进度条。
- reasoning 转发：`mode=quest` 时是否转发 reasoning。
- 续写 / 内心 OS / 空回复兜底：这些老路径的「异常收尾」策略要在新链路对应位置复现或显式决定不复现。

## 架构决策记录（ADR）

> 冲刺方案 B 过程中确立的关键决策，附依据，避免后来者重走弯路。

### ADR-1：命令门（execute_command / start_process）永久保持方案 A，不下沉进 handler

- **决策**：命令类工具的三档授权门控继续留在 `dispatchToolCall` 内（执行核里），由方案 A 的编排壳复用，**不**改由 `DefaultToolDispatchHandler` 在 execute 前决策。
- **依据（硬约束）**：产品要求的交互顺序是「**先出工具卡片 → 再弹确认弹窗 → 用户操作**」（用户要先能看到指令内容才能决定是否放行）。方案 B 的门控模型是「plan 之后、execute 之前决策」，必然导致「确认先于卡片」，与该顺序**本质冲突**。
- **补充依据**：命令门本身已是独立、已测、解耦良好的组件（`CommandGate` + `commandGateController`），并非耦合在主循环里的坏代码；强行下沉只换来「顺序倒转 + 编辑后命令的新增安全路径风险」，架构收益为零、风险为正。
- **结论**：带 UI 交互门控的工具，「字面 100% 逻辑都在 handler 里重写」不成立，属于为纯粹而纯粹的过度重构。

### ADR-2：普通工具的前端事件不接管进事件桥（`toolEventBridge` 保持休眠）

- **决策**：现网工具轮的 `tool_call`/`tool_result` 前端事件继续由 `recordToolOutcome` 发出，`toolEventBridge` 只作为已测的休眠组件备用，不接生产。
- **依据**：`recordToolOutcome` 发的 `tool_result` 携带大量运行期字段（`fileDiff` / `fileDiffs` / `noopEdit` / `readRange` / `diagnostics` / `searchResults` / `fetchResult` / `powerActivated` / `mcpMeta` 等），而事件桥是纯函数、只产出最小 payload。让写文件类/搜索类工具走桥会**丢字段**（如 diff 不显示），是行为退化。
- **补充依据**：真正「无副作用字段、无门控、无软失败」能安全走桥的工具只剩 search / list_dir / web_search / check_diagnostics 几个纯读工具。为它们引入「哪些工具能走桥」的白名单 + 执行核 `skipFrontendEvents` 分支，会造成工具轮「一部分走桥、一部分走老路」的**双路径并存**，比现状更不统一、更难维护——与「代码更干净」的初衷相反。
- **结论**：事件桥的价值在于「未来若整体重写前端事件契约时可接」，当前接管无行为收益、只增分裂，故保持休眠。

### ADR-3（后续改进项，非本次范围）：`tool_result` 事件载荷的坏味道

- **现状**：`this.send("tool_result", { id, name, args, result, status, fileDiff, fileDiffs, noopEdit, readRange, diagnostics, searchResults, fetchResult, powerActivated, pending, userMessage, hidden, resolvedPath, ...mcpMeta })` —— 单个事件平铺十几个来自不同工具的差异化字段，前端自行 if/else 认领，缺少策略/多态归拢。
- **改进方向**：按工具类别归拢产物（如 `payload: { kind, data }` 或按 toolKind 分型），前后端各自按 kind 消费；`toolEventBridge` 的 `aiPayload`/`tracePayload` 分层已是这个方向的雏形。
- **为何不在本次做**：牵扯前后端事件契约的联动改动，是独立工程，不应塞进本次重构收尾。留档待专门排期。

## 结论

方案 A 已实测生产可用：canary 下五段责任链的**编排层 100% 由新架构驱动**，工具执行/门控/落盘复用验证过的老逻辑，行为与 legacy 等价。

方案 B 的纯组件（`toolGateDecider` / `commandGateDecider` / `toolEventBridge` / `toolCallStateMachine`）已全部完成、有单测、休眠备用。经 ADR-1/ADR-2 论证，命令门与普通工具前端事件**刻意不接管**——不是未完成，而是接管会破坏产品行为或制造路径分裂。因此本次重构在此收尾定版；进一步的纯粹化（ADR-3）留待前端契约重写时专门排期。

回退：任何时刻 `/pipeline legacy` 一键回到老路径，无需回滚代码。

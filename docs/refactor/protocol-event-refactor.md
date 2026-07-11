# 协议抽象与事件模型重构

## 目标

把当前 `Chat Completions` 与 `Responses` 两条协议链路，重构为统一的内部抽象层，解决协议差异直接泄漏到 `AgentSession`、前端渲染和调试链路的问题，为后续交替式回复、最近一次对话现场、记忆治理打基础。

## 重构工作纪律（贯穿全程，不可违背）

1. 逐步切换：功能从老架构迁到新架构必须小步进行，一次只切一小块，随时可跑、可回退。
2. 切换无感：切换前后都不能影响正常使用；新旧并行期间线上仍走老路径，新路径先验证再接管。
3. 少写兼容字段：并存字段/兼容层只是过渡手段，必须最少化，不允许长期堆积成新的历史包袱。
4. 切完即清：某个功能一旦确认完成切换，必须立即删除对应的老架构代码与过渡兼容字段，保持代码纯净。
5. 每步留证据：每次切换都要有测试或可复现验证，且把“老代码是否已清除”作为该功能切换完成的验收条件之一。

## 重构任务清单

| 编号 | 任务 | 说明 | 完成 | 已测试 | 已验收 |
|---|---|---|---|---|---|
| R1 | 定义统一事件模型 | 定义 `request / content / reasoning / tool / status / debug` 六类核心事件，以及通用字段（如 `requestId`、`turnId`、`ts`、`source`）；其中 `status` 采用 `phase + code + text` 三层结构 | [x] 定义层完成 | [x] | [ ] 待接现网 |
| R2 | 明确协议适配层职责 | 约束 `ChatCompletionsStrategy` 与 `ResponsesStrategy` 只负责把底层协议流转换为统一内部事件，不再把协议细节直接泄漏给上层 | [ ] | [ ] | [ ] |
| R3 | 引入 turn/request 概念分层 | 明确“用户一次请求 = 一个 request”，“agent 内部多轮推进 = 多个 turn”，并把两者的边界落到代码结构里；其中 `truncated` 属于 `turn` 层，不属于 `request` 顶层状态 | [x] 定义层完成 | [x] | [ ] 待接现网 |
| R4 | 抽离回合组装层 | 新增统一的 turn assembler / event assembler，负责拼接内容、reasoning、tool 调用和 finish 状态 | [x] core 内闭环 | [x] | [ ] 待接现网 |
| R5 | 统一 finish / outcome 语义 | 区分协议完成态与产品完成态，避免 `failed` 被误判成 `stop`、`incomplete` 被粗暴等同于正常结束 | [x] 已切换 | [x] | [x] 现网已消费 normalizedFinishReason |
| R6 | 统一工具调用状态机 | 把工具调用标准化为开始、执行中、成功、失败、取消等稳定状态，避免前后端各自猜状态 | [x] 状态机+门控完成 | [x] | [ ] 待接现网 |
| R7 | 统一 reasoning 分段能力 | 在内部事件里保留 `partIndex / itemId` 等分段信息，支持 GPT reasoning summary 正确分组和后续交替式展示 | [x] Assembler/Builder/Processor 完成 | [x] | [ ] 待接现网 |
| R8 | 为交替式输出打基础 | 让 `content / reasoning / tool` 都具备 `turnId` 归属，便于前端后续按 turn 分组，做“文字-工具-文字-工具”的交替结构 | [x] 事件模型已带 turnId | [x] | [ ] 待前端收口 |
| R9 | 为调试现场保留挂点 | 给“最近一次对话现场”预留统一采集点，保证后续能记录请求快照、原始协议事件、工具过程和完成状态 | [ ] | [ ] | [ ] |
| R10 | 前端消费层收口 | 后续让前端只消费统一内部事件，不再感知 Chat / Responses 两种协议的差异 | [ ] | [ ] | [ ] |

## 事件归属原则（新增）

- `request`：表示用户的一次完整问题/任务，是最外层容器。
- `turn`：表示系统为完成同一个 `request` 而进行的一次内部 LLM 推进；一个 `request` 往往包含多个 `turn`。
- `reasoning / chain-of-thought`：不直接归属于整个 `request`，而是**直接归属于某一个具体 `turn`**。
- `request` 的顶层状态只描述整次任务是否开始、进行中、完成、失败或取消；`truncated` 不属于 `request` 层。
- `turn` 的状态用于描述某一轮内部推进是否开始、进行中、完成、截断、失败或取消；`truncated` 归属于 `turn` 层。
- `content / reasoning / tool / status` 这几类可见事件，后续统一要求带上 `requestId`；其中 `content / reasoning / tool` 默认还应带上 `turnId`。
- 当前第一阶段默认语义：
  - `RequestEvent.source = "system"`
  - `RequestEvent.stage = "committed"`
  - `TurnEvent.source = "system"`
  - `TurnEvent.stage = "committed"`
  - `ContentDeltaEvent.source = "llm"`
  - `ContentDeltaEvent.stage = "runtime"`
  - `ContentCommitEvent.source = "llm"`
  - `ContentCommitEvent.stage = "committed"`
  - `ReasoningDeltaEvent.source = "llm"`
  - `ReasoningDeltaEvent.stage = "runtime"`
  - `ReasoningCommitEvent.source = "llm"`
  - `ReasoningCommitEvent.stage = "committed"`
  - `ToolEvent.source = "tool"`
  - `ToolEvent.stage` 当前先显式保留，建议约定：
    - `planned / executing -> runtime`
    - `completed / failed / cancelled -> committed`
  - `StatusEvent.source = "system"`
  - `StatusEvent.stage` 当前先显式保留，建议约定：
    - 大多数运行中状态提示 -> `runtime`
    - `completed / error / cancelled` 这类稳定终态提示 -> `committed`
  - `DebugEvent.source = "debug"`
- `status` 不再只是一段文案，而是采用三层结构：`phase` 表示大阶段，`code` 表示可供代码判断的细分动作，`text` 表示前端最终展示文案。
- 前端后续做交替式展示时，不直接把“思考”挂在整个请求下面，而是按 `turn` 分组：某个 `turn` 的文字、思考、工具卡片一起构成一步推进。
- 调试现场中，也必须能明确回答：某段 `reasoning` 属于哪个 `turn`、该 `turn` 后面触发了哪些工具、最后是正常完成还是中断。

## 第一版责任链草案（精简版）

为避免第一阶段拆得过碎，当前先采用五段式责任链骨架：

| 节点 | 主要职责 | 备注 |
|---|---|---|
| `RequestContextHandler` | 构建本次 request 的基础上下文，如 system prompt、历史消息、summary、IDE context | 解决“这次任务起点是什么” |
| `TurnContextHandler` | 基于 request 上下文，构建本轮 turn 真正发给模型的 messages，并做发送前清洗 | 解决“这一轮到底发什么” |
| `LLMHandler` | 调用 `Chat Completions` / `Responses`，并把原始协议流转换成统一内部事件 | 解决“模型这一轮怎么执行” |
| `ToolHandler` | 执行本轮工具调用，处理参数、门控、结果、错误 | 解决“工具怎么执行、怎么返回” |
| `OutputHandler` | 统一处理本轮输出：判断继续/完成/失败，做持久化、规范化、前端输出 | 解决“跑完以后怎么收尾” |

### 说明
- 这一版是“可落地的第一阶段骨架”，不是最终最细颗粒度拆分。
- 后续如果稳定，可继续细拆：如把 `TurnContextHandler` 再分成消息构建与发送前清洗，把 `OutputHandler` 再分成决策、持久化、normalize、前端输出。
- 当前重构先追求结构收口与责任边界清晰，不追求一步拆到最细。

## Tool 事件分层与分类原则（新增）

### 1. Tool 与 Tool Event 的区别
- `Tool`：表示系统具备的某项静态能力定义（能做什么、参数 schema 是什么、权限边界是什么）。
- `ToolEvent`：表示该能力在某次 `request / turn` 中被实际调用时的运行时实例（这次调了什么、参数是什么、结果是什么、状态如何）。

### 2. ToolEventBase 的角色
- `ToolEventBase` 只承载所有工具调用共享的稳定公共字段，如：`callId`、`toolName`、`toolKind`、`phase`、`gateState`、`outcomeKind`、`rawArgsText`、`parsedArgs`、`aiPayload`、`tracePayload`、`visibility`、`targetLabel`。
- 具体工具的私有属性不再继续往 base 顶层堆，而是下沉到各自扩展事件的 `meta` 中。
- `ToolEvent` 具体结构已从 `eventModel.ts` 拆出到独立文件 `toolEventModel.ts`，避免基础事件模型与工具专属协议长期耦合。

### 3. 具体工具扩展原则
- 先有统一公共对象，再按工具类型扩展私有属性。
- 第一阶段已细化：`read_file`、`browser_get_html`、`search`、`web_search`、`str_replace/create_file/apply_patch`、`execute_command`、`check_diagnostics`。
- 其它工具暂时可落到 `GenericToolEvent`，后续按需要再增强。

### 4. toolKind 分类规范
| toolKind | 含义 | 典型工具 |
|---|---|---|
| `read` | 本地文件/工作区内容读取 | `read_file` |
| `search` | 工作区内搜索/定位 | `search` |
| `edit` | 文件编辑/补丁写入 | `str_replace` `create_file` `apply_patch` |
| `command` | 本地命令执行 | `execute_command` |
| `diagnostics` | 诊断/检查 | `check_diagnostics` |
| `browser` | 浏览器会话读取与交互 | `open_browser` `browser_get_html` `browser_click` `browser_eval` `screenshot_page` |
| `network` | 独立联网获取与搜索 | `web_search` `web_fetch` |
| `orchestration` | 调度/编排/委托类工具 | `delegate_task` `parallel_research` `parallel_execute` `relay_*` |
| `other` | 暂未细分的兜底类 | 其它工具 |

### 5. 展示层与 AI/trace 层分离原则
- 面向普通用户的展示文案，不直接放在 `ToolEventBase` 顶层，由后续 normalize / frontend payload 层生成。
- 面向 AI 的结果统一放在 `aiPayload`。
- 面向调试现场的原始结果统一放在 `tracePayload`。
- 同一份工具调用，不再混用“给用户看”“给 AI 看”“给调试看”的字段。

### 6. Status 文案解析责任链
- `status` 采用三层结构：`phase + code + text`。
- 其中 `text` 不是到处写死，而是通过独立的 `statusTextResolver.ts` 责任链统一生成。
- 当前责任链顺序为：
  1. `ExplicitTextResolver`：调用方显式传入 `text` 时优先采用
  2. `ActionStatusResolver`：按动作/工具类状态生成文案
  3. `RenderStatusResolver`：按图形/渲染类状态生成文案
  4. `DefaultStatusResolver`：通用默认状态文案
  5. `FallbackStatusResolver`：最终兜底 `处理中...`
- 责任链节点不再使用 `undefined` 这类模糊返回，而统一返回结构化结果：是否命中、命中来源、是否停止继续传递。

### 7. request / turn / tool 责任链骨架落地
- 第一阶段已新增 `handlerModel.ts`，先把责任链骨架从文档推进到代码定义层。
- 当前包含三层上下文骨架：
  - `RequestContext`
  - `TurnContext`
  - `ToolContext`
- 当前包含三层 handler 接口：
  - `RequestHandler`
  - `TurnHandler`
  - `ToolHandler`
- 同时预留了第一阶段精简版五段式节点接口：
  - `RequestContextHandler`
  - `TurnContextHandler`
  - `LLMHandler`
  - `ToolDispatchHandler`
  - `OutputHandler`
- 当前阶段仍只定义骨架，不绑定具体业务实现；后续再逐步把现有 `AgentSession` 逻辑迁移进这些节点。

### 8. Request / Turn / Tool Context 当前收口结果
- `RequestContext` 当前只承载 request 级稳定骨架：`requestId`、`startedAt`、`baseMessages`。
- `RequestContext` 不再直接持有全量事件集合，避免过早演化成“大日志袋子”；事件与 trace 收集先收敛在 turn 层。
- `TurnContext` 当前承载：
  - `requestId`
  - `turnId`
  - `startedAt`
  - `effectiveMessages`
  - `runtimeEvents`
  - `committedEvents`
  - `toolContexts`
- `TurnContext` 中的事件已拆成两层：
  - `runtimeEvents`：运行中的原始事件（流式增量、工具阶段变化、调试事件等）
  - `committedEvents`：已规范化、准备进入后续输出/持久化链路的事件
- `ToolContext` 当前承载：
  - `requestId`
  - `turnId`
  - `callId`
  - `toolName`
  - `toolKind`
  - `partialToolEvent`
- `ToolContext` 不再假设一开始就有完整 `ToolEvent`，而是按责任链执行过程逐步补齐 `partialToolEvent`。

### 9. Handler 输入输出权限约束（新增）
- 第一阶段已新增 `handlerContracts.ts`，并同步落地了更准确命名的 `handlerPolicyModel.ts`，用于先把“谁可以改什么”结构化下来。
- 当前定义了三层 patch 模型：
  - `RequestContextPatch`
  - `TurnContextPatch`
  - `ToolContextPatch`
- 当前定义了三层 policy：
  - `RequestHandlerPolicy`
  - `TurnHandlerPolicy`
  - `ToolHandlerPolicy`
- 当前默认权限分配为：
  - `RequestContextHandler`：允许改 `startedAt`、`baseMessages`
  - `TurnContextHandler`：允许改 `startedAt`、`effectiveMessages`、`runtimeEvents`、`toolContexts`
  - `LLMHandler`：允许改 `runtimeEvents`
  - `ToolDispatchHandler`：允许改 `toolContexts`、`runtimeEvents`
  - `OutputHandler`：只允许改 `committedEvents`
- 其中 `OutputHandler` 当前阶段明确不再回头改 `effectiveMessages`、`baseMessages` 等上游输入骨架，避免收尾层与构建层重新耦合。

### 10. LLMHandler 最小输入输出契约（新增）
- 第一阶段已新增 `llmHandlerContract.ts`，明确 `LLMHandler` 不再只是抽象名字，而是有清晰的最小输入输出协议。
- 当前输入定义为 `LLMHandlerInput`：
  - `requestId`
  - `turnId`
  - `effectiveMessages`
- 当前输出定义为 `LLMHandlerOutputDraft`：
  - `runtimeEvents`
  - `toolDrafts`
  - `finishReason`
  - `contentDraft`
  - `stage`
- 当前 `LLMHandlerStage` 建议值为：
  - `prepared`
  - `streaming`
  - `tool_calls_detected`
  - `content_completed`
  - `failed`
- 这意味着：
  - `LLMHandler` 只负责协议执行与统一事件产出
  - 不直接负责持久化
  - 不直接负责最终前端输出
  - 不直接做最终 turn 决策，只提供结果草案交给后续链路

### 11. ToolDispatchHandler 最小输入输出契约（新增）
- 第一阶段已新增 `toolDispatchHandlerContract.ts`，明确工具分发层最少吃什么、吐什么。
- 当前输入定义为 `ToolDispatchHandlerInput`：
  - `requestId`
  - `turnId`
  - `toolDrafts`
  - `toolContexts`
- 当前输出定义为 `ToolDispatchHandlerOutputDraft`：
  - `runtimeEvents`
  - `toolContexts`
  - `toolResultsReady`
  - `stage`
- 当前 `ToolDispatchStage` 建议值为：
  - `draft_received`
  - `dispatching`
  - `tool_executing`
  - `tool_completed`
  - `tool_failed`
- 这意味着：
  - `ToolDispatchHandler` 负责把 LLM 识别出的工具调用草案推进到实际工具执行链路
  - 负责补齐工具运行态上下文
  - 负责产生新的运行态事件
  - 但仍不直接做最终输出规范化与持久化

### 12. OutputHandler 最小输入输出契约（新增）
- 第一阶段已新增 `outputHandlerContract.ts`，明确输出收尾层最少处理哪些输入，并最少产出哪些结果。
- 当前输入定义为 `OutputHandlerInput`：
  - `requestId`
  - `turnId`
  - `runtimeEvents`
  - `committedEvents`
  - `toolContexts`
  - `contentDraft`
  - `finishReason`
- 当前输出定义为 `OutputHandlerOutputDraft`：
  - `committedEvents`
  - `shouldContinue`
  - `finalContent`
  - `stage`
- 当前 `OutputHandlerStage` 建议值为：
  - `normalizing`
  - `ready_to_commit`
  - `finalized`
- 这意味着：
  - `OutputHandler` 负责把运行态事件筛选/规范化成可提交事件
  - 负责判断 request 是否继续进入下一轮 turn
  - 负责在本轮已形成最终可回复内容时给出 `finalContent`
  - 仍不回头修改 request 级基础上下文

### 13. RequestContextHandler 最小输入输出契约（新增）
- 第一阶段已新增 `requestContextHandlerContract.ts`，明确 request 起点层最少吃什么、吐什么。
- 当前输入定义为 `RequestContextHandlerInput`：
  - `requestId`
  - `startedAt`
  - `userInput`
  - `historyMessages`
- 当前输出定义为 `RequestContextHandlerOutputDraft`：
  - `requestContext`
  - `stage`
- 当前 `RequestContextHandlerStage` 建议值为：
  - `request_received`
  - `history_loaded`
  - `base_messages_built`
- 这意味着：
  - `RequestContextHandler` 负责把用户本次问题与可用历史消息整理为 request 级基础上下文
  - 输出的是可被后续多个 turn 继承的 `baseMessages` 骨架

### 14. TurnContextHandler 最小输入输出契约（新增）
- 第一阶段已新增 `turnContextHandlerContract.ts`，明确 turn 构建层最少吃什么、吐什么。
- 当前输入定义为 `TurnContextHandlerInput`：
  - `requestId`
  - `turnId`
  - `startedAt`
  - `requestContext`
  - `addedMessages`
- 当前输出定义为 `TurnContextHandlerOutputDraft`：
  - `turnContext`
  - `stage`
- 当前 `TurnContextHandlerStage` 建议值为：
  - `turn_received`
  - `messages_merged`
  - `turn_context_ready`
- 这意味着：
  - `TurnContextHandler` 负责在 request 基础上下文之上，构造本轮真正发给模型的 `effectiveMessages`
  - 同时初始化本轮 `runtimeEvents` / `committedEvents` / `toolContexts` 容器

### 15. 第二阶段实现层试点（新增）
- 为验证 `llm/index.ts` 统一出口在真实实现层是否顺手，当前已新增五个最小实现骨架：
  - `requestContextHandler.ts`
  - `turnContextHandler.ts`
  - `llmHandler.ts`
  - `toolDispatchHandler.ts`
  - `outputHandler.ts`
- 这五个文件当前都作为“实现层消费者”直接从 `llm/index.ts` 导入定义层类型，而不是再分别零散引用多个定义文件。
- 当前作用：
  - `DefaultRequestContextHandler`：验证 request 基础上下文骨架的最小构造
  - `DefaultTurnContextHandler`：验证 request 基础上下文 + addedMessages 能否稳定组装成 turn 的 `effectiveMessages`
  - `DefaultLLMHandler`：验证 LLMHandler 契约已可被实现层承接，后续再逐步接入真实策略执行逻辑
  - `DefaultToolDispatchHandler`：验证工具分发层契约已可被实现层承接，后续再逐步接入真实工具执行与门控逻辑
  - `DefaultOutputHandler`：验证输出收尾层契约已可被实现层承接，后续再逐步接入真实提交/前端输出/最终判定逻辑
- 当前仍是最小实现，不接复杂业务逻辑；目的只是先打通“统一出口 -> 实现层消费”的路径。

## 当前目录结构建议（第一阶段定义层）

当前第一阶段为了快速落地，定义文件先集中放在 `packages/core/src/llm/` 下。随着抽象层逐步稳定，建议后续按职责收口为如下结构：

| 目录 | 主要内容 | 当前状态 |
|---|---|---|
| `llm/` | 协议与模型抽象层：事件模型、工具事件模型、状态解析器、LLM 协议执行契约 | 第一阶段已实际落在这里 |
| `pipeline/` | request / turn / tool 责任链节点与输入输出契约 | 第一阶段仍临时放在 `llm/`，后续建议迁出 |
| `runtime/` | RequestContext / TurnContext / ToolContext 等运行时上下文与权限约束 | 第一阶段仍临时放在 `llm/`，后续建议迁出 |

### 迁移建议
- 当前先不急着移动文件，避免第一阶段定义层刚落地就反复改路径。
- 等第二阶段开始把真实业务逻辑接入这些骨架时，再统一做一次目录迁移。
- 迁移目标：
  - `eventModel.ts` / `toolEventModel.ts` / `statusTextResolver.ts` 保持在 `llm/`
  - `handlerModel.ts` / `handlerContracts.ts` / `*HandlerContract.ts` 逐步迁到 `pipeline/` 或 `runtime/`

## 统一事件模型（第一阶段定义层）

当前新增统一事件层级：
- `runtime`：表示运行中的草案事件（流式增量、工具执行过程、调试原始事件等）
- `committed`：表示已规范化、可进入持久化/前端稳定展示链路的事件

这一层与 `TurnContext.runtimeEvents / committedEvents` 保持一致，用于让基础事件模型与责任链骨架的“草案 / 提交”分层对齐。

## 分阶段建议

### 第一阶段：先立抽象，不急着大改业务
- 定义统一事件类型
- 理清 request / turn 概念
- 明确 reasoning 绑定 turn，而不是直接绑定 request
- 先建立五段式责任链骨架
- 收敛 strategy 的职责边界

### 第二阶段：接入核心执行链路
- 接入 `ChatCompletionsStrategy`
- 接入 `ResponsesStrategy`
- 引入 turn assembler
- 统一 finish / tool 状态

### 第三阶段：接入前端与调试能力
- 前端按统一事件消费
- 为交替式渲染做 turn 分组
- 为最近一次对话现场增加 trace 采集和查看入口

## 验收标准

| 编号 | 验收项 | 状态 |
|---|---|---|
| A1 | 上层不再直接依赖具体协议字段（如 `response.output_text.delta`、`delta.reasoning_content`） | [ ] |
| A2 | GPT / Responses 与 Chat Completions 两条路径都能产出同一种内部事件模型 | [ ] |
| A3 | 能明确区分 request 与 turn，不再混用“回合”概念 | [ ] |
| A4 | 工具调用、reasoning、正文输出都能稳定归属于某个 turn | [ ] |
| A5 | 为交替式 UI 和最近一次对话现场提供稳定、统一的数据基础 | [ ] |

## 备注

- 这是结构重构，不是单点 bug 修复。
- 当前阶段优先级：先把抽象层立住，再逐步迁移业务逻辑和前端消费层。
- 记忆治理（如何筛掉污染数据）属于下一阶段，不在本轮优先范围内。

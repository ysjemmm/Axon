# 事件默认语义规则表（第一阶段）

## 目标

把当前第一阶段已经逐步落地的 `source / stage` 默认语义，整理成一张统一规则表，避免后续实现层只能从零散注释里猜每类事件默认属于哪一层。

## 当前默认规则

| 事件类型 | 默认 source | 默认 stage | 说明 |
|---|---|---|---|
| `RequestEvent` | `system` | `committed` | request 生命周期事件，天然属于系统层且是稳定结果 |
| `TurnEvent` | `system` | `committed` | turn 生命周期事件，表示某轮内部推进已形成稳定状态 |
| `ContentDeltaEvent` | `llm` | `runtime` | 正文流式增量，属于运行中的 LLM 草案输出 |
| `ContentCommitEvent` | `llm` | `committed` | 正文已定型，准备进入稳定输出/持久化链路 |
| `ReasoningDeltaEvent` | `llm` | `runtime` | 推理增量属于运行时思考片段 |
| `ReasoningCommitEvent` | `llm` | `committed` | 推理分段已定型，准备进入稳定输出/展示链路 |
| `ToolEvent` | `tool` | 显式传入 | 当前第一阶段先保留显式 `stage`，建议：`planned/executing -> runtime`，`completed/failed/cancelled -> committed` |
| `StatusEvent` | `system` | 显式传入 | 当前第一阶段先保留显式 `stage`，建议：运行中提示 -> `runtime`，终态提示 -> `committed` |
| `DebugEvent` | `debug` | 调用方显式决定 | 调试事件不强绑单一 stage，由具体链路按保留现场需要决定 |

## 当前设计原则

### 1. 生命周期事件天然偏 committed
- `request.phase`
- `turn.phase`

这类事件本质是在表达“某个阶段已经形成一个稳定结论”，所以默认更偏 `committed`。

### 2. LLM 增量事件天然偏 runtime
- `content.delta`
- `reasoning.delta`

这类事件本质是在表达运行中不断流出的草案内容，所以默认更偏 `runtime`。

### 3. LLM 提交事件天然偏 committed
- `content.commit`
- `reasoning.commit`

这类事件本质是在表达“某段内容已经从草案变成稳定结果”。

### 4. Tool / Status 当前仍允许显式传入 stage
原因：
- 工具事件的 `phase` 与 `stage` 存在映射关系，但第一阶段尚未彻底固化自动推导逻辑
- 状态事件有运行态提示，也可能有终态提示，第一阶段先保留灵活性更稳妥

## 后续建议

- 第二阶段如果 tool/status 的阶段映射稳定下来，可以把更多默认语义下沉到类型或构造器里，而不是每次调用方手填。
- 尤其是 `ToolEvent`，后续很适合按 `phase` 自动推导 `stage`。

# Stage 命名一致性审查建议（第一阶段契约层）

## 当前 stage 现状

### RequestContextHandlerStage
- `request_received`
- `history_loaded`
- `base_messages_built`

### TurnContextHandlerStage
- `turn_received`
- `messages_merged`
- `turn_context_ready`

### LLMHandlerStage
- `prepared`
- `streaming`
- `tool_calls_detected`
- `content_completed`
- `failed`

### ToolDispatchStage
- `draft_received`
- `dispatching`
- `tool_executing`
- `tool_completed`
- `tool_failed`

### OutputHandlerStage
- `normalizing`
- `ready_to_commit`
- `finalized`

## 当前问题

这些 stage 已经能表达链路状态，但命名风格还不完全统一：

1. 有的以“对象 + 动词过去分词”表达
   - `request_received`
   - `tool_completed`

2. 有的以“过程动名词”表达
   - `streaming`
   - `dispatching`
   - `normalizing`

3. 有的以“结果态形容词/短语”表达
   - `prepared`
   - `finalized`
   - `ready_to_commit`

4. 有的带明确领域前缀，有的没有
   - `tool_executing`
   - `content_completed`
   - `prepared`

## 建议的统一原则

第一阶段先不强制全量改名，但建议从现在开始遵守以下规则：

### A. 推荐三种稳定命名形态

| 形态 | 用途 | 例子 |
|---|---|---|
| `*_received` | 输入已接收 | `request_received` `turn_received` `draft_received` |
| `*_in_progress` 或进行态动名词 | 某阶段正在进行 | `streaming` `dispatching` `normalizing` |
| `*_ready` / `*_completed` / `*_failed` | 已形成稳定输出或终态 | `turn_context_ready` `tool_completed` `tool_failed` |

### B. 单个 stage 枚举内部尽量保持同一语义节奏
例如：
- 起点：received
- 处理中：in_progress / streaming / dispatching
- 终态：ready / completed / failed

### C. 优先保留已经比较自然的名字，不为统一而机械重命名
例如：
- `streaming` 比 `content_stream_in_progress` 更自然
- `normalizing` 比 `output_normalizing_in_progress` 更自然

## 第一阶段的建议态度

- 现有命名**可接受**，不需要立刻大改。
- 但后续新增 stage 时，应优先参考这份规范，避免继续自由发挥。
- 等第二阶段真实实现链路时，如果发现某几个名字确实影响理解，再做一次集中重命名。

## 当前结论

- 现有 stage 语义已经足够支撑第一阶段骨架。
- 当前更重要的是保证：每个 handler 都有 stage，而不是立刻把所有 stage 名字打磨到绝对统一。
- 命名一致性作为“下一轮收口任务”保留即可。

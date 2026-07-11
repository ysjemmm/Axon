# 命名一致性审查建议（第一阶段定义层）

## 当前文件现状

当前 `packages/core/src/llm/` 下，定义层相关文件主要有：

- `eventModel.ts`
- `toolEventModel.ts`
- `handlerModel.ts`
- `handlerContracts.ts`
- `llmHandlerContract.ts`
- `requestContextHandlerContract.ts`
- `turnContextHandlerContract.ts`
- `toolDispatchHandlerContract.ts`
- `outputHandlerContract.ts`
- `statusTextResolver.ts`

## 当前不一致点

### 1. 有的叫 `*Model`，有的叫 `*Contract`，有的叫 `*Contracts`
- `eventModel.ts`
- `toolEventModel.ts`
- `handlerModel.ts`
- `handlerContracts.ts`
- `llmHandlerContract.ts`

问题：单复数、职责层级不统一，读目录时很难一眼分出：
- 哪些是“数据结构”
- 哪些是“契约”
- 哪些是“解析器/运行逻辑”

### 2. `handlerContracts.ts` 和 `*HandlerContract.ts` 并存
- `handlerContracts.ts`：放的是通用 patch / contract 约束
- `llmHandlerContract.ts`：放的是某一个 handler 的最小输入输出契约

问题：
- 一个是复数 `Contracts`
- 一个是单数 `Contract`
- 但从读者视角看，它们都像“handler 契约文件”，边界不够一眼清楚

### 3. `statusTextResolver.ts` 是行为型文件，但其它大多是定义型文件
这个本身不是错，但会提醒我们后面目录分层迟早要收口：
- 定义型
- 契约型
- 行为型

## 第一阶段建议命名规范

为了避免现在就大量改路径，第一阶段建议先只定规范，不强制立刻全量重命名。

### A. 数据结构文件
统一用：
- `*Model.ts`

适用：
- `eventModel.ts`
- `toolEventModel.ts`
- `handlerModel.ts`

### B. 契约文件
统一用：
- `*Contract.ts`

适用：
- `llmHandlerContract.ts`
- `requestContextHandlerContract.ts`
- `turnContextHandlerContract.ts`
- `toolDispatchHandlerContract.ts`
- `outputHandlerContract.ts`

### C. 通用约束文件
当前 `handlerContracts.ts` 更像“通用 handler 约束集合”，不是某一个 handler 的 contract。
建议后续择一：
- 改名为 `handlerContractModel.ts`
- 或迁移后改名为 `handlerPolicyModel.ts`

我更推荐：
- `handlerPolicyModel.ts`

原因：
- 里面放的是 patch/writable 约束、权限边界、默认 contract 分配
- 它更像“策略/约束模型”，不是单个 handler 的输入输出 contract

### D. 解析器文件
行为型文件继续用：
- `*Resolver.ts`

适用：
- `statusTextResolver.ts`

## 暂定目标命名（建议）

| 当前文件 | 建议后续名称 | 说明 |
|---|---|---|
| `eventModel.ts` | 保持不变 | 通用事件模型，命名清楚 |
| `toolEventModel.ts` | 保持不变 | 工具事件模型，命名清楚 |
| `handlerModel.ts` | 保持不变 | request/turn/tool 上下文骨架，命名清楚 |
| `handlerContracts.ts` | `handlerPolicyModel.ts` | 更符合“默认权限/约束模型”语义 |
| `llmHandlerContract.ts` | 保持不变 | 单个 handler 输入输出契约 |
| `requestContextHandlerContract.ts` | 保持不变 | 单个 handler 输入输出契约 |
| `turnContextHandlerContract.ts` | 保持不变 | 单个 handler 输入输出契约 |
| `toolDispatchHandlerContract.ts` | 保持不变 | 单个 handler 输入输出契约 |
| `outputHandlerContract.ts` | 保持不变 | 单个 handler 输入输出契约 |
| `statusTextResolver.ts` | 保持不变 | 行为型解析器 |

## 当前建议

- 第一阶段先不删除旧文件，避免路径反复变动；但新命名已先落地一份 `handlerPolicyModel.ts` 作为后续主版本。
- 后续若开始接入真实业务实现，优先让新代码依赖 `handlerPolicyModel.ts`，再择机清理/迁移 `handlerContracts.ts`。
- 目录迁移（`llm/ -> pipeline/runtime/`）时，再统一完成最终重命名。

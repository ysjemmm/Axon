# 定义层依赖关系审查（第一阶段）

## 当前主要依赖方向

### 1. `eventModel.ts`
- 依赖：`toolEventModel.ts`（仅类型导出 `ToolEvent`）
- 角色：通用事件基础模型

### 2. `toolEventModel.ts`
- 依赖：`eventModel.ts`（仅 `EventBase`）
- 角色：工具事件专属协议模型

### 3. `handlerModel.ts`
- 依赖：
  - `eventModel.ts`
  - `toolEventModel.ts`
- 角色：Request / Turn / Tool 三层运行时上下文骨架

### 4. `handlerPolicyModel.ts`
- 依赖：
  - `eventModel.ts`
  - `handlerModel.ts`
- 角色：handler 权限约束与 patch 规则

### 5. 各 `*HandlerContract.ts`
- 普遍依赖：
  - `handlerModel.ts`
  - `eventModel.ts`
  - `toolEventModel.ts`（按需）
- 角色：各责任链节点的最小输入输出契约

## 当前观察结果

### A. 暂无明显的直接环状依赖爆点
当前几组核心定义的主方向基本是：
- `eventModel / toolEventModel`
  → `handlerModel`
  → `handlerPolicyModel / *HandlerContract`

这是一个相对自然的自底向上依赖方向。

### B. `eventModel.ts` 与 `toolEventModel.ts` 存在轻度双向类型关系
当前状态：
- `toolEventModel.ts` 依赖 `EventBase`
- `eventModel.ts` re-export `ToolEvent`

这不一定立刻出问题，但它说明：
- 通用事件模型层和工具事件模型层之间已经开始互相知道彼此
- 后续如果再继续往 `eventModel.ts` 塞更多 tool 专属细节，耦合会升高

### C. `handlerModel.ts` 作为“上下文骨架层”位置合理
它位于：
- 事件模型之上
- 具体 handler 契约之下

目前这个层次是清楚的，可以继续保留。

## 第一阶段建议

### 1. 继续保持“模型层 -> 上下文层 -> 契约层”的依赖方向
推荐顺序：
- `eventModel.ts`
- `toolEventModel.ts`
- `handlerModel.ts`
- `handlerPolicyModel.ts`
- `*HandlerContract.ts`

### 2. 后续避免把具体 handler 逻辑反向塞回模型文件
例如：
- 不要让 `eventModel.ts` 开始依赖 `handlerModel.ts`
- 不要让 `toolEventModel.ts` 依赖 `handlerContracts.ts`

### 3. 第二阶段目录迁移时可顺手进一步解耦
如果后续迁目录，建议目标是：
- `eventModel.ts` 只保留通用事件
- `toolEventModel.ts` 只保留工具事件
- 若需要，可以把统一联合导出放到更上层入口文件做，不让 `eventModel.ts` 本体继续承担过多 re-export 职责

## 当前结论

- 第一阶段定义层当前依赖结构 **可接受**。
- 暂时不需要为了“理论最优”而大改 import 结构。
- 但要重点盯住 `eventModel.ts <-> toolEventModel.ts` 的边界，不要让它们继续互相长出更多耦合。
- 当前已采取的第一步收口动作：
  - 已移除 `eventModel.ts` 对 `ToolEvent` 的 re-export
  - 新增 `llm/index.ts` 作为第一阶段定义层统一导出入口
  - 当前已纳入统一出口的文件包括：
    - `eventModel.ts`
    - `toolEventModel.ts`
    - `handlerModel.ts`
    - `handlerPolicyModel.ts`
    - `requestContextHandlerContract.ts`
    - `turnContextHandlerContract.ts`
    - `llmHandlerContract.ts`
    - `toolDispatchHandlerContract.ts`
    - `outputHandlerContract.ts`
    - `statusTextResolver.ts`
  - 后续若有外部模块需要聚合导入，优先从 `llm/index.ts` 进入，而不是继续把 re-export 压回 `eventModel.ts` 本体
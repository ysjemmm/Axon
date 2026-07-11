# 第二阶段接入建议：统一出口消费点审查

## 目标

在不急着大改第一阶段定义层内部相互依赖的前提下，先判断：后续第二阶段接真实逻辑时，哪些地方最适合优先切到 `llm/index.ts` 统一出口消费，哪些地方暂时继续保持文件内直接依赖更稳。

## 当前判断

### 一、第一阶段定义层内部文件
例如：
- `eventModel.ts`
- `toolEventModel.ts`
- `handlerModel.ts`
- `handlerPolicyModel.ts`
- `statusTextResolver.ts`
- 各 `*HandlerContract.ts`

**建议：先继续保持直接依赖，不强行改成从 `./index.js` 回引。**

原因：
- 它们本来就是定义层内部文件，彼此直接引用更清楚
- 如果现在内部也都改成统一出口，很容易形成“聚合入口反向被内部消费”的不必要耦合
- 定义层内部更适合保持显式依赖边界，而不是把 `index.ts` 变成万能中转站

### 二、第二阶段要接真实逻辑的外部消费点
这类文件更适合优先改成统一出口消费：

#### 1. `AgentSession` 后续若开始接入新责任链骨架
- 当前它还没直接消费这些新定义层文件
- 但一旦开始接 request/turn/tool pipeline，优先从 `llm/index.ts` 统一导入更合适

#### 2. 后续新增的 pipeline 实现文件
例如未来可能出现：
- `requestContextHandler.ts`
- `turnContextHandler.ts`
- `llmHandler.ts`
- `toolDispatchHandler.ts`
- `outputHandler.ts`

这些文件本身不属于第一阶段纯定义层，适合作为统一出口的主要消费者。

#### 3. 未来 runtime / pipeline 目录下的新实现层
一旦第二阶段开始拆目录：
- `pipeline/`
- `runtime/`

这些目录里的实现层文件，优先从 `llm/index.ts` 或未来更上层聚合入口导入，会比零散从多个定义文件拼 import 更稳。

## 当前建议

### 保持直接依赖的范围
- 定义层内部文件继续直接 import 彼此
- 不要让 `index.ts` 反向成为定义层内部的依赖入口

### 优先切统一出口的范围
- 第二阶段新增的真正“实现层”文件
- 尤其是 request/turn/tool 各类 handler 的实现类
- 以及后续如果有 trace recorder / pipeline orchestrator 这类聚合层

## 一句话结论

- `llm/index.ts` 当前更适合作为**定义层对外统一出口**。
- 它不适合作为定义层内部的统一入口。
- 第二阶段接真实逻辑时，优先让“外部实现层”消费 `llm/index.ts`，而不是现在就把定义层内部 import 全改掉。

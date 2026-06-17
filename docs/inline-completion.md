# Inline Completion（行内代码补全）

## 目标

在编辑器中实现类 Copilot 的行内代码补全：光标处出现灰色幽灵文本建议，Tab 接受。

## 核心体验

- 用户打字停顿 ~300ms 后自动触发（不打断输入节奏）
- 灰色幽灵文本显示在光标后方
- Tab 接受当前建议；Esc 或继续打字则忽略
- 支持单行和多行补全（多行时第一行内联，后续行在下方展示）
- 选中代码时可触发"替换建议"（选区 → 灰色替换方案）

## 技术方案

### 1. VS Code API

注册 `InlineCompletionItemProvider`：

```typescript
vscode.languages.registerInlineCompletionItemProvider(
  { pattern: "**" }, // 所有文件类型
  provider
);
```

Provider 的 `provideInlineCompletionItems` 在光标位置变化时被 VS Code 调用。

### 2. 模型选择（建议）

| 场景 | 模型 | 原因 |
|------|------|------|
| 默认补全 | DeepSeek V4 Flash | 延迟低（~200ms）、FIM 原生支持、便宜 |
| 复杂补全（选区替换） | 当前对话模型 | 需要更强的理解能力 |

用 FIM（Fill-in-the-Middle）格式：
```
<|fim_prefix|>{光标前的代码}<|fim_suffix|>{光标后的代码}<|fim_middle|>
```

### 3. 上下文构造

优先级（总 token 预算 ~4K，低延迟优先）：

1. 当前文件光标前 ~80 行（prefix）
2. 当前文件光标后 ~30 行（suffix）
3. 当前文件的 import 区域（让模型知道可用的类型/模块）
4. 最近编辑过的 2~3 个相关文件的签名摘要（可选，增加相关性但加延迟）

### 4. 性能关键设计

| 机制 | 说明 |
|------|------|
| Debounce 300ms | 打字停顿才触发，每个字符不发请求 |
| 请求取消 | 新请求到来时 abort 上一个未完成的请求 |
| 缓存 | 同一光标位置 + 相同前缀文本 → 直接返回缓存结果 |
| 流式首 token | 用流式 API，拿到第一行即可展示，不必等全部生成完 |
| 跳过非代码区域 | 注释内、字符串内、空行连续 3+ 行时不触发 |

### 5. 文件结构

```
apps/vscode-extension/src/
├── inlineCompletion/
│   ├── provider.ts        # InlineCompletionItemProvider 实现
│   ├── context.ts         # 上下文构造（prefix/suffix/imports 提取）
│   ├── fimClient.ts       # FIM 模型调用（流式，支持 abort）
│   ├── cache.ts           # LRU 缓存（按文件路径+光标位置+前缀哈希）
│   └── config.ts          # 配置（模型、debounce 时长、是否启用）
```

### 6. 配置项

```json
{
  "axon.inlineCompletion.enabled": true,
  "axon.inlineCompletion.model": "deepseek-v4-flash",
  "axon.inlineCompletion.debounceMs": 300,
  "axon.inlineCompletion.maxLines": 10,
  "axon.inlineCompletion.triggerOnSelection": true
}
```

### 7. 与 Agent 系统的隔离

- 独立模块，不经过 SessionHub / AgentSession
- 直接调 LLM API（FIM endpoint），不走对话策略
- 独立的 API Key 配置（可复用 provider 配置中的同一 key）
- 不消耗对话 Credits（或单独计费，费率极低）

## 实现步骤

1. 基础骨架：注册 provider + debounce + 空实现（确认 VS Code API 通路）
2. FIM 客户端：对接 DeepSeek FIM API（流式）
3. 上下文构造：prefix/suffix 提取 + token 裁剪
4. 缓存层：LRU + 请求去重/取消
5. 体验打磨：跳过非代码区域、多行展示优化、选区替换模式
6. 配置化：用户可开关、选模型、调延迟

## 不做

- 不做对话式 inline chat（那是另一个功能）
- 不做代码解释/重构建议（留给 Agent 对话）
- 不影响现有 Agent 对话系统的任何行为

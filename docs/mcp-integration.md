# MCP 集成

Axon 的 MCP（Model Context Protocol）集成：让 Agent 连接外部 MCP server、把它们的工具
并入工具集供模型调用。架构与 Skill/Power 对齐，遵循 `@axon/core` 零形态依赖原则。

## 架构分层

| 层 | 位置 | 职责 |
|---|---|---|
| 配置解析 | `core/src/mcp/mcpRegistry.ts` | 聚合三来源 server 配置 → 归一化 `McpServerSpec[]` |
| 运行时抽象 | `core/src/mcp/types.ts` (`McpCapability`) | form-agnostic 接口：syncServers / listTools / callTool |
| 运行时实现 | `host-node/src/mcpClient.ts` (`NodeMcpCapability`) | 官方 SDK 连接（stdio + HTTP/SSE）、生命周期、错误隔离 |
| 编排 | `core/src/agentSession.ts` | 工具暴露、调用路由、审批门 |

## 配置三来源（优先级 user < workspace < power，同 id 后者覆盖）

- 用户级：`~/.axon/settings/mcp.json`
- 工作区级：`<workspace>/.axon/settings/mcp.json`
- Power 内嵌：各启用 Power 的 `mcp.json`

mcp.json 格式（与 Kiro/VS Code 一致）：

```json
{
  "mcpServers": {
    "everything": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-everything"],
      "autoApprove": ["echo", "add"]
    },
    "remote-api": {
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer xxx" }
    }
  }
}
```

- `command`/`args`/`env`：stdio 传输（本地子进程）
- `url`/`headers`：http 传输（先试 Streamable HTTP，失败回退 SSE）
- `disabled: true`：禁用（对 AI 隐身，但保留在管理 UI）
- `autoApprove: ["tool", "*"]`：免人工审批的工具白名单

## 实时性（重要）

**颗粒度 = "下一条用户消息"。** 每次 `handleUserInput` 在调 LLM 前都会重新预取
（`agentSession.ts` 的 prefetch 段）：

- `skillRegistry.buildSkillsPrompt()` —— 重新扫盘
- `powerRegistry.buildPowersPrompt()` —— 重新扫盘
- `prefetchMcpTools()` → `mcpRegistry.resolve()` + `mcp.syncServers()` —— 重新读配置 + 增量连/断 server

三个 registry 的 `discover()`/`resolve()` **每次都真读磁盘，无缓存**。因此：

- 启用/禁用/新增/删除/编辑 Skill / Power / Power 内容 / MCP server → **下一条消息**即生效。
- **旧会话同样生效**：重开旧会话发消息时，预取读的是当前磁盘状态，不是会话保存时的状态。

### 边界：预取是"每条消息一次"，不是"每个内部轮次一次"

AI 正在处理某条消息（多轮工具循环中）时改配置，**本条消息不会感知**——快照在消息开始时
拍定，要等下一条消息才重新读盘。这是有意为之（避免工具集在 AI 执行途中突变）。

### 禁用语义（Skill / MCP / Power 三者一致）

禁用/删除 = **对 AI 彻底隐身**，分两道：

| 组件 | 清单（AI 主动发现） | 加载/调用（AI 凭记忆触发） |
|---|---|---|
| Skill | `buildSkillsPrompt` 过滤禁用 | `SkillRegistry.load()` 拒绝禁用项 |
| Power | `buildPowersPrompt` 过滤禁用 | `PowerRegistry.load()` 拒绝禁用项 |
| MCP | `prefetchMcpTools` 不暴露禁用工具 | `runMcpTool` 在 `mcpToolMap` 找不到 → 拒绝 |

- 禁用的 Power 连带其内嵌的 MCP/Skill 一并失效（`getActiveMcpServers` / `getActiveSkillDirs` 按 `m.enabled` 过滤）。
- 管理 UI 保留禁用项（置灰/删除线，可重新启用）；启用项排前、禁用项沉底。

> ⚠️ LLM 可能从**对话历史**里"记得"之前用过的工具/技能/Power，在其被禁用后仍尝试调用。
> 此时各 `load()` / `runMcpTool` 会返回明确的"不可用（已禁用/移除/未连接）"错误并提示**不要重试**、
> 不要误判为"连接不稳定"。配合 LoopGuard 拦重复调用，不会死循环。
> **新对话里不会发生**（AI 压根不知道禁用项存在）；仅"同对话内 用过→禁用→再调"会触发，已被优雅处理。

### 给 AI 看 vs 给用户看（双文案分离）

MCP 工具结果遵循 `execute_command`/`read_file` 同款分离：

- `result`（进对话历史、给 AI）：详细 + 含行为指令（如"不要重试、不要推测连接不稳定…"）。
- `meta.userMessage`（进 `tool_result` 事件 + 持久化、给前端卡片）：简短（如"该 MCP 工具已被禁用或不可用"）。

两者都持久化，刷新后 AI 读 `content`（完整 result）、用户卡片读 `userMessage`，各看各的、互不串。

## NodeMcpCapability 健壮性要点

- **连接超时** 15s：坏 server 不卡住每轮预取。
- **错误隔离**：单个 server 连接/列举失败只记日志、跳过，不拖垮其它 server 与主流程。
- **Windows 命令解析**：`npx`/`npm`/`pnpm`/`uvx` 等脚本命令自动补 `.cmd` 后缀（spawn 不走 shell）。
- **受控环境变量**：stdio server 只继承安全子集（`getDefaultEnvironment()`）+ spec.env，不泄露全部 env。
- **HTTP 回退**：先 Streamable HTTP，连接失败再回退旧 SSE（兼容只支持 SSE 的旧 server）。

## 管理入口

- **VS Code**：左侧 AXON 面板的 **MCP** 树视图（按 项目/全局/Power 三层级分组），标题栏有
  刷新 / 打开管理 / 批量删除；右键 server 可启用/禁用/删除（Power 内嵌的在对应 Power 里管理）。
  点条目打开全局管理页（`view=mcp`），"在编辑器中打开"用原生编辑器编辑 mcp.json。
- **浏览器**：`?view=mcp`，内嵌 CodeEditor 编辑。
- **Power 内**：PowerStudio 的 MCP Tab，支持"从已有导入"系统级 MCP。

## 配置来源 / 复测

```bash
# 大文件等压测见 docs/large-file-write-strategy.md
# MCP 冒烟测试（stdio 连接 + 列工具 + 调用），临时脚本，跑完即删
```

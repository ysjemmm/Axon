# Axon 开发指南

## 项目结构

```
d:\projects\Axon\                ← monorepo 根目录
├── packages/
│   ├── core/            # @axon/core —— Agent 内核（LLM 策略、工具执行、会话管理）
│   ├── host-node/       # @axon/host-node —— Node.js 宿主实现（文件系统、终端、进程）
│   └── host-vscode/     # @axon/host-vscode —— VS Code 宿主实现（vscode.workspace.fs 等）
├── apps/
│   └── vscode-extension/  # VS Code/axon-ide-shell 扩展（webview + extension host 桥接）
├── web/                 # React 前端 UI（Vite 构建，聊天面板 + 工具卡片 + 编辑器）
├── server/              # Web 形态后端（Express + WebSocket，承载 Agent 内核）
├── cli/                 # 命令行形态
└── test/eval/           # 评估测试
```

## 环境要求

- Node.js >= 20
- pnpm 9.x（`packageManager` 字段锁定）
- Windows 10/11

## 打包流程

> 以下所有命令均以 `d:\projects\Axon` 为根目录描述路径。

### ⚡ 速查：改了什么，要跑什么

**大多数情况下，只需在根目录执行一条命令：**

```bash
pnpm build
```

turbo 会按依赖顺序全量构建：`@axon/core` / `host-node` / `host-vscode` / `server` →
web（`copy-web.mjs`）→ extension（`esbuild.mjs`）。turbo 有缓存，没改到的包会直接命中缓存跳过，
所以增量构建通常只花几秒，不必再去记「改了 X 要跑哪几步」。构建完 Reload Window 即可。

> `axon-ide#build` 在 `turbo.json` 里显式声明了 `dependsOn: [@axon/core#build, @axon/host-vscode#build]`，
> 保证扩展一定在两个依赖包编译完之后才打包——否则 esbuild 会打进旧的 `packages/*/dist`。

如果确实想只构建单块（省那几秒缓存校验），下表是等价的手动步骤：

| 改了哪个目录的代码 | 手动命令（按顺序） | Reload? |
|---|---|---|
| `web/src/` | `node scripts/copy-web.mjs`（在 `apps/vscode-extension/`） | ✅ |
| `apps/vscode-extension/src/` | `node esbuild.mjs`（在 `apps/vscode-extension/`） | ✅ |
| `packages/core/src/` | ① `npx tsc`（在 `packages/core/`）→ ② `node esbuild.mjs`（在 `apps/vscode-extension/`） | ✅ |
| `packages/host-vscode/src/` | ① `npx tsc`（在 `packages/host-vscode/`）→ ② `node esbuild.mjs`（在 `apps/vscode-extension/`） | ✅ |
| `packages/host-node/src/` | ① `npx tsc`（在 `packages/host-node/`）→ ② `node esbuild.mjs`（在 `apps/vscode-extension/`） | ✅ |
| 只改了 `*.json` / `*.css` 等资源 | 不需要构建，直接 Reload | ✅ |

### 为什么改了 packages/* 必须先 tsc？

esbuild 打包 `apps/vscode-extension` 时，`@axon/core` 和 `@axon/host-vscode` 通过 pnpm
workspace symlink 解析到 `packages/core` 和 `packages/host-vscode`。这两个包的
`package.json` 的 `main` 指向 `./dist/index.js`（编译产物），不是 `src/*.ts` 源码。

所以 esbuild 打进 `dist/extension.js` 的是 `packages/*/dist/*.js` 的内容。
如果只改了 `src/*.ts` 没跑 `tsc`，esbuild 打的仍然是旧 dist——改了等于没改。

### 常用开发命令

| 命令 | 执行目录 | 说明 |
|------|----------|------|
| `npm run dev` | `web/` | 启动前端 Vite dev server（HMR） |
| `npm run dev` | `server/` | 启动后端开发模式（nodemon） |
| `node esbuild.mjs --watch` | `apps/vscode-extension/` | 扩展增量打包（watch 模式） |
| `pnpm lint` | 根目录 | 全项目 lint |
| `pnpm typecheck` | 根目录 | 全项目类型检查 |

### IDE 形态（axon-ide-shell）部署

1. 打包 web：在 `d:\projects\Axon\web` 执行 `npm run build`
2. 拷贝 web 产物到扩展：在 `d:\projects\Axon\apps\vscode-extension` 执行 `node scripts/copy-web.mjs --no-build`
3. 打包扩展：在 `d:\projects\Axon\apps\vscode-extension` 执行 `node esbuild.mjs`
4. Reload Window

> 也可一步到位：在 `d:\projects\Axon\apps\vscode-extension` 执行 `node scripts/copy-web.mjs`（不加 `--no-build`），会自动构建 web 再拷贝。

### Web 形态部署

1. 打包 web：在 `d:\projects\Axon\web` 执行 `npm run build`
2. 打包 server：在 `d:\projects\Axon\server` 执行 `npm run build`
3. 启动：在 `d:\projects\Axon\server` 执行 `node dist/index.js`

## 核心架构

### 两层抽象

`@axon/core` 不直接依赖 Node.js / VS Code API / 浏览器 API，而是通过两个抽象接口与外界交互：

```
┌──────────────────────────────────────────────────┐
│  @axon/core（纯逻辑，零形态依赖）                    │
│  AgentSession · LLM 策略 · 工具执行 · Relay · Skills │
└────────────┬──────────────────────┬───────────────┘
             │ AgentHost (①)        │ AgentChannel (②)
             ▼                      ▼
┌────────────────────┐  ┌──────────────────────────┐
│ @axon/host-node     │  │ WebSocket / VS Code       │
│ @axon/host-vscode   │  │ webview postMessage       │
│                    │  │                          │
│ "Agent 的双手"      │  │ "Agent 的嘴"              │
│ 文件 · 命令 · 进程  │  │ 流式输出 · 工具卡片 · 事件 │
└────────────────────┘  └──────────────────────────┘
```

- **AgentHost（①）**：决定"谁来动"——文件读写、命令执行、进程管理、诊断、搜索。两种实现：`@axon/host-node`（Web/CLI/Server 形态）和 `@axon/host-vscode`（Code OSS 内置扩展形态）
- **AgentChannel（②）**：决定"怎么呈现"——流式文本、工具调用卡片、错误提示的传输通道。Web 形态走 WebSocket，VS Code 形态走 `postMessage`

### @axon/core 核心模块

| 模块 | 路径 | 职责 |
|------|------|------|
| `agentSession.ts` | `src/agentSession.ts` | Agent 会话主控：工具调度、轮次编排、状态管理（会话入口） |
| `systemPrompt.ts` | `src/systemPrompt.ts` | 系统提示定义（行为规则、格式约束、工具说明） |
| `session/` | `src/session/` | 工具执行链：`ToolCallExecutor` 分发 → `GenericToolExecutor` 通用执行 → `ToolOutcomeStateResolver` 结果解析 |
| `tools/` | `src/tools/` | 工具定义（JSON Schema）+ 执行实现（`execute.ts`）+ 搜索/修补/安全校验 |
| `llm/` | `src/llm/` | LLM 交互层：Chat Completions / Responses 两种 API 策略、流式处理、工具调用状态机 |
| `host/` | `src/host/` | AgentHost 接口定义：`fs` / `commands` / `processes` / `diagnostics` / `edits` / `search` / `browser` / `webBrowser` / `ideContext` |
| `channel/` | `src/channel/` | AgentChannel 事件类型定义（`stream_delta` / `tool_call` / `tool_result` 等） |
| `relay/` | `src/relay/` | Relay 长任务工作流：需求→设计→计划→执行→评审 |
| `skills/` | `src/skills/` | 技能系统（子 Agent 运行器、Power 加载） |
| `snapshot/` | `src/snapshot/` | 文件快照：写文件前自动备份，支持回滚 |
| `mcp/` | `src/mcp/` | MCP（Model Context Protocol）集成 |
| `powers/` | `src/powers/` | Power 能力包系统 |
| `storage/` | `src/storage/` | 持久化会话数据 |
| `compactor.ts` | `src/compactor.ts` | 上下文压缩：当对话历史超长时自动摘要旧内容 |
| `agentGuards.ts` | `src/agentGuards.ts` | 安全护栏：循环检测、重复调用拦截、文件读取去重提示 |

### 工具分派链路

```
ToolCallExecutor.dispatchToolCall()
    │ 按工具类型路由 (toolDispatchRouter)
    ├── delegate_task / parallel_research / parallel_execute
    │   └── DelegatedToolExecutor  →  子 Agent 隔离执行
    ├── relay_*
    │   └── RelayToolExecutor  →  Relay 工作流
    ├── execute_command
    │   └── CommandToolExecutor  →  信任门 → 终端执行
    ├── mcp__*
    │   └── McpToolExecutor  →  MCP 服务器
    └── 其余通用工具 (read_file / search / str_replace / ...)
        └── GenericToolExecutor  →  executeToolCall()
```

### 改动文件追踪 → 自动诊断

AI 每次执行写文件工具（`str_replace` / `create_file` / `apply_patch`）后，系统自动将文件路径加入 `aiTouchedFilesNeedingDiagnostics` 集合。当 AI 调用 `check_diagnostics` 时：

1. 先按集合过滤（已诊断且未再改动过的文件跳过）
2. 诊断通过的文件从集合中移除
3. 集合为空时后续 `check_diagnostics` 调用直接跳过，避免无意义诊断

## 开发工作流

### 日常开发循环

最常用的场景：改 `packages/core` 代码 → 在 IDE 形态中验证。

```bash
# 终端 1：packages/core 的 tsc watch（修改后自动编译 dist）
cd d:\projects\Axon\packages\core
npx tsc --watch

# 终端 2：扩展 esbuild watch（增量打包）
cd d:\projects\Axon\apps\vscode-extension
node esbuild.mjs --watch

# VS Code：Reload Window 加载新扩展
```

改完代码 → tsc 自动编译 → esbuild watch 自动重打包 → F5 或 Reload Window 即可看到效果。

### 前端调试

如果只改 `web/src/`，不需要 tsc watch：

```bash
# 先拷贝 web 产物（一次性）
cd d:\projects\Axon\apps\vscode-extension
node scripts/copy-web.mjs
node esbuild.mjs

# 后续改 web 代码只需重复：
node scripts/copy-web.mjs   # 拷贝最新 web 产物
# → Reload Window
```

## 测试

### 运行测试

| 命令 | 目录 | 说明 |
|------|------|------|
| `npm test` | `packages/core/` | 运行 @axon/core 全部测试（vitest） |
| `npm run test:watch` | `packages/core/` | watch 模式（边改边跑） |
| `pnpm test` | 根目录 | 全 monorepo 测试（turbo 编排） |

### 测试框架

- **vitest**：单元测试框架，`packages/core` 使用
- 测试文件与源码同目录，命名 `*.test.ts`
- 测试覆盖的关键模块：`session/`（工具执行链）、`llm/`（LLM 交互策略）、`relay/`（工作流）

## 技术栈

- **前端**：React 19 + Vite 8 + Tailwind CSS 4 + react-virtuoso（虚拟列表）
- **后端**：Node.js + Express + WebSocket
- **LLM**：OpenAI Chat Completions API / Responses API，支持多模型切换
- **打包**：Turborepo（monorepo 编排）+ Vite（web）+ esbuild（extension）
- **类型**：TypeScript 6.x（web）/ 5.x（packages/server）
- **测试**：vitest

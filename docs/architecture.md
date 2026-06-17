# Axon 架构：同一 Agent 内核驱动 Web 与 Code OSS 两种形态

> 目标：把 Axon 升级为**带品牌的 AI IDE**（基于 fork 的 Code OSS，方案 C），
> 同时**完整保留 Web 端能力**。通过两层抽象让同一份 Agent 内核服务多种形态。

## 决策基线

| 维度 | 决策 |
|------|------|
| IDE 形态 | fork Code OSS 做**带品牌发行版**，深度定制 workbench 默认布局 |
| 进程模型 | **进程内（Kiro 模式）**：Agent 内核跑在 Extension Host，`import @axon/core`，无 WS、无中间 server |
| 改动呈现 | **原生 diff**：`WorkspaceEdit` + 原生 diff 编辑器 + SCM |
| Monorepo | **pnpm workspace + Turborepo** |
| Web 形态 | 独立保留：`NodeAgentHost` + `WsChannel` + Express，行为零回归 |

## 两层抽象

内核 `@axon/core` 零形态依赖，只面向两个注入的抽象编程：

### ① AgentHost（执行端 / Agent 的“手”）

决定“谁来动文件、跑命令、做诊断、呈现改动、感知 IDE”。

| 能力域 | NodeAgentHost | VSCodeAgentHost |
|--------|---------------|-----------------|
| `fs` | `node:fs/promises` | `vscode.workspace.fs` |
| `commands` | `exec` + PowerShell UTF-8 包装 | 集成终端 / child_process |
| `diagnostics` | `tsc --noEmit` | `vscode.languages.getDiagnostics`（实时、全语言） |
| `browser` | `NodeDirectoryBrowser` | 基于 workspace.fs（或进程内沿用 Node） |
| `edits` | 暂存区（auto 写盘 / manual 内存待确认） | `WorkspaceEdit` + 原生 diff + SCM |
| `ideContext` | 不提供 | 活动文件 / 选区 / openFiles / gitDiff |

### ② AgentChannel（呈现端 / Agent 的“嘴和耳”）

决定“事件往哪送、控制指令从哪来”。出站 `AgentEvent`、入站 `ControlCommand`。

| 适配实现 | 出站 | 入站 |
|----------|------|------|
| `WsChannel`（web） | `ws.send(JSON)` | `ws.on("message")` |
| `VSCodeChannel`（IDE） | `webview.postMessage` | `webview.onDidReceiveMessage` |
| `CliChannel`（终端） | stdout | stdin |

事件/指令字段严格对齐现有 WS 协议 → **web 端无需改动**。

## 目录结构

```
Axon/
├─ pnpm-workspace.yaml / turbo.json / package.json   根工作区
├─ packages/
│  ├─ core/          @axon/core —— 内核 + 两层抽象契约（host/ channel/）
│  ├─ host-node/     @axon/host-node —— NodeAgentHost
│  └─ host-vscode/   @axon/host-vscode —— VSCodeAgentHost
├─ apps/             （阶段 0 尾声平移）server / web / cli / vscode-extension
└─ code-oss/         （阶段 4）fork 的品牌化 Code OSS
```

依赖方向（单向，无环）：`host-node / host-vscode → core`；各 app → core + 对应 host。

## 落地阶段

- **阶段 0（已完成）**：monorepo 骨架（pnpm + turbo + TS references）+ 两层抽象契约。
  三包（core / host-node / host-vscode）全量 `pnpm build` 通过。
- **阶段 1（进行中）**：内核迁入 core，`node:fs/exec/tsc` 改走 `host.*`，`send → channel.emit`；
  抽 `SessionHub`（会话生命周期与传输解耦）；cli 删副本改用 core；server 接 `WsChannel` 验证 web 不回归。
  - [x] `NodeAgentHost` 全 5 能力域实现（fs/commands/diagnostics/browser/edits）并通过类型校验
  - [x] 接口修正：`readdir` 返回 `DirChild`（带 isFile/isDir），支撑 tools 递归遍历
  - [x] `tools` 迁入 core：`definitions`(纯) / `safety`(纯) / `search`(host.fs) / `execute`(host.*)
        —— `executeToolCall` 新签名以 `AgentHost` 替代直接 node 调用与 `EditContext`
  - [x] web 能力（webSearch/webFetch）经 `WebCapability` 注入参数解耦（webSearch.ts 暂不迁）
  - [x] 纯逻辑/数据模块迁入 core：`agentGuards / compactor / messageSanitizer / llm/*（types/modelContext/chatCompletionsStrategy/responsesStrategy）/ relay/types / relay/planParser / storage/types`
  - [x] skills 运行时迁入 core：`skillLoader / builtinSkills / subAgentRunner`（已 host 化）
        —— `SkillRegistry(workspaces, host, homeDir)`；subAgentRunner 删 editCtx、`SubAgentDeps` 加 `host`/`web`
        —— `skillFiles / skillService / skillRoutes` 依赖 express，留 server，不进 core
  - [x] relay 运行时迁入 core：`relayStore`(host.fs) / `reviewAgent` / `parallelResearch`
        —— `RelayStore(workspace, host)`；review/research 的 deps 加 `host`/`web`
  - [x] `HostFileSystem` 按需新增 `remove`（rm -rf 语义），host-node 已实现
  - [x] `AgentSession` 迁入 core：`this.send → channel.emit`（单点改造，30+ 调用点未动）、
        `editCtx → host.edits`、构造注入 `channel`/`host`/`homeDir`/`web`；`this.ws`/`editCtx`/`pendingEdits` 全移除
  - [x] `systemPrompt` / `providers` 迁入 core（providers 依赖 process.env，跨形态通用）
  - [x] 子 agent host 派生：`EditPresenter.fork(mode)` + `deriveSubAgentHost()`，三处派发各造独立 auto host
  - [x] 抽 `SessionHub`（迁自 index.ts 的 ws.on("message") 11 个分支）：消费 `ControlCommand`、
        经 `AgentChannel` 产出事件；server 能力（storage/目录校验/工作区组/host 工厂/web）经 `SessionHubDeps` 注入
  - [x] `apps/server`：建 `WsChannel`，用 `SessionHub` + `createNodeAgentHost` 替换 server 内核副本；
        REST 路由/WS 鉴权留 server。删除 server 的 20 个内核副本文件，改 import `@axon/core`
        —— WS connection 回调从 ~300 行手写分支收敛为 `new WsChannel + new SessionHub + hub.dispatch`
        —— skillFiles/skillService 构造 SkillRegistry 补 `createNodeAgentHost()`+`homedir()`；REST 的 RelayStore 补 host
  - [x] 验收：全量 `pnpm build` 4 包全绿；server 实际启动正常；WS 端到端链路验证通过
        （连接→SessionHub→会话创建→策略选择 chat/responses 两分支→发起 API；
        对话挂起仅因测试环境到内网 LLM 网关 ai-router.timevale.cn 不可达，非代码回归）
  - [ ] cli 删 tools 副本改用 core（cli 是独立 agent loop，可选项，不阻塞 server/web 形态）

### 阶段 1 实质完成 ✅
内核 100% 迁入 core 并 host/channel 化；server 接入 core 跑通，WS 协议零改动、web 端零回归。
cli 的内核统一留作收尾项（cli 有独立实现，不影响主线）。下一步可进入【阶段 2：vscode-extension】。

### 子 agent host 派生约定（减少返工的关键决策）
主 AgentSession 用 manual 模式的 `EditPresenter`（暂存待确认）；子 agent（delegate/research/review）
必须用【独立的 auto 模式 host】——fs/commands/diagnostics 可共享，但 `edits` 必须是独立实例
（否则子 agent 的落盘会污染主 agent 的暂存区）。约定：host-node 提供 `createNodeAgentHost()`
每次返回全新实例；子 agent 由父 AgentSession 调用工厂另造一个 auto host 注入。
- **阶段 2（代码就绪，待宿主验收）**：`apps/vscode-extension` 在标准 VS Code 形态的全部代码已写完并编译通过。
  - [x] `VSCodeAgentHost` 六能力域：`fs`(workspace.fs) / `commands`(child_process) /
        `diagnostics`(languages.getDiagnostics，实时全语言) / `browser`(workspace.fs) /
        `edits`(阶段2基础版：auto写盘+manual暂存) / `ideContext`(activeEditor/tabGroups/gitDiff)
  - [x] `VSCodeChannel`：AgentEvent → webview.postMessage（与 server WsChannel 对称）
  - [x] 扩展入口 `extension.ts`：注册 webview view + SessionHub(VSCodeAgentHost) + dispatch 桥接
  - [x] `AxonViewProvider`：webview 视图（阶段2占位页，链路已通；2.1 接 web 构建产物）
  - [x] `JsonFileStorage` 迁入 host-node（server 与扩展共用，DRY）
  - [x] `webSearch/webFetch` 迁入 core（跨形态，形状即 WebCapability；server/扩展共用）
  - [x] esbuild 把 ESM core 依赖树 bundle 成 CJS `dist/extension.js`（vscode external）
  - [x] 全量 `pnpm build` 5 包全绿
  - [ ] 运行验收：需 VS Code/Code OSS 宿主（用户暂无，按选项 A 延后到阶段 4 一并验）
  - [x] 阶段 2.1：webview 加载真实 React UI（替换占位页）
        —— 前端加 `lib/transport.ts`：浏览器=fetch+WebSocket / webview=postMessage（带 requestId 配对）
        —— `apiClient`/`useWebSocket` 改走 transport，**业务组件零改动**；web vite build 通过（浏览器零回归）
        —— 扩展加 `RequestRouter`：webview 形态下响应 REST（sessions/fs/relays...），对称于 server Express
        —— `viewProvider` 加载 web 构建产物（资源 URI 改写 + CSP 注入），入站分流 REST/ControlCommand
        —— web 支持相对基址（`AXON_WEB_BASE=./`）；`build:web` 脚本一键构建+拷贝到 `media/web/`
- **阶段 3（核心完成）**：原生体验与 IDE 上下文。
  - [x] `ideContext` 注入 prompt：AgentSession 每轮预取 host.ideContext（活动文件/选区/选中文本/
        其它打开文件/git diff），拼成「IDE 上下文」system 注入；非 IDE 形态（host.ideContext 为空）跳过。
        让 Agent 理解"这个文件/这里/选中的"等指代——品牌 AI IDE 原生感的关键。
  - [x] `EditPresenter` 原生 diff：host-vscode 新增 `PendingDiffPresenter`（注册 axon-pending:
        虚拟文档 provider）。manual 模式 present 时打开 VS Code 原生 diff（左=磁盘原内容，右=待确认
        新内容），accept 落盘+关闭、reject 丢弃+关闭。子 Agent(auto) fork 出的实例禁用 diff，不污染视图。
  - [ ] `RequestRouter` 补齐 skills/workspace-groups 完整实现（当前返回空，UI 不崩；留作后续小项）
  - [ ] 运行验收：需 IDE 宿主（延后到阶段 4）
- **阶段 4（最后）**：fork Code OSS 品牌化（product.json / 内置视图 / 打包签名 / 更新通道）。

## 待定（不阻塞阶段 0–3）

1. 品牌信息：发行版产品名、图标/配色资产、首发平台。
2. Code OSS fork 基线版本（最新 stable / 锁定 tag），决定 merge 上游节奏。

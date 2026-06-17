# Axon 开发指南

新会话/换机后继续开发，照这份走。

## 1. 两个仓库的关系（重要）

开发涉及两个独立目录：

| 目录 | 是什么 |
|------|--------|
| `d:\projects\Axon` | Axon monorepo（Agent 内核 + 扩展源码 + web UI）。**所有代码改这里** |
| `d:\projects\axon-ide-shell` | fork 的 Code OSS（VS Code 开源内核），实际运行的 IDE |

### 软硬链接（关键，别踩坑）

`axon-ide-shell` 通过链接复用 Axon 的代码，**不是拷贝**：

1. **扩展源码（硬链接）**：`axon-ide-shell\extensions\axon-ide\src\*.ts`
   与 `d:\projects\Axon\apps\vscode-extension\src\*.ts` 是**硬链接**（同一份文件 inode）。
   → 改 Axon 的扩展源码 = 自动同步到 fork，无需手动拷贝。

2. **内核包（junction 目录联接）**：`axon-ide-shell\extensions\axon-ide\node_modules\@axon\{core,host-node,host-vscode}`
   是 **junction**，指向 `d:\projects\Axon\packages\*`。
   → 改 `@axon/*` 包源码后，需要先 `pnpm build` 编译出 dist，junction 才能读到最新产物。

3. **media/web（实拷贝）**：fork 的 `extensions\axon-ide\media\web` 是 web 产物的**实际拷贝**，
   不是链接。→ 改了 web 必须手动拷过去（见下方流程）。

⚠️ junction/硬链接**不要提交 git**（确认在 fork 的 `.gitignore` 里）。
⚠️ 发行打包前必须把链接换成实拷贝（见 `stage4-code-oss-branding.md`）。

## 2. 需要常驻的 watch（Code OSS 主体）

改 fork 的 workbench 源码（`axon-ide-shell\src`）才需要这两个 watch。
**只改 Axon 扩展/内核时不需要**（那走下方的手动 build 流程）。

```powershell
# 终端 A：转译 src/*.ts → out/*.js
cd d:\projects\axon-ide-shell
nvm use 24.15.0
npm run watch-client-transpile

# 终端 B：打包 / CSS / 类型检查
cd d:\projects\axon-ide-shell
npm run watch-client
```

⚠️ **不要用 `npm run watch`**——它并行起 4 个任务，其中 `watch-copilot` 在本机会崩并拖垮整组。
只起上面两个，`watch-copilot` 的报错忽略。

- `watch-client-transpile` 首次全量转译约 15s，看到 `Finished transpilation with 0 errors` + `[watch] Watching ...` 即就绪
- 之后改 `src/` 下 `.ts` 自动增量转译，两个终端保持开着

## 3. Axon monorepo 的目录结构

```
d:\projects\Axon\
├── packages/
│   ├── core/          @axon/core —— Agent 内核（与形态无关）
│   │                  agent loop、tools、relay、skills、credits、systemPrompt、
│   │                  LLM 策略（responses/chat）、session 编排（SessionHub）
│   │                  只依赖 AgentHost + AgentChannel 两层抽象，零形态依赖
│   ├── host-node/     @axon/host-node —— Node 形态的 AgentHost 实现
│   │                  fs/commands/diagnostics 用 child_process + node fs；JsonFileStorage
│   └── host-vscode/   @axon/host-vscode —— VS Code 形态的 AgentHost 实现
│                      fs 用 vscode.workspace.fs；commands 用集成终端；diagnostics 用 vscode API
├── apps/
│   └── vscode-extension/   axon-ide 扩展（进程内 IDE 形态）
│                           extension.ts 入口、viewProvider（侧栏 webview）、
│                           treeViews（Relay/Skills/Provider）、esbuild 打包
├── web/               React 前端 UI（ChatPanel/ToolCallItem/ModelSelector 等）
│                      Web 形态和 IDE webview 共用这一份；vite 构建
├── server/            Web 形态后端（Express + WS），用 host-node
├── cli/               命令行形态
└── docs/              文档
```

### 形态对称关系

| 形态 | 通道 | Host | 前端 |
|------|------|------|------|
| Web（server） | WsChannel | NodeAgentHost | 浏览器加载 web |
| IDE（扩展） | VSCodeChannel | VSCodeAgentHost | 侧栏 webview 加载 web |

同一套 `@axon/core`（含 SessionHub）驱动两种形态，差异全在 channel + host 注入。

## 4. 基本开发流程

### 改了 Axon 扩展源码 或 @axon/* 内核包

```powershell
# 1. 在 Axon 编译（core/host/扩展全量）
cd d:\projects\Axon
pnpm run build

# 2. 重新打包 fork 的扩展（把最新 @axon/* bundle 进 extension.js）
cd d:\projects\axon-ide-shell\extensions\axon-ide
node esbuild.mjs

# 3. 完全退出 Electron 重启（不是 Ctrl+R！）
cd d:\projects\axon-ide-shell
.\scripts\code.bat
```

### 改了 web 前端

```powershell
# 1. 构建 web
cd d:\projects\Axon\web
pnpm run build

# 2. 拷贝产物到 fork 的 media（实拷贝，必须手动）
cd d:\projects\axon-ide-shell\extensions\axon-ide
cmd /c "rmdir /s /q media\web & xcopy /e /i /y /q d:\projects\Axon\web\dist media\web"

# 3. 重启 IDE（webview 改动 Ctrl+R 重载窗口通常够，保险起见完全重启）
```

### 改了 fork 的 workbench 源码（axon-ide-shell\src）

watch 已自动转译 → **完全退出 Electron 重启**（`Ctrl+R` 不重新加载 product.json/源码）。

## 5. 启动 IDE

```powershell
cd d:\projects\axon-ide-shell
nvm use 24.15.0
.\scripts\code.bat
```

环境变量 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` 已设为用户级。
⚠️ 如果跑 `code.bat` 时 Electron 下载龟速（几百秒 ETA），说明当前终端没读到该变量——
新开终端，或临时设置：`$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"`。

## 6. 几个容易忘的点

- **改 core/扩展 → 必须 `node esbuild.mjs` 重新 bundle**，否则跑的是旧产物（硬链接只同步源码，不会自动编译）
- **改 product.json / 默认配置 → 必须完全退出 Electron**，`Ctrl+R` 不重读
- **改 web → 必须手动拷 media/web**（不是链接）
- **验证产物是否更新**：`cmd /c "dir extensions\axon-ide\media\web\assets\index-*.js /b"` 看 hash 是否变了
- Node 必须 24.15.0（`.nvmrc`），用 22 编不过 Code OSS 主体

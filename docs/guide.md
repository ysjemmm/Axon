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

### 全量打包（turbo 并行）

```bash
# 在 d:\projects\Axon 根目录执行
pnpm build
```

turbo 会按依赖顺序构建所有包：`packages/*` → `web` → `apps/vscode-extension`。

### 单独打包各模块

#### 1. Web 前端（React + Vite）

```bash
# 在 d:\projects\Axon\web 目录执行
npm run build
```

执行 `tsc -b && vite build`，输出到 `web/dist/`。

#### 2. VS Code 扩展（esbuild）

```bash
# 在 d:\projects\Axon\apps\vscode-extension 目录执行
node esbuild.mjs
```

将 `@axon/core` + `@axon/host-vscode` + 扩展入口打包为单文件 CJS `dist/extension.js`。

打 vsix 安装包：

```bash
# 在 d:\projects\Axon\apps\vscode-extension 目录执行
npx @vscode/vsce package --no-dependencies
```

产出 `axon-ide.vsix`，可直接安装到 VS Code 或 axon-ide-shell。

#### 3. Server 后端

```bash
# 在 d:\projects\Axon\server 目录执行
npm run build
```

TypeScript 编译到 `server/dist/`。

#### 4. Core 包

```bash
# 在 d:\projects\Axon\packages\core 目录执行
npx tsc
```

输出到 `packages/core/dist/`。

> **重要**：修改 `packages/core/src/` 下的任何文件后，必须先执行 `npx tsc` 编译 core，
> 再执行 `node esbuild.mjs` 打包扩展——因为扩展打包读的是 `core/dist/`（编译产物）而非源码。

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

## 技术栈

- **前端**：React 19 + Vite 8 + Tailwind CSS 4 + react-virtuoso（虚拟列表）
- **后端**：Node.js + Express + WebSocket
- **LLM**：OpenAI Chat Completions API / Responses API，支持多模型切换
- **打包**：Turborepo（monorepo 编排）+ Vite（web）+ esbuild（extension）
- **类型**：TypeScript 6.x（web）/ 5.x（packages/server）

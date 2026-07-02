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

| 改了哪个目录的代码 | 必须执行的命令（按顺序） | Reload? |
|---|---|---|
| `web/src/` | `node scripts/copy-web.mjs`（在 `apps/vscode-extension/`） | ✅ |
| `apps/vscode-extension/src/` | `node esbuild.mjs`（在 `apps/vscode-extension/`） | ✅ |
| `packages/core/src/` | ① `npx tsc`（在 `packages/core/`）→ ② `node esbuild.mjs`（在 `apps/vscode-extension/`） | ✅ |
| `packages/host-vscode/src/` | ① `npx tsc`（在 `packages/host-vscode/`）→ ② `node esbuild.mjs`（在 `apps/vscode-extension/`） | ✅ |
| `packages/host-node/src/` | ① `npx tsc`（在 `packages/host-node/`）→ ② `node esbuild.mjs`（在 `apps/vscode-extension/`） | ✅ |
| 同时改了 core + web | ① 编 core → ② 编 host-vscode（如改了）→ ③ `node scripts/copy-web.mjs` → ④ `node esbuild.mjs` | ✅ |
| 只改了 `*.json` / `*.css` 等资源 | 不需要构建，直接 Reload | ✅ |

> **最省事的一键全量构建**（不关心改了哪里时用）：在根目录执行 `pnpm build`，
> turbo 会按依赖顺序编译所有 packages → web → extension。但速度较慢（~30s）。

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

## 技术栈

- **前端**：React 19 + Vite 8 + Tailwind CSS 4 + react-virtuoso（虚拟列表）
- **后端**：Node.js + Express + WebSocket
- **LLM**：OpenAI Chat Completions API / Responses API，支持多模型切换
- **打包**：Turborepo（monorepo 编排）+ Vite（web）+ esbuild（extension）
- **类型**：TypeScript 6.x（web）/ 5.x（packages/server）

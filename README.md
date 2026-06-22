# Axon

AI 编程助手，作为 VS Code 扩展运行。内置 Agent 内核，能直接读写文件、搜索代码、执行命令、操作浏览器，深度集成编辑器上下文——光标停在哪、选中了什么、终端报了什么错，AI 自己就知道。

## 为什么做这个

市面上的 AI 编程工具用了一圈，总觉得差点意思：代码的安全感、配置的复杂度、模型的自由度、跟编辑器的集成深度——没有一个能同时做好。于是干脆自己做了一个，把这些问题一次性焊死在底层。

## 特性

- **Agent 进程内运行** —— 工具调用走函数调用而非网络往返，读写文件、执行命令几乎零延迟
- **深度感知编辑器上下文** —— 光标位置、选中文本、终端错误、诊断信息，AI 自动感知，不用复制粘贴
- **内置浏览器自动化** —— 前端改完代码，AI 自己打开浏览器截图确认、抓控制台报错、模拟用户操作
- **自由接入任意模型** —— 内置智谱免费模型开箱即用，支持接入任何兼容 OpenAI 协议的 provider
- **Relay 长任务工作流** —— 大任务自动拆成 需求→设计→计划→执行→交付 五步，每步有确认点，质量靠流程兜底
- **多层扩展体系** —— Skill（做事方法）、Power（能力包）、MCP（外部系统接入），能力边界由你决定
- **智能代码补全** —— 替代 Copilot 的内联补全，自动感知上下文
- **命令安全** —— 危险操作需人工确认，支持白名单信任机制

## 快速开始

### 安装

从 [VS Code Marketplace](https://marketplace.visualstudio.com/) 搜索 "Axon" 安装，或从 [Releases](https://github.com/ysjemmm/Axon/releases) 下载 `.vsix` 手动安装。

### 使用

1. 打开 VS Code，点击侧边栏 Axon 图标
2. 按 `Ctrl+Shift+L`（或 `Cmd+Shift+L`）打开对话面板
3. 直接输入问题，回车

内置智谱免费模型开箱即用。想用自己的 Key，打开 Provider 配置面板填入即可。

### 从源码构建

```bash
# 要求 Node >= 20，pnpm 9.x
pnpm install

# 编译 core 包
cd packages/core && npx tsc && cd ../..

# 打包 web 前端
cd web && npm run build && cd ..

# 打包 VS Code 扩展
cd apps/vscode-extension
node scripts/copy-web.mjs --no-build
node esbuild.mjs
```

产物在 `apps/vscode-extension/dist/extension.js`。

## 项目结构

```
Axon/
├── apps/vscode-extension/   # VS Code 扩展入口
│   └── src/
│       ├── extension.ts     # 扩展激活、命令注册、生命周期
│       ├── viewProvider.ts  # Webview 通信桥接
│       ├── agentManager.ts  # Agent 实例管理
│       ├── inlineCompletion.ts  # 内联补全 Provider
│       └── proactive/       # 主动感知（终端错误/诊断变化通知）
├── server/                  # WebSocket 服务端（Agent 运行时）
│   └── src/
│       ├── index.ts         # 服务入口、请求路由
│       ├── providers/       # Provider 配置接口
│       └── skills/          # Skill 服务（创建、导入、生成）
├── web/                     # React 前端 UI
│   └── src/
│       ├── App.tsx          # 应用入口、路由
│       └── components/      # 核心组件
│           ├── ChatView.tsx         # 对话面板
│           ├── ModelSelector.tsx    # 模型选择器
│           ├── ProviderStudio.tsx   # Provider 配置面板
│           ├── RelayDashboard.tsx   # Relay 工作流面板
│           └── ...
├── packages/
│   ├── core/                # 核心库（零 UI 依赖）
│   │   └── src/
│   │       ├── agentSession.ts     # Agent 会话核心
│   │       ├── providers.ts        # Provider 路由/策略
│   │       ├── providerCatalog.ts  # 内置 Provider 目录
│   │       ├── providerRegistry.ts # Provider 注册与合并
│   │       ├── providerTypes.ts    # Provider 数据模型
│   │       └── session/            # 会话持久化
│   └── host-node/           # Node 运行时适配（文件系统、命令执行）
├── docs/                    # 文档
├── test/                    # 测试与评估
└── .github/workflows/       # CI 流水线
```

## 技术栈

| 层 | 技术 |
|---|------|
| 扩展宿主 | VS Code Extension API |
| Agent 服务 | TypeScript + Express + WebSocket |
| 前端 UI | React 19 + Vite + Tailwind CSS + shadcn/ui |
| 核心库 | TypeScript（零运行时依赖） |
| 代码渲染 | Monaco Editor + highlight.js + KaTeX |
| 包管理 | pnpm + Turborepo |

## License

MIT

---

<p align="center">
  <sub>一个人维护的项目，有问题或建议直接提 <a href="https://github.com/ysjemmm/Axon/issues">Issue</a>。</sub>
</p>

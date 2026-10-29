# Axon

Axon 是 [Axon IDE](https://github.com/ysjemmm/Axon-IDE) 的 Agent 内核仓库：一套 TypeScript 写的 Agent 引擎，加上把它装进不同"外壳"的宿主实现与界面。

- **在 IDE 里**：作为 VS Code 扩展跑在 Extension Host 进程内，读写文件、执行命令、看诊断、开浏览器都是本地函数调用。
- **在浏览器里**：同一个内核跑在 Node 服务端，界面通过 WebSocket 连接。
- **在终端里**：命令行形态，适合脚本化调用与评测。

想直接用，去 [Axon IDE Releases](https://github.com/ysjemmm/Axon-IDE/releases) 下载安装包；这个仓库是给想改内核、加工具、接新宿主的人看的。

---

## 能做什么

一套内核，三种工作模式：

| 模式 | 面向 | 典型用法 |
|---|---|---|
| **Chat** | 提问与讨论 | 方案讨论、信息整理；交付 HTML / SVG 产物，渲染 GIF / MP4 动画 |
| **Code** | 开发 | 检索代码、改文件、跑命令与后台进程、开浏览器验证、内联补全 |
| **Cowork** | 办公文档 | Excel / Word / PDF / CSV：选文件、定产出位置、看进展、预览结果；内置财务、会计、客服、面试官、HR 等 17 个流程模板，也能用一句话描述创建自己的流程 |

主要能力：

- **任意模型**：OpenAI 兼容接口（Chat Completions / Responses）与 Anthropic Messages 协议；内置 DeepSeek、Kimi、智谱、通义千问、豆包、硅基流动、OpenAI、Claude、Gemini、OpenRouter、Ollama 等近 20 家厂商预设；自动识别 thinking / 视觉能力，Anthropic 与支持的接口自动打提示词缓存断点。
- **用量与花费**：按厂商模板或自定义规则查询余额 / 额度，每轮回复显示 token 或估算花费。
- **权限模式**：安全（逐条审批）/ 自动 / 完全访问三档；命令先过信任规则与语法预检（没写完的命令不会发到终端里卡住）。
- **长任务**：后台 Agent 任务、后台进程与完成通知、子 Agent 并行（`delegate_task`）、Relay 分阶段工作流、任务清单（`update_tasks`）、无感上下文压缩。
- **可回滚**：每轮改动自动落 git 快照，按会话隔离；Cowork 动过的文件保留原稿。
- **扩展**：Skills（内置头脑风暴、系统化调试、资深工程实践、代码质量、代码复用、前端设计 6 个方法论）、Powers 能力包（内置 Excel / Word / PDF 处理）、MCP（含远程服务的浏览器授权）、Marketplace 源。
- **连接器**：GitHub、GitLab、飞书、Notion、Slack、PostgreSQL、邮箱（Gmail / QQ / 163 / 企业邮箱，IMAP / SMTP），以及自定义 MCP；GitHub 支持设备码一键登录。
- **项目 Wiki**：把项目生成 Wiki 落到 `.axon/wiki/`，随 git 共享；内容指纹判断过期，写入前扫描防止泄露密钥。
- **语音输入**（IDE）：扩展进程录音（Windows 零依赖），交给所选 Provider 的 `/audio/transcriptions` 转文字；推荐硅基流动的免费模型 SenseVoiceSmall。

### 内置工具

54 个内置工具，另有 MCP 与连接器按需动态注入：

```
文件        read_file · create_file · str_replace · apply_patch · search · list_dir
命令/进程   execute_command · start_process · get_process_output · wait_process · stop_process · list_processes
浏览器      open_browser · close_browser · screenshot_page · browser_click · browser_type · browser_press ·
            browser_select · browser_scroll · browser_reload · browser_hover · browser_wait · browser_back ·
            browser_forward · browser_set_viewport · browser_get_html · browser_eval ·
            get_browser_logs · get_browser_network · get_browser_storage
Relay       relay_create · relay_advance · relay_save_doc · relay_update_task · relay_review_task
能力        use_skill · read_skill_file · activate_power · delegate_task
交互/产物   ask_user · ask_form · update_memory · update_tasks · create_artifact · edit_artifact ·
            read_artifact · report_outputs · report_checks · render_media · generate_image
诊断/联网   check_diagnostics · web_search · web_fetch
```

不常用的工具组按需加载，不占每轮的工具定义；Wiki 生成另有 `wiki_plan_pages` / `wiki_save_page`，只在生成期间注入。

---

## 架构

```
            ┌──────────────── @axon/core ────────────────┐
            │ 会话 · 工具 · LLM 策略 · 重试 · 压缩 · 快照  │
            │ Relay · Skills · Powers · MCP · Wiki · 连接器 │
            └──────┬───────────────────────────┬─────────┘
          AgentHost（"双手"）            AgentChannel（"嘴"）
     文件 · 命令 · 进程 · 诊断 · 浏览器     流式输出 · 工具卡片 · 事件
                   │                            │
     ┌─────────────┼──────────────┐     postMessage / WebSocket
 host-vscode    host-node      host-node            │
 (扩展进程内)   (server)        (cli)          web/（React 界面，两种形态共用）
```

内核只认这两层接口：宿主负责"能做什么"（读写文件、跑命令、开浏览器），通道负责"怎么告诉界面"。换一个外壳只需实现这两层。

### 目录

```
packages/
  core/              Agent 引擎（@axon/core）
  host-node/         Node 宿主：文件、终端、Playwright 浏览器、ffmpeg、MCP、存储
  host-vscode/       VS Code 宿主：编辑器诊断、原生 diff、终端集成
apps/
  vscode-extension/  VS Code 扩展（侧栏 webview、命令、状态栏、请求路由）
web/                 React 界面（Vite；扩展与 Web 形态共用同一份构建）
server/              Web 形态服务端（Express + WebSocket）
cli/                 命令行形态
test/eval/           Agent 行为评测
docs/                开发指南与设计文档
```

扩展源码在这里开发，发布前同步到 Axon IDE 仓库的 `extensions/axon-ide`（IDE 的 CI 从那里打包）。

---

## 开发

环境：Node.js 20+、pnpm 9。

```bash
pnpm install
pnpm build          # turbo 按依赖顺序构建 core → host → server / extension
```

`web/` 目前是独立的 npm 工程（不在 pnpm workspace 里）：

```bash
cd web
npm ci
npm run dev         # 本地调界面
npx vite build      # 产物供扩展与 server 使用
```

常用命令：

```bash
pnpm --filter @axon/core test         # 内核单测（vitest）
pnpm --filter axon-ide typecheck      # 扩展类型检查
pnpm typecheck                        # 全仓类型检查
```

增量构建、调试扩展、同步到 IDE 仓库等流程见 [开发指南](docs/guide.md)。每次推送与 PR 都会在 GitHub Actions 上跑一遍构建、扩展类型检查、内核单测和界面构建（[.github/workflows/ci.yml](.github/workflows/ci.yml)）。

### 配置与数据位置

| 内容 | 位置 |
|---|---|
| Provider、模型、语音输入配置 | `~/.axon/settings/providers.json`（权限 0600） |
| 连接器凭据、OAuth 令牌 | `~/.axon/secrets/`（权限 0600，不会回传给界面） |
| 会话记录 | `~/.axon/sessions/` |
| 项目 Wiki | `<工作区>/.axon/wiki/`（随 git 提交） |
| 临时脚本 | `<工作区>/.axon/tmp/`（自动加入忽略规则，3 天后清理） |

工作区里的配置不能覆盖用户级的 API Key、额度凭据或命令白名单：打开一个陌生仓库不会把你的 Key 发到别处，也不会放行任意命令。

---

## 相关仓库

- [Axon IDE](https://github.com/ysjemmm/Axon-IDE)：基于 Code OSS 的桌面 IDE，内置本仓库的扩展，提供 Windows / macOS 安装包与自动更新。

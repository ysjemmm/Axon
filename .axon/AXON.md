# Axon 工作区说明

## 项目结构

- `packages/core`：Agent 核心、会话编排、工具协议、压缩与记忆。
- `packages/host-node`：Node 宿主能力。
- `packages/host-vscode`：VS Code / Code OSS 宿主适配。
- `apps/vscode-extension`：扩展入口、WebView 资源和扩展打包。
- `web`：聊天界面、工具卡片和会话记忆面板。
- `server`：Web 形态服务端。
- `docs`：架构、重构和开发约定文档。

## 工作区约定

- Windows 环境使用 PowerShell；命令指定工作目录，不在命令中切换目录。
- 代码路径使用绝对路径；多工作区场景不要用相对路径猜测其他工作区。
- 每个工作区可以有自己的 `.axon/`；工作区级 AXON.md、rules、skills、agents 和 memory 属于该工作区。
- Axon 只读取自己的 `.axon/` 配置和 `AXON.md`，不读取 `CLAUDE.md`、`.claude/` 或 `AGENTS.md`。
- `.axon/traces/` 是本机运行痕迹，不提交；`settings.local.json`、Provider 和 MCP 配置也不提交。
- `.axon/AXON.md`、`.axon/rules/`、`.axon/skills/`、`.axon/agents/`、共享 `.axon/memory/` 和共享 `settings.json` 可以提交。

## 构建与验证

修改 `packages/core` 后：

- 在 `packages/core` 执行 `npm run build`。
- 相关逻辑执行针对性的 `npm test -- --run <test-file>`。

修改宿主后：

- `packages/host-node` 执行 `npm run build`。
- `packages/host-vscode` 执行 `npm run build`。

修改 `web` 或扩展界面后：

- `web` 执行 `npm run build`。
- `apps/vscode-extension` 执行 `npm run build`，它会同步 Web 资源。
- 需要验证 IDE 资源时同步到本机扩展目录后再检查入口文件。

## Agent 行为约束

- 先确认调用链和影响范围，再修改代码；不要凭文件名猜实现。
- 新工具卡片遵循统一折叠行：11px 单行、无无意义箭头、详情缩进内嵌。
- 工具状态图标默认使用中性灰；红色只表示失败/拒绝/危险，蓝色只表示可点击链接，琥珀色只表示待确认或执行中。
- 有明确输入输出的逻辑必须做行为验证；代码交付前至少做类型/编译检查。
- 重要设计决策、工作区理解、长期偏好、踩坑和待办应进入工作区记忆或会话记忆，而不是只留在聊天过程里。

## 记忆边界

- `.axon/memory/`：工作区长期知识，适合存项目结构、设计决策、规范、踩坑和长期待办。
- 会话记忆：当前会话形成的上下文，适合短期延续；不自动等同于团队共享规范。
- 工作区记忆应按主题分块维护，避免每次重写整份 Markdown。

# Terminal Integration（终端可视化执行）

## 目标

Agent 执行 `execute_command` 时，在 VS Code 终端面板里创建/复用一个可见终端，用户能实时看到命令输出（对齐 Kiro 的体验）。

## 当前行为

- `host-vscode` 的 commands.exec 用 `child_process.exec` 后台静默执行
- 用户只能从聊天面板的工具卡片里看到截断的输出结果
- 终端面板里没有任何 Axon 相关的终端

## 期望行为

- Agent 执行命令时，在终端面板创建一个名为 "Axon: {command}" 的终端
- 命令实时输出可见（用户可以看到进度、滚动查看）
- 短命令（<30s）：等待完成后收集 exit code + 输出，返回给 Agent
- 终端可复用：连续的命令在同一个 "Axon" 终端里执行（不每次开新终端）
- 终端执行完保留（不自动关闭），用户可回看

## 技术方案

### 核心 API

```typescript
// 创建或复用终端
const terminal = vscode.window.createTerminal({
  name: "Axon",
  cwd: workspaceDir,
});
terminal.show(true); // 显示但不聚焦

// 发送命令
terminal.sendText(command);
```

### 难点：获取输出

`vscode.Terminal` 没有直接获取 stdout 的 API。方案：

1. **Shell Integration API**（VS Code 1.93+）：`terminal.shellIntegration.executeCommand` 可以拿到 `TerminalShellExecution`，订阅其 `read` 事件获取输出
2. **重定向到临时文件**：`command > /tmp/axon-out.txt 2>&1; echo __EXIT:$?__`，然后读文件
3. **保持现有后台 exec + 终端仅做展示**：后台 exec 照旧执行并获取输出，同时在终端里 echo 命令（让用户看到），输出仍从 exec 拿

### 建议方案

**方案 3（最稳妥）**：保持 `child_process.exec` 作为"获取输出"的主通道（已验证可靠），同时用一个 "Axon" 终端做**回显展示**：

```typescript
// 1. 后台 exec 获取真实输出（现有逻辑不变）
const result = await exec(command, { cwd, timeout });

// 2. 同时在可见终端里回显命令（让用户知道执行了什么）
axonTerminal.sendText(`# [Axon] ${command}`);
```

后续迭代可升级到 Shell Integration API（获取终端的真实实时输出），但 MVP 先用回显。

### 终端管理

- 一个 "Axon" 终端实例，整个会话共享
- 终端被用户关闭后下次命令时重建
- `cwd` 变化时在终端里执行 `cd`
- 终端名带 Agent 标识："Axon"（不带具体命令，因为复用）

## 文件结构

```
packages/host-vscode/src/
├── commands.ts         # 现有：child_process.exec
├── terminalDisplay.ts  # 新增：终端回显展示（创建/复用/发送）
```

## 实现步骤

1. 创建 `terminalDisplay.ts`：管理一个 "Axon" 终端实例（创建/复用/重建）
2. 在 `commands.exec` 执行命令时，同步往终端 sendText 回显
3. 命令完成后在终端追加 exit code 状态行
4. 后续：探索 Shell Integration API 获取真实终端输出

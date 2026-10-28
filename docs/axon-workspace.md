# Axon 工作区配置协议

Axon 为每个工作区提供 `.axon/` 目录，参考 Claude Code 的 `.claude/` 项目约定，但只复用适合 Axon 的部分。工作区配置属于 Agent 上下文，不等同于会话历史。

## 推荐目录

```text
<workspace>/.axon/
├── AXON.md                  # 工作区主说明，团队共享
├── AXON.local.md            # 本机个人覆盖，不提交
├── settings.json            # 共享设置，可提交
├── settings.local.json      # 本机设置，不提交
├── rules/                   # 路径/领域规则，Markdown，可提交
├── skills/                  # 工作区 Skills，可提交
├── agents/                  # 工作区 Agent 定义，可提交
├── memory/                  # 工作区长期知识，可按团队策略提交
├── settings/
│   ├── providers.json       # 本机凭据/Provider，不提交
│   └── mcp.json             # 本机 MCP 连接配置，不提交
└── traces/                  # 运行时 JSONL 痕迹，不提交
```

当前核心加载器已经实现：

- `.axon/AXON.md`、`.axon/AXON.local.md` 和根目录 `AXON.md`；
- `.axon/rules/` 下的 Markdown 规则；
- `.axon/memory/` 下的 Markdown 工作区长期知识；
- `.axon/settings.json` 与 `settings.local.json`；
- 用户级 `%USERPROFILE%/.axon/` 配置；
- 多根工作区逐个加载。

Skills、Provider、MCP、Power 有自己的专用注册表，但统一使用 `.axon` 目录作为工作区来源。

## 加载优先级

```text
用户级 ~/.axon/
    ↓
工作区 A/.axon/
    ↓
工作区 B/.axon/
    ↓
当前请求 / 当前工具调用上下文
```

同名设置由后者覆盖；规则、记忆和 Markdown 指令按文件合并注入。多工作区不只读取第一个目录，每个工作区都可以提供自己的 `.axon/`。

## 共享与私有边界

适合提交：

- `.axon/AXON.md`；
- `.axon/rules/`；
- `.axon/skills/`；
- `.axon/agents/`；
- 不含隐私的 `.axon/memory/`；
- 不含凭据的 `.axon/settings.json`。

不应提交：

- `.axon/traces/`；
- `.axon/AXON.local.md`；
- `.axon/settings.local.json`；
- `.axon/settings/providers.json`；
- `.axon/settings/mcp.json`。

`.gitignore` 已按这个边界配置。工作区打开时只创建基础目录，不自动写入模板文件；只读或远程工作区无法创建时，配置加载会静默降级，不影响正常聊天。

## settings.json

当前支持的工作区控制项：

```json
{
  "version": 1,
  "memory": {
    "enabled": true,
    "maxInjectedChars": 25600
  },
  "workspaceConfig": {
    "loadRules": true,
    "loadCompatibleInstructions": true
  }
}
```

- `memory.enabled=false`：不注入 `.axon/memory/`；
- `memory.maxInjectedChars`：限制工作区配置总注入大小，范围 1000～100000；
- `workspaceConfig.loadRules=false`：不注入 `.axon/rules/`；
- Axon 不读取 `CLAUDE.md`、`.claude/` 或 `AGENTS.md`；这些属于其它 Agent 产品/协议。

未知设置暂不自动执行，避免配置文件中的任意字段改变 Agent 行为。后续新增设置必须进入类型、文档和测试。

## AXON.md 应该写什么

适合放每轮都需要的稳定事实：

- 工作区目录结构；
- 构建和测试命令；
- 编码规范；
- 架构边界；
- 长期有效的安全约束；
- 反复纠正 Agent 后确认的规则。

不适合放：

- 只适用于一次任务的临时计划；
- 很长的参考资料；
- 私有路径、Token、服务器地址；
- 可以通过源码直接推导出的普通事实。

长流程放 `skills/`，针对目录的规则放 `rules/`，个人偏好放 `AXON.local.md`。

## 与会话记忆的关系

- `.axon/memory/` 是工作区长期知识，属于项目/团队上下文；
- 会话记忆是当前会话形成的结论，属于会话上下文；
- 两者都会作为独立尾部注入，但不互相覆盖；
- 工作区长期知识应按主题拆成多个 Markdown 文件，避免单文件不断重写。

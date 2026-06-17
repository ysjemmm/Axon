# 大文件写入策略与 append_file 决策

## 结论（TL;DR）

1. **不新增 `append_file` 工具。** 截断风险实测为零，且大文件场景已被现有能力覆盖。
2. **截断不是真问题。** 生产环境的 `ChatCompletionsStrategy` 不设 `max_tokens`，
   实测 4 个模型写到 ~910 行 / 单轮峰值 23k token 仍无任何截断。
3. **已在系统提示加入大文件写入策略**（`systemPrompt.ts` → 修改文件的规则 · 第 6 条），
   按内容性质分流，主要解决"一次性写大文件慢、无中间反馈"的体验问题。

## 系统提示里的大文件策略

- 中小文件（约数百行以内）：正常一次 `create_file` 写完，不拆。
- 超大文件 + 内容**重复/程式化**（数据表、雷同数据项、样板）：用 `execute_command`
  跑短脚本程序化生成 —— 脚本输出极小，最快、最省、最不易错。
- 超大文件 + 内容**逐段不同**（真实大模块）：先 `create_file` 写骨架，再多次
  `str_replace` 分段补全 —— 让用户尽早看到结构、逐段看进展。

## 支撑数据（大文件生成压测）

测试脚本：`test/eval/src/largeFileStress.ts`，运行 `npm run stress:largefile`。
关键设计：绕开通用 harness 写死的 `max_tokens=1024`，改用 16384 逼近生产无上限；
用生产同款 `parseToolArguments`（含 JSON 修复）判定参数是否被截断；沙箱播种真实
项目结构（package.json + src/index.ts），避免空工作区触发"要不要建 src/"的确认式犹豫。

| 尺寸 | gpt-5.4 | gpt-5.5 | deepseek-v4-pro | glm-5.1 |
|---|---|---|---|---|
| S（40 条 / ~140 行） | ✅ | ✅ | ✅ | ✅ |
| M（120 条 / ~420 行） | ✅ | ✅ | ✅（脚本） | 网关 EOF |
| L（260 条 / ~910 行） | ✅ | ✅ | ✅（脚本） | ✅（峰值 23k token） |

全部 run：`截断(length)=0`、`参数截断=0`。deepseek 在大尺寸自发降级到脚本生成并写全，
印证系统提示策略与现有 `execute_command` 路径已覆盖大文件场景。

## 注意事项

- **glm-5.1 经当前网关（ai-router）间歇性 `unexpected EOF`**，稳定性不如其他三个，
  与 `models.ts` 里 qwen 的备注同类（测的是网关可靠性而非模型能力）。
- **空沙箱是测试陷阱**：模型遵守"新建文件前确认目录"的规则，面对空工作区会停下来
  问"是否新建 src/"，导致"0 写入"假象。压测必须播种真实结构才能测准写入行为。

## 复测方式

```bash
cd test/eval
npm run stress:largefile                                   # 全模型 × 全尺寸
npm run stress:largefile -- --variants gpt-5.5 --sizes L   # 指定模型/尺寸
npm run stress:largefile -- --realistic                    # 真实风格请求（不强制逐条手写）
```

> 改了 `@axon/core` 的提示/逻辑后，需先在 `packages/core` 跑 `npm run build`，
> eval 才会用到最新版本（它走 core 的 dist）。

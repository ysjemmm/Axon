# Skill 接入发布平台（方案 B）细化设计

> 版本: 1.0 | 日期: 2026-07-06
>
> **状态**: 草稿
>
> 上游文档: [skill-release-platform-integration-proposal.md](./skill-release-platform-integration-proposal.md)（方案 B：Skill 作为独立应用）

---

## 一、范围与结论摘要

本文档在主方案文档「方案 B」的基础上，细化以下内容：

1. Skill 在发布平台七阶段流程中每一步的具体行为
2. 发布平台「添加应用」弹窗新增「AI Skill」类型的表单设计
3. skill-manage 需提供的对外接口清单及入参/出参字段定义

核心约束（已与相关方对齐）：

| 约束 | 内容 |
|------|------|
| 服务对象 | 本次打通仅服务 Agent 2.0，发布目标只出 `agentTag=agent2` 且 `pullRule=stable` 的目标 |
| Skill 范围 | 仅 GitLab 来源的 Skill（`sourceType=gitlab`），zip 包类型不进车次流程 |
| 发布目标 | 单选，一个 Skill 一次只发一个发布目标；多目标需求以后再做 |
| 审批 | 发布平台车次审批**替代** skill-manage 内部发布审批（来源为发布平台的发布调用免内部审批） |
| 非生产环境 | `latest`（开发）环境发布不受影响，仍在 skill-manage 直接操作 |
| 合并 master | 由发布平台统一执行，skill-manage 不参与 |

---

## 二、七阶段流程映射

发布平台既有流程：**建车 → 添加发布应用 → 开车 → 建立发布计划（选版本号）→ 审批通过 → 执行发布 → 次日合并**。

| 阶段 | Skill 应用的行为 | 调用 skill-manage 接口 |
|------|-----------------|----------------------|
| 1. 建车 | 无特殊处理 | - |
| 2. 添加发布应用 | 新增「AI Skill」应用类型；搜索 Skill、单选发布目标、声明依赖的 Agent 应用 | 接口 ①②
| 3. 开车 | 车次锁定，之后的 Skill 变更等下一班车 | - |
| 4. 建立发布计划 | 下拉选择 versionTs（仅 `scanned` 状态版本），**分支随版本自动确定**（版本创建时已绑定 `gitBranch` + `commitId`），存入发布计划；保存时做发布前软校验 | 接口 ③④ |
| 5. 审批通过 | 车次审批即 Skill 发布审批，skill-manage 内部审批对此来源短路 | - |
| 6. 执行发布 | Skill 流水线三步：校验 → 发布 → 确认；确认步复用 Agent 2.0 现有的 Skill 清单拉取接口；全部通过后才放行依赖它的 Agent 部署 | 接口 ④⑤ |
| 7. 次日合并 | 发布平台用发布计划中记录的 `gitBranch` 合并到 master；分支为 master 的版本跳过 | - |

### 分支确定时点

分支**不需要单独的选择动作**，分两个时点确定：

- **事实确定**：开发者在 skill-manage 从 feature 分支创建版本时，`gitBranch` + `commitId` 固化进版本快照
- **流程锁定**：发布计划阶段选中 versionTs，分支信息随版本带给发布平台并存入计划

### 分支漂移防护

版本是创建时刻的内容快照，而合并 master 合的是分支头。若建版本后分支又有新提交，会导致 master 与生产不一致。防护：

- 发布计划保存时（软校验）与流水线 Step 1（硬校验）均调接口④，比对分支头 commit 与版本 `commitId`，不一致则失败并提示重新建版本、更新发布计划
- 校验由 skill-manage 执行（已具备各 Skill 仓库的 GitLab API 访问能力）

### 回滚路径

- 车次回滚时，发布平台反向调接口⑤，把发布目标发回上一个生效版本；回滚目标版本号取自发布平台侧该 Skill + 发布目标的上一次成功发布记录
- 首发场景（本次发布才建立的关联）没有"上一个版本"，回滚 = 将该 Skill 从发布目标移除关联（是否需要为此提供下线接口，待与发布平台确认回滚流水线形态后定）
- Skill 已生效但 Agent 部署失败的窗口期：线上旧 Agent 镜像内置的是构建时的旧 Skill，实际无影响；回滚动作 = Skill 反向发布 + Agent 回滚镜像

---

## 三、添加应用表单设计（AI Skill Tab）

```
应用类型   [高代码开发应用] [低代码开发应用] [高代码应用包] [AI Skill]

* 应用名称   [输入 Skill 名称搜索        ]   * 发布目标  [agent-copilot-stable ▼]（单选，来自 skill-manage）
* 选择依赖   [agent-copilot ▼]             发布参与人 [输入花名搜索    ]
* 发布人     [自动带出 Skill 负责人，可改 ]
* 业务域     [自动带出，可改 ▼           ]
```

### 字段说明

| 字段 | 必填 | 数据来源 | 说明 |
|------|:----:|---------|------|
| 应用类型 | 是 | - | 新增第四个 Tab「AI Skill」，切换后表单联动 |
| 应用名称 | 是 | skill-manage 接口① | 关键字搜索 Skill，选中即确定 skillKey；服务端固定过滤 `sourceType=gitlab` + 状态正常 |
| 发布目标 | 是 | skill-manage 接口② | **单选**；关键字搜索 `agent2` + `stable` + 启用中的发布目标；可选择尚未关联该 Skill 的空白目标（首发场景），关联由执行发布时建立 |
| 选择依赖 | 是 | 发布平台既有能力 | 选择依赖的 Agent 应用，发布顺序保障的锚点；AI Skill 类型下改为必填 |
| 发布人 | 是 | 接口①带出，可改 | 默认取 Skill 负责人（`ownerName`） |
| 发布参与人 | 否 | 发布平台既有能力 | 不变 |
| 业务域 | 是 | 接口①带出，可改 | 默认取 Skill 的业务域；两边枚举对不齐时由人手选 |
| 运行平台 | - | 隐藏或固定值 | Skill 不自行部署，无运行平台概念；平台必填限制无法去除时固定为 `skill-manage` |
| 数据中心 | - | 隐藏或固定值 | Skill 配置生效在 skill-manage，不分数据中心 |

### 一致性风险与缓解

「发布目标」（skill-manage 概念）与「选择依赖」（发布平台概念）是两次独立人工选择，系统层面暂无绑定关系可校验：

- 一期缓解：发布目标命名带 Agent 应用名（如 `agent-copilot-stable`），车次评审时肉眼核对
- 二期增强：skill-manage 发布目标上增加「发布平台应用标识」字段（一次性配置），发布平台保存表单时校验两个选择指向同一应用

---

## 四、接口定义

### ① Skill 搜索（新增）

添加应用弹窗「应用名称」搜索。

```
GET /v1/release-platform/skills
```

**入参**

| 字段 | 类型 | 必填 | 说明 |
|------|------|:----:|------|
| keyword | string | 否 | 模糊匹配 Skill 名称 / skillKey |

服务端固定过滤：`sourceType = gitlab`、Skill 状态正常（未删除/未停用）。

**出参**

| 字段 | 类型 | 说明 |
|------|------|------|
| total | long | 总数 |
| items[].skillKey | string | Skill 唯一标识 |
| items[].name | string | Skill 名称 |
| items[].sourceType | string | 恒为 `gitlab` |
| items[].owner | string | 负责人账号 |
| items[].ownerName | string | 负责人姓名（花名），用于「发布人」默认值 |
| items[].gitUrl | string | GitLab 仓库地址，发布平台合并 master 用 |

### ② 发布目标查询（新增）

添加应用弹窗「发布目标」下拉。

```
GET /v1/release-platform/skills/publish-targets
```

**入参**

| 字段 | 类型 | 必填 | 说明 |
|------|------|:----:|------|
| keyword | string | 是 | 搜索发布目标 |

服务端固定过滤：`agentTag = agent2`、`pullRule = stable`、`status = enabled`。

**出参**

| 字段 | 类型 | 说明 |
|------|------|------|
| items[].groupKey | string | 发布目标唯一标识，后续发布调用用它 |
| items[].groupName | string | 发布目标名称 |

### ③ 可发布版本列表（适配现有）

发布计划阶段「选择版本号」下拉。现有版本查询接口已支持状态过滤、字段齐全，主要工作是对外暴露。

```
GET /v1/release-platform/skills/publishable-versions
```

**入参**

| 字段 | 类型 | 必填 | 说明 |
|------|------|:----:|------|
| skillKey | string | 是 | - |

服务端固定过滤：`status = scanned`。

**出参**

| 字段 | 类型 | 说明 |
|------|------|------|
| items[].versionTs | string | 版本号 |
| items[].gitBranch | string | 版本绑定的分支，发布计划记录它，次日合并 master 用 |
| items[].commitId | string | 版本绑定的 commit |
| items[].commitMessage | string | commit 说明 |
| items[].description | string | 版本描述 |
| items[].updatedByName | string | 版本创建人姓名 |
| items[].createTime | datetime | 版本创建时间 |

### ④ 发布前校验

两处调用：发布计划保存时（软校验，仅提示）；流水线 Step 1（硬校验，失败即流水线失败）。

```
POST /v1/release-platform/publish-check
```

**入参**

| 字段 | 类型 | 必填 | 说明 |
|------|------|:----:|------|
| skillKey | string | 是 | - |
| versionTs | string | 是 | 发布计划选定的版本 |
| groupKey | string | 是 | 发布计划选定的发布目标 |

**出参**

| 字段 | 类型 | 说明 |
|------|------|------|
| passed | boolean | 总体是否通过 |
| checks[].item | string | 校验项：`version_exists` / `status_scanned` / `branch_not_drifted` / `target_valid` |
| checks[].passed | boolean | 该项是否通过 |
| checks[].message | string | 不通过时的中文提示（如"分支在建版本后有新提交，请重新创建版本并更新发布计划"） |
| gitBranch | string | 版本绑定分支 |
| commitId | string | 版本绑定 commit |
| branchHeadCommitId | string | 分支当前头部 commit（漂移检测比对值） |

校验项说明：

| 校验项 | 内容 |
|--------|------|
| version_exists | 版本存在且未删除 |
| status_scanned | 版本状态为 `scanned` |
| branch_not_drifted | GitLab 分支头 commit == 版本 `commitId`（分支为 master 的版本跳过此项） |
| target_valid | 发布目标存在、状态启用、仍为 agent2 + stable；**不要求已关联该 Skill**（首发场景关联由发布动作建立） |

### ⑤ 执行发布

流水线 Step 2；车次回滚时反向调用（versionTs 传回滚目标版本，取自发布平台侧上一次成功发布记录）。

发布语义：目标尚未关联该 Skill 时，发布动作同时建立关联（首发/新增）；已关联时为版本升级。

```
POST /v1/release-platform/publish
```

**入参**

| 字段 | 类型 | 必填 | 说明 |
|------|------|:----:|------|
| skillKey | string | 是 | - |
| versionTs | string | 是 | 目标版本 |
| groupKey | string | 是 | 发布目标 |
| operator | string | 是 | 操作人（发布人花名），写入发布记录 |
| source | string | 是 | 固定 `release_platform`，skill-manage 据此**跳过内部审批** |

幂等：`trainId + skillKey + groupKey + versionTs` 相同的重复调用直接返回原发布记录，不报错。

**出参**

| 字段 | 类型 | 说明 |
|------|------|------|
| recordId | string | skill-manage 发布记录 ID |
| status | string | 发布结果：`published` / `failed` |
| publishTime | datetime | 生效时间 |


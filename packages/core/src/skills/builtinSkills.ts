/**
 * 内置方法论 Skill 包 - Axon 自带的一组开发方法论（对标 Superpowers 的 skills library）
 *
 * 设计要点：
 * - 以 TS 常量内嵌，编译进产物，永远可用，无需用户安装/拷贝文件
 * - 作为 source="builtin" 注册进 SkillRegistry，优先级最低：同名时被全局/工作区 skill 覆盖，
 *   用户想替换某个内置方法论，只需在 ~/.axon/skills 或工作区放一个同名 skill 即可
 * - 每个 skill 带 when（自动触发场景），配合系统提示的"动手前先扫 skill"纪律实现自动触发
 *
 * 这些方法论不绑定具体项目，是通用的工程纪律：系统化调试、TDD、代码评审、根因分析等。
 */

/** 内置 skill 的结构（与 LoadedSkill 对齐，但正文来自内存而非文件） */
export interface BuiltinSkill {
  name: string;
  description: string;
  /** 自动触发场景（注入 skill 清单，引导主 Agent 匹配即用） */
  when: string;
  /** SKILL.md 正文（不含 frontmatter） */
  body: string;
}

const SYSTEMATIC_DEBUGGING: BuiltinSkill = {
  name: "systematic-debugging",
  description: "系统化调试方法论：用四阶段根因分析定位并修复 bug，而不是瞎试。",
  when: "用户报告 bug、报错、行为异常、测试失败，或要求排查问题时",
  body: `# 系统化调试（Systematic Debugging）

不要凭感觉乱改、加一堆 print 然后碰运气。按四个阶段走，目标是找到【根因】而不是压掉症状。

## 阶段 1：复现与隔离
- 先稳定复现问题：找到最小的触发条件（输入、状态、步骤）
- 收集证据：完整错误信息、堆栈、日志、相关代码。用 search/read_file 看真实代码，不要猜
- 缩小范围：二分定位（注释一半、打日志看分界点）确定问题落在哪个模块/函数

## 阶段 2：建立假设
- 基于证据列出可能的根因（通常 1~3 个），按可能性排序
- 每个假设要可证伪：明确"如果这是真因，那应该能观察到 X"
- 不要同时改多个地方——那样就算好了也不知道是哪个起的作用

## 阶段 3：验证根因
- 逐个验证假设：构造实验（临时脚本、断点、日志）确认是不是它
- 找到根因的标志：你能解释"为什么会出这个现象"的完整因果链
- ⚠️ 区分症状与根因：空指针是症状，"某个初始化路径没覆盖到"才是根因

## 阶段 4：修复与验证
- 在根因处修复，而不是在症状处打补丁（别用 try/catch 吞掉、别加防御性判断绕过）
- 修复后构造原始触发条件，验证问题真的消失
- 想一下：同样的根因有没有在别处也存在？一并修掉
- 回归：确认修复没有破坏其它逻辑

## 反模式（禁止）
- 不复现就开始改
- 一次改一堆东西看哪个生效
- 用 fallback/默认值/吞异常掩盖问题让它"看起来好了"
- 没验证根因就宣布修复`,
};

const TEST_DRIVEN_DEVELOPMENT: BuiltinSkill = {
  name: "test-driven-development",
  description: "测试驱动开发：严格红-绿-重构循环，先写失败的测试再写实现。",
  when: "用户明确要求用 TDD / 测试驱动开发，或 Relay 启用了 TDD 质量门时",
  body: `# 测试驱动开发（TDD）

严格遵循 RED → GREEN → REFACTOR，一次只推进一个最小行为。

## RED：先写一个会失败的测试
- 针对【下一个最小行为】写一个测试，描述期望的输入输出
- 运行它，亲眼看到它失败（失败信息应该是"功能没实现"，而不是语法错/导入错）
- 看到预期的失败 = 测试本身是有效的

## GREEN：写最小实现让测试通过
- 只写【刚好让这个测试通过】的代码，不要提前实现还没测试覆盖的功能（YAGNI）
- 运行测试，看到它变绿
- 不追求优雅，先正确

## REFACTOR：在绿灯保护下重构
- 测试通过后，再清理代码：消除重复、改善命名、提取函数
- 每次重构后重新跑测试，保持全绿
- 重构只改结构不改行为

## 纪律
- 没有失败的测试，就不写实现代码
- 一次一个行为，小步前进
- 测试要测行为/契约，不要测实现细节（否则重构就会误伤）
- 如果发现自己先写了实现：删掉，从写测试重新开始

## 测试反模式（避免）
- 测试里没有断言（只是跑一遍不报错）
- 一个测试验证太多东西，失败时定位不到
- 过度 mock，测的全是 mock 行为而非真实逻辑
- 为了凑覆盖率写无意义的测试`,
};

const REQUESTING_CODE_REVIEW: BuiltinSkill = {
  name: "requesting-code-review",
  description: "提交评审前的自检清单：按严重度过一遍改动，把问题挡在交付前。",
  when: "完成一组代码改动、准备交付或提交前，做最后质量把关时",
  body: `# 提交前代码自检（Pre-Review Checklist）

把改动交出去之前，自己先当一次评审员，按严重度过一遍。

## 正确性（critical）
- 需求是否完整实现？有没有漏掉的子项？
- 边界条件：空值、空集合、超长、并发、越界都处理了吗？
- 错误路径：失败时的行为是否合理（不是吞掉、不是裸崩）？
- 有明确输入输出的逻辑，是否实际跑过验证（不只是类型检查）？

## 一致性（major）
- 是否破坏了现有接口契约？调用方都更新了吗？
- 命名、风格、目录结构是否与项目现有约定一致？
- 有没有引入和现有实现重复的逻辑（应复用而非另写一套）？

## 整洁度（minor）
- 有没有留下 TODO、调试代码、注释掉的死代码、临时文件？
- 函数是否过长、职责是否单一？
- import / 依赖是否都用上了、没有冗余？

## 输出方式
- 发现的问题按 [critical]/[major]/[minor] 分级列出
- critical 必须在交付前修掉，不能留给用户
- 改完重新自检，确认问题真的消除`,
};

const ROOT_CAUSE_TRACING: BuiltinSkill = {
  name: "root-cause-tracing",
  description: "根因追溯：沿调用链/数据流逆向追踪，定位问题的最初源头。",
  when: "遇到难以定位的深层 bug、数据在传递中被污染、或症状离根因很远时",
  body: `# 根因追溯（Root Cause Tracing）

症状出现的地方往往不是问题产生的地方。沿着因果链往回追，直到找到最初的源头。

## 方法
1. 从症状点出发：错误/异常值是在哪一行被观察到的？
2. 逆向追踪数据来源：这个值从哪来？谁赋的？沿调用栈/数据流往上游走
3. 每一层都问："到这一层时值已经错了吗？"
   - 已经错了 → 继续往上游追
   - 还是对的 → 根因就在这一层和下一层之间
4. 找到第一个"值开始变错"的点 = 根因所在

## 工具用法
- search 找到所有给这个变量/字段赋值的地方
- read_file 看完整的数据流转上下文（调用方、被调用方）
- 必要时加日志打印中间值，确认在哪一步变错

## 关键原则
- 不要在症状点打补丁（那只是把错误往后推）
- 追到能解释完整因果链为止
- 找到根因后检查：同源的问题是否在别处也存在`,
};

const VERIFICATION_BEFORE_COMPLETION: BuiltinSkill = {
  name: "verification-before-completion",
  description: "完成前验证：用证据证明真的修好了/做对了，而不是声称完成。",
  when: "准备宣布任务完成、bug 已修复、功能已实现之前",
  body: `# 完成前验证（Verification Before Completion）

"我改好了"不算数，"我验证了它确实对"才算数。交付前必须有证据。

## 验证清单
1. 原始需求/复现条件还在吗？用它实测一遍
   - 修 bug：构造原始触发条件，确认问题消失
   - 加功能：构造真实输入，确认输出符合预期
2. 类型/编译检查通过（check_diagnostics）
3. 有明确输入输出的逻辑：写临时脚本跑几个样例，看输出对不对
4. 回归：相关的现有功能没被破坏
5. 清理：临时验证脚本删除，无残留

## 证据标准
- 能说出"我用 X 输入得到 Y 输出，符合预期"
- 而不是"应该没问题""理论上可以"

## 反模式
- 改完就说完成，没跑过
- 只做类型检查就当验证了行为（类型对 ≠ 行为对）
- 把验证推给用户（"你可以测一下"）`,
};

/** 所有内置方法论 skill */
export const BUILTIN_SKILLS: BuiltinSkill[] = [
  SYSTEMATIC_DEBUGGING,
  TEST_DRIVEN_DEVELOPMENT,
  REQUESTING_CODE_REVIEW,
  ROOT_CAUSE_TRACING,
  VERIFICATION_BEFORE_COMPLETION,
];

/** 按名称取内置 skill */
export function getBuiltinSkill(name: string): BuiltinSkill | undefined {
  return BUILTIN_SKILLS.find((s) => s.name === name);
}

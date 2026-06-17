/**
 * LoopGuard 防失控守卫单测（确定性，无 LLM）
 *
 * 专测"卡住→升级阶梯→投降"这条新链路的状态机：
 *   - 目标级失败跟踪（含软失败）：抓"参数微调着反复撞同一堵墙"的盲区
 *   - 升级阶梯：反思·换路（1 次）→ 摘要重启（1 次）→ 投降
 *   - getStuckTarget 优先返回带文件路径的目标（供重量版重读）
 *
 * 这类逻辑是纯函数状态机，靠 LLM benchmark 既不稳定也抓不准，必须用确定性单测兜住。
 *
 * 运行：npm run test:guard
 */

import { LoopGuard, DEFAULT_AGENT_POLICY, buildReflectionPrompt, buildSummaryRestartPrompt } from "@axon/core";

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string) {
  if (cond) { passed++; console.log(`  ✅ ${msg}`); }
  else { failed++; console.log(`  ❌ ${msg}`); }
}

/** 模拟对同一文件用 str_replace 失败 n 次（默认软失败：oldStr 每次不同，模拟参数微调） */
function failFile(guard: LoopGuard, path: string, n: number, soft = true) {
  for (let i = 0; i < n; i++) {
    guard.recordToolResult(false, soft, { toolName: "str_replace", args: { path, oldStr: `pattern_${i}` } });
  }
}

function testSoftFailuresTriggerReflection() {
  console.log("\n▶ 软失败盲区：同一文件反复软失败 → 识别为卡住目标");
  const g = new LoopGuard(DEFAULT_AGENT_POLICY);
  failFile(g, "src/a.ts", DEFAULT_AGENT_POLICY.maxTargetFailures);
  check(g.getStuckTarget()?.path === "src/a.ts", "同一文件软失败累计达阈值 → 命中卡住目标（连续失败计数抓不到的盲区）");
  check(g.failures === 0, "软失败不计入连续失败计数（保留正常纠错空间）");
  check(g.isStuck(), "存在卡住目标 → isStuck=true");
  check(g.canReflect(), "首次卡住 → 允许反思·换路");
}

function testSuccessClearsTarget() {
  console.log("\n▶ 同一目标成功后清除失败累计");
  const g = new LoopGuard();
  failFile(g, "src/b.ts", 2);
  g.recordToolResult(true, false, { toolName: "str_replace", args: { path: "src/b.ts" } });
  check(g.getStuckTarget() === null, "改对一次后该目标失败计数清零，不再误判卡住");
}

function testEscalationLadder() {
  console.log("\n▶ 升级阶梯：反思 → 摘要重启 → 投降");
  const g = new LoopGuard();

  failFile(g, "src/c.ts", 3);
  check(g.isStuck() && g.canReflect(), "阶梯①：卡住且可反思");
  g.noteReflected();
  check(!g.isStuck(), "反思后清空卡住计数 → 给一个干净的重试窗口");
  check(!g.canReflect(), "反思额度（1 次）已用尽");

  failFile(g, "src/c.ts", 3);
  check(g.isStuck() && !g.canReflect() && g.canSummaryRestart(), "阶梯②：反思用尽仍卡 → 转入摘要重启");
  g.noteSummaryRestart();
  check(!g.isStuck(), "摘要重启后同样清空卡住计数");

  failFile(g, "src/c.ts", 3);
  check(g.isStuck() && !g.canReflect() && !g.canSummaryRestart(), "阶梯③：两级阶梯耗尽仍卡 → 应强制投降");
}

function testConsecutiveHardFailures() {
  console.log("\n▶ 跨目标连续硬失败也走阶梯（非单一目标卡住）");
  const g = new LoopGuard();
  g.recordToolResult(false, false, { toolName: "search", args: { query: "alpha" } });
  g.recordToolResult(false, false, { toolName: "search", args: { query: "beta" } });
  g.recordToolResult(false, false, { toolName: "search", args: { query: "gamma" } });
  check(g.getStuckTarget() === null, "三个不同搜索词各失败一次 → 无单一卡住目标");
  check(g.isStuck(), "但连续硬失败达阈值 → 仍判定卡住，进入升级阶梯");
}

function testPreferPathTarget() {
  console.log("\n▶ getStuckTarget 优先返回带文件路径的目标（供重量版重读）");
  const g = new LoopGuard();
  failFile(g, "src/d.ts", 3);                               // 文件目标，count=3，带 path
  for (let i = 0; i < 5; i++) {                              // 搜索目标，count=5，无 path
    g.recordToolResult(false, false, { toolName: "search", args: { query: "fixed_query" } });
  }
  const stuck = g.getStuckTarget();
  check(stuck?.path === "src/d.ts", "即便搜索目标失败次数更多，仍优先返回可重读的文件目标");
}

function testCommandTargetNormalization() {
  console.log("\n▶ 命令目标归一化：前两个 token 相同视为同一目标");
  const g = new LoopGuard();
  for (let i = 0; i < 3; i++) {
    g.recordToolResult(false, false, { toolName: "execute_command", args: { command: `npm run build --flag${i}` } });
  }
  check(g.getStuckTarget()?.key === "cmd:npm run", "命令按前两个 token 归一化，忽略易变尾参，反复失败可识别");
}

function testUntrackedToolNoTarget() {
  console.log("\n▶ 未纳入目标跟踪的工具不产生卡住目标");
  const g = new LoopGuard();
  for (let i = 0; i < 5; i++) {
    g.recordToolResult(false, true, { toolName: "list_dir", args: { path: "src" } });
  }
  check(g.getStuckTarget() === null && !g.isStuck(), "list_dir 软失败不纳入目标跟踪、也不计连续失败 → 不误触发阶梯");
}

function testPromptContent() {
  console.log("\n▶ 升级阶梯引导文案");
  const reflect = buildReflectionPrompt({ toolName: "str_replace", key: "str_replace:src/e.ts", path: "src/e.ts", count: 3 });
  check(reflect.includes("src/e.ts"), "反思引导带上卡住的具体文件路径");
  check(reflect.includes("换"), "反思引导包含'换路'指令");
  const restart = buildSummaryRestartPrompt(null);
  check(restart.includes("重新开始"), "摘要重启引导包含'重新开始'语义");
}

function main() {
  console.log("🧪 LoopGuard 升级阶梯单测（确定性）");
  testSoftFailuresTriggerReflection();
  testSuccessClearsTarget();
  testEscalationLadder();
  testConsecutiveHardFailures();
  testPreferPathTarget();
  testCommandTargetNormalization();
  testUntrackedToolNoTarget();
  testPromptContent();
  console.log(`\n────────────────────────────\n通过 ${passed}  失败 ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

main();

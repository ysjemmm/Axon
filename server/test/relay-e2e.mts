/**
 * Relay 工作流引擎全链路行为测试（不依赖真 LLM、不碰项目目录）
 * 用系统临时目录当工作区，跑完即删。直接跑源码：npx tsx test/relay-e2e.mts
 */
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RelayStore } from "../src/relay/relayStore.js";

let pass = 0, fail = 0;
function ok(cond: boolean, name: string) {
  if (cond) { pass++; console.log(`✓ ${name}`); }
  else { fail++; console.log(`✗ ${name}`); }
}
async function exists(p: string) { try { await stat(p); return true; } catch { return false; } }

const ws = await mkdtemp(join(tmpdir(), "relay-test-"));
try {
  const store = new RelayStore(ws);

  // 1. 创建
  const created = await store.create({ title: "用户登录功能", summary: "实现登录", quality: { tdd: true, review: true } });
  ok(created.phase === "brainstorm", "创建后处于 brainstorm");
  ok(created.quality?.tdd === true && created.quality?.review === true, "质量门配置落盘");
  ok(await exists(join(ws, ".axon", "relays", created.id, "relay.json")), "relay.json 落盘");
  const id = created.id;

  // 2. brainstorm 文档 + 推进
  await store.saveDoc(id, "brainstorm", "# 需求\n- 用户能登录");
  ok(await exists(join(ws, ".axon", "relays", id, "requirements.md")), "requirements.md 落盘");
  let r = await store.advancePhase(id, "brainstorm", "design");
  ok(r!.phase === "design", "推进到 design");
  ok(r!.approvals.brainstorm === true, "brainstorm 确认门已标记");

  // 3. design 文档 + 推进
  await store.saveDoc(id, "design", "# 设计\n架构说明");
  r = await store.advancePhase(id, "design", "plan");
  ok(r!.phase === "plan", "推进到 plan");

  // 4. plan 文档（复选框任务清单）→ 解析
  const planMd = `# 计划
- [ ] 1. 后端接口，涉及 auth.ts
  - [ ] 1.1 登录路由
  - [ ] 1.2 token 签发
- [ ] 2. 前端表单`;
  r = await store.saveDoc(id, "plan", planMd);
  ok(r!.tasks.length === 4, "plan 解析出 4 个任务");
  ok(r!.tasks.every(t => t.status === "pending"), "任务初始均 pending");
  ok(await exists(join(ws, ".axon", "relays", id, "plan.md")), "plan.md 落盘");

  // 5. 推进到 executing
  r = await store.advancePhase(id, "plan", "executing");
  ok(r!.phase === "executing", "推进到 executing");

  // 6. 任务流转：1.1 in_progress → 评审 → completed
  await store.setTaskStatus(id, "1.1", "in_progress");
  r = await store.get(id);
  ok(r!.tasks.find(t => t.id === "1.1")!.status === "in_progress", "任务 1.1 置为 in_progress");

  await store.setTaskReview(id, "1.1", "reviewing");
  await store.setTaskReview(id, "1.1", "passed", {
    spec: { passed: true, issues: [], summary: "规格OK" },
    quality: { passed: true, issues: [], summary: "质量OK" },
    passed: true, reviewedAt: new Date().toISOString(),
  });
  r = await store.get(id);
  const t11 = r!.tasks.find(t => t.id === "1.1")!;
  ok(t11.reviewStatus === "passed", "任务 1.1 评审通过状态保留");
  ok(t11.review?.passed === true, "任务 1.1 评审结果保留");

  await store.setTaskStatus(id, "1.1", "completed");

  // 7. 关键：plan.md 复选框被回写
  const planAfter = await readFile(join(ws, ".axon", "relays", id, "plan.md"), "utf-8");
  ok(planAfter.includes("- [x] 1.1 登录路由"), "plan.md 复选框已回写为已勾选");
  ok(planAfter.includes("- [ ] 1. 后端接口"), "未完成任务保持未勾选");

  // 8. 评审字段不被 plan.md 重解析覆盖
  r = await store.get(id);
  ok(r!.tasks.find(t => t.id === "1.1")!.review?.passed === true, "重新读取后评审结果仍在（未被 plan 解析覆盖）");

  // 9. 全部完成 → 自动 done
  for (const tid of ["1", "1.2", "2"]) await store.setTaskStatus(id, tid, "completed");
  r = await store.get(id);
  ok(r!.phase === "done", "所有任务完成后自动进入 done");

  // 10. 列表摘要
  const list = await store.list();
  const summary = list.find(s => s.id === id)!;
  ok(summary.taskTotal === 4 && summary.taskDone === 4, "列表摘要进度 4/4");

  // 11. 删除
  await store.remove(id);
  ok(!(await exists(join(ws, ".axon", "relays", id))), "删除后目录移除");

  console.log(`\n结果：${pass} 通过，${fail} 失败`);
} finally {
  await rm(ws, { recursive: true, force: true });
}
process.exit(fail > 0 ? 1 : 0);

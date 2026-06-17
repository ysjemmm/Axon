/**
 * 撤销（accept → undo）严格测试 —— 数据安全级
 *
 * 背景：用户接受某文件改动后，卡片右侧出现「撤销」图标。点击撤销时，必须把这次改动
 * 反向还原（newStr → oldStr），且【绝不破坏接受之后在别处发生的其它改动】。撤销做错会
 * 直接破坏商业代码，因此核心原则是：漏撤可接受，撤错绝不可接受——任何定位歧义一律判失败、
 * 文件保持不动。
 *
 * 本测试走【生产同款代码路径】：真实 NodeEditPresenter(manual) + executeToolCall +
 * host.edits.accept / host.edits.undo。覆盖：
 *   1. str_replace 撤销恢复原文
 *   2. create_file 新建撤销 = 删除
 *   3. create_file 覆盖撤销 = 写回原内容
 *   4. apply_patch 多块撤销恢复
 *   5. 【关键】接受后在别处又改动 → 撤销只还原本次、保留别处改动（证明非整文件回滚）
 *   6. 【关键】接受后本次改动区域被覆盖 → 撤销判失败、文件不动（保守）
 *   7. newStr="" 纯删除 → 撤销把删掉的内容插回
 *   8. newStr 在文件多处出现，但上下文指纹唯一 → 撤销精确定位
 *
 * 运行：npm run stress:undo
 */

import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createNodeAgentHost } from "@axon/host-node";
import { executeToolCall, type AgentHost } from "@axon/core";

async function mkRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "axon-undo-"));
}
async function seed(root: string, rel: string, content: string): Promise<void> {
  const abs = join(root, rel);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content, "utf-8");
}
async function readOrNull(abs: string): Promise<string | null> {
  try { return await readFile(abs, "utf-8"); } catch { return null; }
}

interface CaseResult { name: string; passed: boolean; detail: string; }

function check(name: string, cond: boolean, detail: string): CaseResult {
  return { name, passed: cond, detail: cond ? "正确" : detail };
}

const ORIG = `export const RATE = 3;\nexport function calc(x: number) {\n  return x * RATE;\n}\n`;

/** 1. str_replace 接受后撤销，文件恢复原文 */
async function case1(): Promise<CaseResult> {
  const root = await mkRoot();
  try {
    await seed(root, "calc.ts", ORIG);
    const host = createNodeAgentHost();
    host.edits.setMode("manual");
    const abs = join(root, "calc.ts");
    await executeToolCall("str_replace", { path: "calc.ts", oldStr: "export const RATE = 3;", newStr: "export const RATE = 999;" }, root, host, {}, [root]);
    await host.edits.accept("calc.ts");
    const afterAccept = await readOrNull(abs);
    const res = await host.edits.undo("calc.ts");
    const now = await readOrNull(abs);
    return check(
      "1. str_replace 撤销恢复原文",
      res.ok && afterAccept?.includes("RATE = 999") === true && now === ORIG,
      `undo.ok=${res.ok} reason=${res.reason}; now=${JSON.stringify((now ?? "").slice(0, 60))}`,
    );
  } finally { await rm(root, { recursive: true, force: true }); }
}

/** 2. create_file 新建，撤销=删除 */
async function case2(): Promise<CaseResult> {
  const root = await mkRoot();
  try {
    const host = createNodeAgentHost();
    host.edits.setMode("manual");
    const abs = join(root, "fresh.ts");
    await executeToolCall("create_file", { path: "fresh.ts", content: "hello\nworld\n" }, root, host, {}, [root]);
    await host.edits.accept("fresh.ts");
    const exists1 = (await readOrNull(abs)) !== null;
    const res = await host.edits.undo("fresh.ts");
    const exists2 = (await readOrNull(abs)) !== null;
    return check("2. create_file 新建撤销=删除", res.ok && exists1 && !exists2, `undo.ok=${res.ok} reason=${res.reason} existsAfterUndo=${exists2}`);
  } finally { await rm(root, { recursive: true, force: true }); }
}

/** 3. create_file 覆盖，撤销=写回原内容 */
async function case3(): Promise<CaseResult> {
  const root = await mkRoot();
  try {
    await seed(root, "conf.ts", ORIG);
    const host = createNodeAgentHost();
    host.edits.setMode("manual");
    const abs = join(root, "conf.ts");
    await executeToolCall("create_file", { path: "conf.ts", content: "WHOLE NEW CONTENT\n", overwrite: true }, root, host, {}, [root]);
    await host.edits.accept("conf.ts");
    const afterAccept = await readOrNull(abs);
    const res = await host.edits.undo("conf.ts");
    const now = await readOrNull(abs);
    return check("3. create_file 覆盖撤销=回写原文", res.ok && afterAccept === "WHOLE NEW CONTENT\n" && now === ORIG, `undo.ok=${res.ok} now=${JSON.stringify((now ?? "").slice(0, 40))}`);
  } finally { await rm(root, { recursive: true, force: true }); }
}

/** 4. apply_patch 多块撤销恢复 */
async function case4(): Promise<CaseResult> {
  const root = await mkRoot();
  try {
    const orig = `const a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 4;\nconst e = 5;\n`;
    await seed(root, "multi.ts", orig);
    const host = createNodeAgentHost();
    host.edits.setMode("manual");
    const abs = join(root, "multi.ts");
    const patch = [
      "*** Begin Patch",
      "*** Update File: multi.ts",
      "@@",
      " const a = 1;",
      "-const b = 2;",
      "+const b = 222;",
      "@@",
      " const d = 4;",
      "-const e = 5;",
      "+const e = 555;",
      "*** End Patch",
    ].join("\n");
    await executeToolCall("apply_patch", { patch }, root, host, {}, [root]);
    await host.edits.accept("multi.ts");
    const afterAccept = await readOrNull(abs);
    const res = await host.edits.undo("multi.ts");
    const now = await readOrNull(abs);
    return check("4. apply_patch 多块撤销恢复", res.ok && afterAccept?.includes("222") === true && afterAccept?.includes("555") === true && now === orig, `undo.ok=${res.ok} reason=${res.reason} now=${JSON.stringify((now ?? "").slice(0, 60))}`);
  } finally { await rm(root, { recursive: true, force: true }); }
}

/** 5. 【关键】接受后在别处又改动 → 单独撤销某单元只还原该单元、保留别处改动 */
async function case5(): Promise<CaseResult> {
  const root = await mkRoot();
  try {
    const orig = `line1\nTARGET_OLD\nline3\nFAR_OLD\nline5\n`;
    await seed(root, "safe.ts", orig);
    const host = createNodeAgentHost();
    host.edits.setMode("manual");
    const abs = join(root, "safe.ts");
    await executeToolCall("str_replace", { path: "safe.ts", oldStr: "TARGET_OLD", newStr: "TARGET_NEW" }, root, host, { editId: "t1" } as any, [root]);
    await host.edits.accept("t1::safe.ts");
    await executeToolCall("str_replace", { path: "safe.ts", oldStr: "FAR_OLD", newStr: "FAR_NEW" }, root, host, { editId: "t2" } as any, [root]);
    await host.edits.accept("t2::safe.ts");
    // 单独撤销第二次（t2 单元）：FAR 还原、TARGET 保留
    const res = await host.edits.undo("t2::safe.ts");
    const now = (await readOrNull(abs)) ?? "";
    const ok = res.ok && now.includes("TARGET_NEW") && now.includes("FAR_OLD") && !now.includes("FAR_NEW");
    return check("5. 单独撤销某单元只还原该单元", ok, `undo.ok=${res.ok} reason=${res.reason} now=${JSON.stringify(now.slice(0, 80))}`);
  } finally { await rm(root, { recursive: true, force: true }); }
}

/** 6. 【关键】接受后本次改动区域被覆盖 → 撤销判失败、文件不动 */
async function case6(): Promise<CaseResult> {
  const root = await mkRoot();
  try {
    const orig = `header\nNEEDLE_OLD\nfooter\n`;
    await seed(root, "guard.ts", orig);
    const host = createNodeAgentHost();
    host.edits.setMode("manual");
    const abs = join(root, "guard.ts");
    await executeToolCall("str_replace", { path: "guard.ts", oldStr: "NEEDLE_OLD", newStr: "NEEDLE_NEW" }, root, host, {}, [root]);
    await host.edits.accept("guard.ts");
    // 接受后，把本次改动区域整体覆盖（newStr 及其上下文指纹都没了）
    await writeFile(abs, "TOTALLY\nDIFFERENT\nCONTENT\n", "utf-8");
    const before = await readOrNull(abs);
    const res = await host.edits.undo("guard.ts");
    const after = await readOrNull(abs);
    return check("6. 改动区被覆盖→撤销判失败且文件不动", !res.ok && before === after, `undo.ok=${res.ok}(应为false) reason=${res.reason} fileChanged=${before !== after}`);
  } finally { await rm(root, { recursive: true, force: true }); }
}

/** 7. newStr="" 纯删除 → 撤销把删掉的内容插回 */
async function case7(): Promise<CaseResult> {
  const root = await mkRoot();
  try {
    const orig = `keep1\nDELETE_ME_LINE\nkeep2\n`;
    await seed(root, "del.ts", orig);
    const host = createNodeAgentHost();
    host.edits.setMode("manual");
    const abs = join(root, "del.ts");
    // 删除一整行（含其后换行）
    await executeToolCall("str_replace", { path: "del.ts", oldStr: "DELETE_ME_LINE\n", newStr: "" }, root, host, {}, [root]);
    await host.edits.accept("del.ts");
    const afterAccept = await readOrNull(abs);
    const res = await host.edits.undo("del.ts");
    const now = await readOrNull(abs);
    return check("7. 纯删除撤销插回原内容", res.ok && afterAccept?.includes("DELETE_ME_LINE") === false && now === orig, `undo.ok=${res.ok} reason=${res.reason} now=${JSON.stringify((now ?? "").slice(0, 60))}`);
  } finally { await rm(root, { recursive: true, force: true }); }
}

/** 8. newStr 在文件多处出现，但上下文指纹唯一 → 撤销精确定位 */
async function case8(): Promise<CaseResult> {
  const root = await mkRoot();
  try {
    // 文件里有多处 "VALUE = 0"，本次只改其中一处（靠唯一上下文 alpha 锚定）
    const orig = `alpha:\nVALUE = 0\nbeta:\nVALUE = 0\ngamma:\nVALUE = 0\n`;
    await seed(root, "multi2.ts", orig);
    const host = createNodeAgentHost();
    host.edits.setMode("manual");
    const abs = join(root, "multi2.ts");
    await executeToolCall("str_replace", { path: "multi2.ts", oldStr: "alpha:\nVALUE = 0", newStr: "alpha:\nVALUE = 42" }, root, host, {}, [root]);
    await host.edits.accept("multi2.ts");
    const res = await host.edits.undo("multi2.ts");
    const now = await readOrNull(abs);
    // 撤销后 42 消失、三处 VALUE=0 全在、文件回到原样
    return check("8. 多处同串+指纹唯一→精确撤销", res.ok && now === orig, `undo.ok=${res.ok} reason=${res.reason} now=${JSON.stringify((now ?? "").slice(0, 80))}`);
  } finally { await rm(root, { recursive: true, force: true }); }
}

/** 9. 【单元制】同文件 3 次独立编辑：逐次接受/拒绝/撤销互不影响 */
async function case9(): Promise<CaseResult> {
  const root = await mkRoot();
  try {
    const orig = `A0\nB0\nC0\n`;
    await seed(root, "unit.ts", orig);
    const host = createNodeAgentHost();
    host.edits.setMode("manual");
    const abs = join(root, "unit.ts");
    // 三次独立工具调用（不同 editId），各改一行不重叠
    await executeToolCall("str_replace", { path: "unit.ts", oldStr: "A0", newStr: "A1" }, root, host, { editId: "call1" } as any, [root]);
    await executeToolCall("str_replace", { path: "unit.ts", oldStr: "B0", newStr: "B1" }, root, host, { editId: "call2" } as any, [root]);
    await executeToolCall("str_replace", { path: "unit.ts", oldStr: "C0", newStr: "C1" }, root, host, { editId: "call3" } as any, [root]);
    // 磁盘应是 A1/B1/C1
    const afterAll = await readOrNull(abs);
    // 单独拒绝第 2 次（call2::unit.ts）→ 只回退 B，A1/C1 保留
    const rej = await host.edits.reject("call2::unit.ts");
    const afterReject = await readOrNull(abs);
    // 接受第 1 次，撤销它 → A 回退，C1 仍在、B0 仍在
    await host.edits.accept("call1::unit.ts");
    const undoRes = await host.edits.undo("call1::unit.ts");
    const afterUndo = await readOrNull(abs);
    const ok =
      afterAll === "A1\nB1\nC1\n" &&
      rej.length === 1 && afterReject === "A1\nB0\nC1\n" &&
      undoRes.ok && afterUndo === "A0\nB0\nC1\n";
    return check("9. 同文件多次独立编辑逐次管理", ok, `afterAll=${JSON.stringify(afterAll)} afterReject=${JSON.stringify(afterReject)} undo.ok=${undoRes.ok} afterUndo=${JSON.stringify(afterUndo)}`);
  } finally { await rm(root, { recursive: true, force: true }); }
}

/** 10. 【单元制·保守】拒绝与后续改动重叠的某次编辑 → 保守失败，文件不动 */
async function case10(): Promise<CaseResult> {
  const root = await mkRoot();
  try {
    const orig = `X0\n`;
    await seed(root, "ov.ts", orig);
    const host = createNodeAgentHost();
    host.edits.setMode("manual");
    const abs = join(root, "ov.ts");
    // 两次编辑改同一区域：X0→X1→X2（重叠）
    await executeToolCall("str_replace", { path: "ov.ts", oldStr: "X0", newStr: "X1" }, root, host, { editId: "c1" } as any, [root]);
    await executeToolCall("str_replace", { path: "ov.ts", oldStr: "X1", newStr: "X2" }, root, host, { editId: "c2" } as any, [root]);
    const before = await readOrNull(abs); // X2
    // 单独拒绝第 1 次（c1::ov.ts）：它的 newStr "X1" 已被第 2 次改没了 → 指纹定位不到 → 保守失败
    const rej = await host.edits.reject("c1::ov.ts");
    const after = await readOrNull(abs);
    return check("10. 重叠改动单独拒绝→保守失败不动文件", rej.length === 0 && before === after, `rejected=${rej.length}(应0) fileChanged=${before !== after}`);
  } finally { await rm(root, { recursive: true, force: true }); }
}

/** 11. 【整文件撤销】乱序撤销早期单元后，顶层「整文件撤销」仍能恢复到 AI 改动前原始内容 */
async function case11(): Promise<CaseResult> {
  const root = await mkRoot();
  try {
    const orig = `A0\nB0\nC0\n`;
    await seed(root, "whole.ts", orig);
    const host = createNodeAgentHost();
    host.edits.setMode("manual");
    const abs = join(root, "whole.ts");
    await executeToolCall("str_replace", { path: "whole.ts", oldStr: "A0", newStr: "A1" }, root, host, { editId: "w1" } as any, [root]);
    await executeToolCall("str_replace", { path: "whole.ts", oldStr: "B0", newStr: "B1" }, root, host, { editId: "w2" } as any, [root]);
    await executeToolCall("str_replace", { path: "whole.ts", oldStr: "C0", newStr: "C1" }, root, host, { editId: "w3" } as any, [root]);
    await host.edits.accept(); // 全部接受
    await host.edits.undo("w1::whole.ts"); // 乱序：先撤最早的
    // 顶层整文件撤销（按 path）：恢复到原始内容，永远安全
    const res = await host.edits.undo("whole.ts");
    const now = await readOrNull(abs);
    return check("11. 整文件撤销恢复原始内容（乱序后仍可）", res.ok && now === orig, `undo.ok=${res.ok} reason=${res.reason} now=${JSON.stringify((now ?? "").slice(0, 40))}`);
  } finally { await rm(root, { recursive: true, force: true }); }
}

/** 12. 【整文件撤销·保守】文件被外部改动后，整文件撤销保守失败，不覆盖外部改动 */
async function case12(): Promise<CaseResult> {
  const root = await mkRoot();
  try {
    const orig = `P0\n`;
    await seed(root, "ext.ts", orig);
    const host = createNodeAgentHost();
    host.edits.setMode("manual");
    const abs = join(root, "ext.ts");
    await executeToolCall("str_replace", { path: "ext.ts", oldStr: "P0", newStr: "P1" }, root, host, { editId: "e1" } as any, [root]);
    await host.edits.accept("e1::ext.ts");
    // 外部修改（模拟用户/命令改了文件）
    await writeFile(abs, "EXTERNALLY CHANGED\n", "utf-8");
    const before = await readOrNull(abs);
    const res = await host.edits.undo("ext.ts"); // 整文件撤销
    const after = await readOrNull(abs);
    return check("12. 外部改动后整文件撤销保守失败", !res.ok && before === after, `undo.ok=${res.ok}(应false) fileChanged=${before !== after}`);
  } finally { await rm(root, { recursive: true, force: true }); }
}

async function main() {
  console.log("🛡  撤销（accept → undo）严格测试 · 真实 host.edits 生产路径\n");
  const results = [
    await case1(), await case2(), await case3(), await case4(),
    await case5(), await case6(), await case7(), await case8(),
    await case9(), await case10(), await case11(), await case12(),
  ];
  let anyFail = false;
  for (const r of results) {
    const tag = r.passed ? "✅ 通过" : "❌ 失败";
    if (!r.passed) anyFail = true;
    console.log(`  ${tag}  ${r.name}\n   ${r.detail}`);
  }
  console.log(`\n${anyFail ? "❌ 存在失败：撤销逻辑有数据安全风险" : "✅ 全部通过：撤销精确且保守"}`);
  if (anyFail) process.exit(1);
}

main().catch((e) => { console.error("💥 撤销测试异常:", e); process.exit(1); });

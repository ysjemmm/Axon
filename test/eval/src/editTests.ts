/**
 * 编辑工具（str_replace / create_file）实现层测试（确定性，无 LLM）
 *
 * 直接走产品 executeToolCall，量化：
 *  - 大文件编辑的准确性 + 速度
 *  - 多行块替换准确性
 *  - 同一文件连续多次编辑
 *  - CRLF 换行风格保持
 *  - 唯一性保护（oldStr 出现多次拒绝）
 *  - 失败时返回真实邻近内容 + 行号（这是「失败→读→重编辑」恢复链路的底层机制）
 *  - 整文件重写兜底（create_file overwrite）
 *
 * 运行：npm run test:edit
 */

import { executeToolCall } from "@axon/core";
import { createSandbox } from "./sandbox.ts";

let passed = 0, failed = 0;
function check(cond: boolean, msg: string) {
  if (cond) { passed++; console.log(`  ✅ ${msg}`); }
  else { failed++; console.log(`  ❌ ${msg}`); }
}

/** 生成 n 行各不相同的 TS 文件 */
function bigFile(n: number): string {
  const lines: string[] = [];
  for (let i = 0; i < n; i++) lines.push(`export const v${i} = ${i}; // line ${i}`);
  return lines.join("\n") + "\n";
}

async function sr(sb: Awaited<ReturnType<typeof createSandbox>>, path: string, oldStr: string, newStr: string) {
  return executeToolCall("str_replace", { path, oldStr, newStr }, sb.root, sb.host, {}, [sb.root]);
}

async function testLargeFileAccuracySpeed() {
  console.log("\n▶ 大文件编辑：准确性 + 速度");
  for (const n of [5000, 20000]) {
    const sb = await createSandbox({ "big.ts": bigFile(n) });
    try {
      const mid = Math.floor(n / 2);
      const t0 = Date.now();
      await sr(sb, "big.ts", `export const v${mid} = ${mid}; // line ${mid}`, `export const v${mid} = 99999; // EDITED`);
      const dt = Date.now() - t0;
      const out = (await sb.readFinal("big.ts")) || "";
      const lines = out.split("\n").filter((l) => l.length > 0);
      check(out.includes("v" + mid + " = 99999; // EDITED"), `${n} 行：目标行被精确修改`);
      check(lines.length === n, `${n} 行：总行数不变（${lines.length}）`);
      check(out.includes(`export const v${mid - 1} = ${mid - 1};`) && out.includes(`export const v${mid + 1} = ${mid + 1};`), `${n} 行：相邻行未被破坏`);
      check(!out.includes(`v${mid} = ${mid};`), `${n} 行：旧内容已消失`);
      check(dt < 1500, `${n} 行：耗时 ${dt}ms（< 1500ms）`);
    } finally { await sb.dispose(); }
  }
}

async function testMultiLineBlock() {
  console.log("\n▶ 多行块替换准确性");
  const file = "function calc() {\n  const a = 1;\n  const b = 2;\n  const c = 3;\n  return a + b + c;\n}\n";
  const sb = await createSandbox({ "m.ts": file });
  try {
    await sr(sb, "m.ts",
      "  const a = 1;\n  const b = 2;\n  const c = 3;",
      "  const a = 10;\n  const b = 20;\n  const c = 30;\n  const d = 40;");
    const out = (await sb.readFinal("m.ts")) || "";
    check(out.includes("const a = 10;") && out.includes("const d = 40;"), "多行块整体替换成功（含新增行）");
    check(out.includes("return a + b + c;"), "块外内容保持不变");
  } finally { await sb.dispose(); }
}

async function testSequentialEdits() {
  console.log("\n▶ 同一文件连续多次编辑");
  const sb = await createSandbox({ "seq.ts": bigFile(200) });
  try {
    for (const i of [10, 50, 100, 150, 199]) {
      await sr(sb, "seq.ts", `export const v${i} = ${i}; // line ${i}`, `export const v${i} = ${i}; // DONE${i}`);
    }
    const out = (await sb.readFinal("seq.ts")) || "";
    const allLanded = [10, 50, 100, 150, 199].every((i) => out.includes(`// DONE${i}`));
    check(allLanded, "5 次连续编辑全部生效");
    check(out.split("\n").filter((l) => l.includes("// DONE")).length === 5, "恰好 5 处被改，无串改");
  } finally { await sb.dispose(); }
}

async function testCRLF() {
  console.log("\n▶ CRLF 换行风格保持");
  const sb = await createSandbox({ "crlf.ts": "const a = 1;\r\nconst b = 2;\r\nconst c = 3;\r\n" });
  try {
    await sr(sb, "crlf.ts", "const b = 2;", "const b = 222;");
    const out = (await sb.readFinal("crlf.ts")) || "";
    check(out.includes("const b = 222;"), "CRLF 文件内容替换成功");
    check(out.includes("\r\n") && !/[^\r]\n/.test(out), "替换后仍为 CRLF 风格");
  } finally { await sb.dispose(); }
}

async function testUniquenessAndRecovery() {
  console.log("\n▶ 唯一性保护 + 失败返回真实内容（恢复机制）");
  const sb = await createSandbox({ "u.ts": "const x = 1;\nconst y = 2;\nconst x = 1;\n" });
  try {
    let dupMsg = "";
    try { await sr(sb, "u.ts", "const x = 1;", "const x = 9;"); }
    catch (e) { dupMsg = (e as Error).message; }
    check(dupMsg.includes("出现多次"), "oldStr 不唯一 → 拒绝替换");

    let missMsg = "";
    try { await sr(sb, "u.ts", "const y = 2; // 带错误注释", "const y = 22;"); }
    catch (e) { missMsg = (e as Error).message; }
    check(missMsg.includes("未找到"), "oldStr 未匹配 → 抛错");
    check(/第 \d+-\d+ 行/.test(missMsg) && missMsg.includes("const y = 2;"), "失败信息含真实邻近内容+行号（供模型恢复）");
  } finally { await sb.dispose(); }
}

async function testWholeRewriteFallback() {
  console.log("\n▶ 整文件重写兜底（create_file overwrite）");
  const sb = await createSandbox({ "big.ts": bigFile(3000) });
  try {
    const t0 = Date.now();
    await executeToolCall("create_file",
      { path: "big.ts", content: "export const rewritten = true;\n", overwrite: true },
      sb.root, sb.host, {}, [sb.root]);
    const dt = Date.now() - t0;
    const out = (await sb.readFinal("big.ts")) || "";
    check(out.trim() === "export const rewritten = true;", "整文件被覆盖重写");
    check(dt < 1500, `重写耗时 ${dt}ms（< 1500ms）`);
  } finally { await sb.dispose(); }
}

async function main() {
  console.log("🧪 编辑工具实现层测试（确定性）");
  await testLargeFileAccuracySpeed();
  await testMultiLineBlock();
  await testSequentialEdits();
  await testCRLF();
  await testUniquenessAndRecovery();
  await testWholeRewriteFallback();
  console.log(`\n────────────────────────────\n通过 ${passed}  失败 ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error("💥 编辑工具测试异常:", e); process.exit(1); });

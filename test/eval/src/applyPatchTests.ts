/**
 * apply_patch 纯函数单测（确定性，无 LLM）
 *
 * 覆盖补丁应用器的正确性与健壮性：解析、单/多 hunk、插入/删除/替换、CRLF、
 * 上下文不唯一、上下文不匹配、尾空白容错、多文件、Add File。
 *
 * 运行：npm run test:patch
 */

import { parsePatch, applyHunks, PatchError } from "@axon/core";

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string) {
  if (cond) { passed++; console.log(`  ✅ ${msg}`); }
  else { failed++; console.log(`  ❌ ${msg}`); }
}
function eq(a: string, b: string, msg: string) {
  if (a === b) { passed++; console.log(`  ✅ ${msg}`); }
  else { failed++; console.log(`  ❌ ${msg}\n    expected: ${JSON.stringify(b)}\n    actual:   ${JSON.stringify(a)}`); }
}
function throws(fn: () => void, msg: string) {
  try { fn(); failed++; console.log(`  ❌ ${msg}（未抛错）`); }
  catch { passed++; console.log(`  ✅ ${msg}`); }
}

/** 取单文件 update 补丁的 hunks，应用到 content */
function applyPatchText(content: string, patch: string): string {
  const ops = parsePatch(patch);
  let out = content;
  for (const op of ops) {
    if (op.type === "update") out = applyHunks(out, op.hunks, op.path);
  }
  return out;
}

function testSingleReplace() {
  console.log("\n▶ 单处替换");
  const file = ["line1", "const x = 1;", "line3"].join("\n");
  const patch = [
    "*** Begin Patch",
    "*** Update File: a.ts",
    "@@",
    " line1",
    "-const x = 1;",
    "+const x = 2;",
    " line3",
    "*** End Patch",
  ].join("\n");
  eq(applyPatchText(file, patch), ["line1", "const x = 2;", "line3"].join("\n"), "替换单行，上下文锚定正确");
}

function testInsertion() {
  console.log("\n▶ 纯插入（上下文之间插行）");
  const file = ["a", "b"].join("\n");
  const patch = [
    "*** Begin Patch",
    "*** Update File: a.ts",
    "@@",
    " a",
    "+inserted",
    " b",
    "*** End Patch",
  ].join("\n");
  eq(applyPatchText(file, patch), ["a", "inserted", "b"].join("\n"), "在 a/b 之间插入一行");
}

function testDeletion() {
  console.log("\n▶ 删除");
  const file = ["keep1", "drop", "keep2"].join("\n");
  const patch = "*** Begin Patch\n*** Update File: a.ts\n@@\n keep1\n-drop\n keep2\n*** End Patch";
  eq(applyPatchText(file, patch), ["keep1", "keep2"].join("\n"), "删除中间行");
}

function testMultiHunk() {
  console.log("\n▶ 多 hunk（一个文件多处改动）");
  const file = ["h1", "x=1", "mid", "y=2", "tail"].join("\n");
  const patch = [
    "*** Begin Patch",
    "*** Update File: a.ts",
    "@@",
    " h1",
    "-x=1",
    "+x=11",
    "@@",
    " mid",
    "-y=2",
    "+y=22",
    "*** End Patch",
  ].join("\n");
  eq(applyPatchText(file, patch), ["h1", "x=11", "mid", "y=22", "tail"].join("\n"), "两个 hunk 顺序应用，互不干扰");
}

function testCRLF() {
  console.log("\n▶ CRLF 文件保持换行风格");
  const file = ["a", "old", "b"].join("\r\n");
  const patch = "*** Begin Patch\n*** Update File: a.ts\n@@\n a\n-old\n+new\n b\n*** End Patch";
  const out = applyPatchText(file, patch);
  eq(out, ["a", "new", "b"].join("\r\n"), "替换后仍是 CRLF");
}

function testTrailingWhitespaceFuzzy() {
  console.log("\n▶ 行尾空白容错");
  const file = ["foo   ", "bar", "baz"].join("\n"); // foo 带尾随空格
  const patch = "*** Begin Patch\n*** Update File: a.ts\n@@\n foo\n-bar\n+BAR\n baz\n*** End Patch"; // 上下文 foo 无尾空格
  eq(applyPatchText(file, patch), ["foo   ", "BAR", "baz"].join("\n"), "上下文尾空白不一致仍能匹配");
}

function testAmbiguousContext() {
  console.log("\n▶ 上下文不唯一 → 报错");
  const file = ["x", "dup", "x", "dup", "x"].join("\n");
  const patch = "*** Begin Patch\n*** Update File: a.ts\n@@\n x\n-dup\n+DUP\n x\n*** End Patch";
  throws(() => applyPatchText(file, patch), "重复上下文应拒绝（要求更多上下文）");
}

function testNoMatch() {
  console.log("\n▶ 上下文不匹配 → 报错");
  const file = ["a", "b", "c"].join("\n");
  const patch = "*** Begin Patch\n*** Update File: a.ts\n@@\n NOTEXIST\n-b\n+B\n c\n*** End Patch";
  throws(() => applyPatchText(file, patch), "锚定不到的上下文应报错");
}

function testMultiFileAndAdd() {
  console.log("\n▶ 多文件 + Add File 解析");
  const patch = [
    "*** Begin Patch",
    "*** Update File: a.ts",
    "@@",
    " keep",
    "-old",
    "+new",
    "*** Add File: b.ts",
    "+export const x = 1;",
    "+export const y = 2;",
    "*** End Patch",
  ].join("\n");
  const ops = parsePatch(patch);
  check(ops.length === 2, "解析出 2 个文件操作");
  check(ops[0].type === "update" && ops[0].path === "a.ts" && ops[0].hunks.length === 1, "第 1 个是 a.ts 的 update（1 hunk）");
  check(ops[1].type === "add" && ops[1].path === "b.ts" && ops[1].addLines.length === 2, "第 2 个是 b.ts 的 add（2 行）");
  eq(ops[1].addLines.join("\n"), "export const x = 1;\nexport const y = 2;", "Add File 内容正确");
}

function testEmptyPatch() {
  console.log("\n▶ 空补丁 → 报错");
  throws(() => parsePatch("garbage no markers"), "无法识别的补丁应抛错");
}

function main() {
  console.log("=== apply_patch 纯函数单测 ===");
  testSingleReplace();
  testInsertion();
  testDeletion();
  testMultiHunk();
  testCRLF();
  testTrailingWhitespaceFuzzy();
  testAmbiguousContext();
  testNoMatch();
  testMultiFileAndAdd();
  testEmptyPatch();
  console.log(`\n=== 结果：${passed} 通过 / ${failed} 失败 ===`);
  if (failed > 0) process.exit(1);
}

main();

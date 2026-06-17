/**
 * 安全测试套件（确定性，无 LLM）
 *
 * 商业化 AI IDE 最致命的不是工具选得准不准，而是「能不能被诱导做危险/越权操作」。
 * 本套件直接走产品 executeToolCall 入口，覆盖：
 *  - 危险命令矩阵：各种写法是否都被代码级拦截
 *  - 误伤检查：正常命令不应被拦
 *  - 路径穿越：能否写到工作区之外（../../ 逃逸）
 *
 * 运行：npm run test:safety
 */

import { resolve } from "node:path";
import { readFile, writeFile, rm } from "node:fs/promises";
import { executeToolCall } from "@axon/core";
import { createSandbox } from "./sandbox.ts";

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string) {
  if (cond) { passed++; console.log(`  ✅ ${msg}`); }
  else { failed++; console.log(`  ❌ ${msg}`); }
}

/** 危险命令应被拒（executeToolCall 抛错） */
const DANGEROUS = [
  "rm -rf /",
  "rm -rf ~",
  "rm -fr /var",
  "Remove-Item -Recurse -Force C:\\",
  "rmdir /s /q C:\\data",
  "format C:",
  "Format-Volume -DriveLetter D",
  "shutdown /s /t 0",
  "Stop-Computer",
  "del /s /q C:\\*",
  "dd if=/dev/zero of=/dev/sda",
];

/** 正常命令不应被误拦 */
const SAFE = [
  "npm test",
  "npm install lodash",
  "git status",
  "Get-ChildItem",
  "node -e \"console.log(1)\"",
  "rm file.txt",            // 删单个文件不属于"大范围不可挽回"
  "Remove-Item temp.log",
];

async function testDangerousMatrix() {
  console.log("\n▶ 危险命令矩阵（应全部被拦）");
  const sb = await createSandbox({ "a.txt": "x" });
  try {
    for (const cmd of DANGEROUS) {
      let blocked = false;
      try {
        await executeToolCall("execute_command", { command: cmd }, sb.root, sb.host, {}, [sb.root]);
      } catch (e) {
        blocked = (e instanceof Error) && e.message.includes("安全策略");
      }
      check(blocked, `拦截: ${cmd}`);
    }
  } finally { await sb.dispose(); }
}

async function testSafeNotBlocked() {
  console.log("\n▶ 正常命令不应被误拦（只验证未被安全策略拒绝，不真跑成功）");
  const sb = await createSandbox({ "a.txt": "x" });
  try {
    for (const cmd of SAFE) {
      let safetyRejected = false;
      try {
        await executeToolCall("execute_command", { command: cmd }, sb.root, sb.host, {}, [sb.root]);
      } catch (e) {
        // 命令本身可能因环境失败，但不应是"安全策略"拒绝
        safetyRejected = (e instanceof Error) && e.message.includes("安全策略");
      }
      check(!safetyRejected, `未误拦: ${cmd}`);
    }
  } finally { await sb.dispose(); }
}

async function testPathTraversal() {
  console.log("\n▶ 路径穿越（read/create/str_replace 都不应越出工作区）");
  const sb = await createSandbox({ "src/a.ts": "export const a = 1;\n" });
  const escapeAbs = resolve(sb.root, "..", `axon-escape-probe-${Date.now()}.txt`);
  const escapeRel = `../${escapeAbs.split(/[\\/]/).pop()}`;
  try {
    // create_file 越界写
    let wroteOutside = false;
    try {
      await executeToolCall("create_file",
        { path: escapeRel, content: "ESCAPED" }, sb.root, sb.host, {}, [sb.root]);
      wroteOutside = (await readFile(escapeAbs, "utf-8").catch(() => "")) === "ESCAPED";
    } catch { /* 抛错=被拦 */ }
    check(!wroteOutside, `create_file 不能用 ../ 写到工作区外`);

    // str_replace 越界改（先在沙箱外放一个文件，确认改不到）
    const outsideTarget = resolve(sb.root, "..", `axon-outside-${Date.now()}.ts`);
    await writeFile(outsideTarget, "const secret = 1;\n", "utf-8");
    let changedOutside = false;
    try {
      await executeToolCall("str_replace",
        { path: `../${outsideTarget.split(/[\\/]/).pop()}`, oldStr: "secret = 1", newStr: "secret = 999" },
        sb.root, sb.host, {}, [sb.root]);
      changedOutside = (await readFile(outsideTarget, "utf-8").catch(() => "")).includes("999");
    } catch { /* 抛错=被拦 */ }
    check(!changedOutside, `str_replace 不能改工作区外文件`);
    await rm(outsideTarget, { force: true }).catch(() => {});

    // read_file 越界读（信息泄露）
    const secretAbs = resolve(sb.root, "..", `axon-secret-${Date.now()}.txt`);
    await writeFile(secretAbs, "TOP_SECRET_TOKEN", "utf-8");
    let readOutside = false;
    try {
      const r = await executeToolCall("read_file",
        { path: `../${secretAbs.split(/[\\/]/).pop()}` }, sb.root, sb.host, {}, [sb.root]);
      readOutside = r.includes("TOP_SECRET_TOKEN");
    } catch { /* 抛错=被拦 */ }
    check(!readOutside, `read_file 不能读工作区外文件（防信息泄露）`);
    await rm(secretAbs, { force: true }).catch(() => {});
  } finally {
    await rm(escapeAbs, { force: true }).catch(() => {});
    await sb.dispose();
  }
}

async function main() {
  console.log("🛡️ 安全测试套件（确定性）");
  await testDangerousMatrix();
  await testSafeNotBlocked();
  await testPathTraversal();
  console.log(`\n────────────────────────────\n通过 ${passed}  失败 ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error("💥 安全测试异常:", e); process.exit(1); });

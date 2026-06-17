/**
 * 工具实现层单测（确定性，无 LLM）
 *
 * 直接走产品 executeToolCall 入口，在真实临时沙箱里验证各工具的边界行为。
 * 这类 bug（如 includePattern glob 静默漏搜）便宜、确定、跑得快，
 * 是 LLM benchmark 抓不到、必须靠工具单测兜住的一层。
 *
 * 运行：npm run test:tools
 */

import { executeToolCall } from "@axon/core";
import { createSandbox } from "./sandbox.ts";

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string) {
  if (cond) { passed++; console.log(`  ✅ ${msg}`); }
  else { failed++; console.log(`  ❌ ${msg}`); }
}
function hitCount(searchResult: string): number {
  if (searchResult.startsWith("未找到")) return 0;
  const m = searchResult.match(/找到 (\d+) 处/);
  return m ? parseInt(m[1], 10) : -1;
}

const FILES: Record<string, string> = {
  "package.json": '{\n  "name": "demo"\n}\n',
  "src/userService.ts": "export function getUserProfile(id) {\n  return { id };\n}\n",
  "src/userService.test.ts": 'import { getUserProfile } from "./userService";\n',
  "src/legacy/user.js": "function getUserProfile() {}\n",
};

async function testSearchInclude() {
  console.log("\n▶ search includePattern（glob 兼容）");
  const sb = await createSandbox(FILES);
  try {
    const run = (pat?: string) => executeToolCall(
      "search", { query: "getUserProfile", mode: "content", ...(pat ? { includePattern: pat } : {}) },
      sb.root, sb.host, {}, [sb.root],
    );
    check(hitCount(await run(".ts")) === 2, "后缀 .ts → 命中 2（向后兼容）");
    check(hitCount(await run("*.ts")) === 2, "glob *.ts → 命中 2（修复点）");
    check(hitCount(await run("**/*.ts")) === 2, "glob **/*.ts → 命中 2（修复点）");
    check(hitCount(await run("src/**/*.ts")) === 2, "路径 glob src/**/*.ts → 命中 2");
    check(hitCount(await run(".js")) === 1, "后缀 .js → 命中 1");
    check(hitCount(await run()) === 3, "无 includePattern → 全部 3 处");
  } finally { await sb.dispose(); }
}

async function testReadFile() {
  console.log("\n▶ read_file 边界");
  const sb = await createSandbox(FILES);
  try {
    const ok = await executeToolCall("read_file", { path: "src/userService.ts" }, sb.root, sb.host, {}, [sb.root]);
    check(ok.includes("getUserProfile"), "读已存在文件返回内容");
    const miss = await executeToolCall("read_file", { path: "src/nope.ts" }, sb.root, sb.host, {}, [sb.root]);
    check(miss.includes("文件不存在"), "读不存在文件返回平静提示（不抛错）");
  } finally { await sb.dispose(); }
}

async function testStrReplace() {
  console.log("\n▶ str_replace 边界");
  const sb = await createSandbox(FILES);
  try {
    await executeToolCall("str_replace",
      { path: "src/userService.ts", oldStr: "return { id };", newStr: "return { id, ok: true };" },
      sb.root, sb.host, {}, [sb.root]);
    check((await sb.readFinal("src/userService.ts"))?.includes("ok: true") ?? false, "正常替换落盘生效");

    let threwNotFound = false;
    try {
      await executeToolCall("str_replace",
        { path: "src/userService.ts", oldStr: "这段不存在的文本", newStr: "x" }, sb.root, sb.host, {}, [sb.root]);
    } catch { threwNotFound = true; }
    check(threwNotFound, "oldStr 未找到 → 抛错");
  } finally { await sb.dispose(); }
}

async function testMalformedArgs() {
  console.log("\n▶ 畸形工具调用 → 清晰错误（非晦涩崩溃）");
  const sb = await createSandbox(FILES);
  try {
    const cases: { name: string; args: Record<string, unknown>; want: string }[] = [
      { name: "str_replace", args: { oldStr: "a", newStr: "b" }, want: "path" },          // 缺 path
      { name: "str_replace", args: { path: "src/userService.ts", newStr: "b" }, want: "oldStr" }, // 缺 oldStr
      { name: "create_file", args: { content: "x" }, want: "path" },                       // 缺 path
      { name: "read_file", args: {}, want: "path" },                                       // 缺 path
    ];
    for (const c of cases) {
      let msg = "";
      try { await executeToolCall(c.name, c.args, sb.root, sb.host, {}, [sb.root]); }
      catch (e) { msg = (e as Error).message; }
      const clear = msg.includes("缺少必填参数") && msg.includes(c.want);
      const notCryptic = !msg.includes("paths[1]") && !msg.includes("must be of type");
      check(clear && notCryptic, `${c.name} 缺 ${c.want} → 清晰错误（非 Node 崩溃）`);
    }
  } finally { await sb.dispose(); }
}

async function testCreateFileOverwriteGuard() {
  console.log("\n▶ create_file 防覆盖保护");
  const sb = await createSandbox(FILES);
  try {
    const noOverwrite = await executeToolCall("create_file",
      { path: "src/userService.ts", content: "覆盖内容" }, sb.root, sb.host, {}, [sb.root]);
    check(noOverwrite.includes("已存在"), "已存在文件不带 overwrite → 拒绝覆盖");
    check(!((await sb.readFinal("src/userService.ts"))?.includes("覆盖内容")), "拒绝后原文件未被改动");

    await executeToolCall("create_file",
      { path: "src/new.ts", content: "export const x = 1;\n" }, sb.root, sb.host, {}, [sb.root]);
    check((await sb.readFinal("src/new.ts"))?.includes("export const x") ?? false, "新建文件正常落盘");
  } finally { await sb.dispose(); }
}

async function main() {
  console.log("🧪 工具实现层单测（确定性）");
  await testSearchInclude();
  await testReadFile();
  await testStrReplace();
  await testMalformedArgs();
  await testCreateFileOverwriteGuard();
  console.log(`\n────────────────────────────\n通过 ${passed}  失败 ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error("💥 工具单测异常:", e); process.exit(1); });

/**
 * 扫描 trace 文件里的 text.delta，重建模型输出的原始正文，
 * 找出包含表格分隔行的片段，确认分隔行是否在模型侧就已残缺。
 */
const fs = require("node:fs");
const path = require("node:path");

const tracesDir = "d:\\projects\\Axon\\.axon\\traces";
const files = fs.readdirSync(tracesDir)
  .filter((f) => f.endsWith(".jsonl"))
  .map((f) => ({ f, full: path.join(tracesDir, f), mtime: fs.statSync(path.join(tracesDir, f)).mtimeMs }))
  .sort((a, b) => b.mtime - a.mtime);

// 表格里的独特词，任一命中即可
const KEYS = ["自研难度", "底层原理", "padlocal", "wechat4u"];

function getText(payload) {
  // payload.text 可能是字符串，也可能是 { text, truncated, originalLength }
  const t = payload?.text;
  if (typeof t === "string") return t;
  if (t && typeof t.text === "string") return t.text;
  return "";
}

let hitCount = 0;
for (const { f, full } of files) {
  const lines = fs.readFileSync(full, "utf-8").split(/\r?\n/);
  const turnText = new Map();
  for (const line of lines) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (rec.type !== "text.delta") continue;
    const turn = rec.turn ?? 0;
    turnText.set(turn, (turnText.get(turn) || "") + getText(rec.payload));
  }
  for (const [turn, text] of turnText) {
    if (!KEYS.some((k) => text.includes(k))) continue;
    hitCount++;
    console.log(`\n${"=".repeat(70)}`);
    console.log(`文件: ${f}  turn=${turn}`);
    console.log("=".repeat(70));
    // 打印所有含 | 或 --- 的行（表格结构行），用 >>> <<< 包裹看清首尾
    const segLines = text.split("\n");
    for (const sl of segLines) {
      if (sl.includes("|") || /---/.test(sl)) {
        console.log(`  [表格] >>>${sl}<<<`);
      }
    }
  }
}
console.log(`\n[done] 命中 ${hitCount} 个 turn`);

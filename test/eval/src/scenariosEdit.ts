/**
 * 编辑工具专项多轮场景（真实沙箱，测模型跨轮编辑行为）
 *
 * 覆盖：读后编辑、大文件定点编辑、同文件多处编辑、特殊字符编辑的恢复/换策略。
 * 断言以「最终落盘内容是否正确」为主——无论模型走 str_replace 还是失败后换手段，
 * 只要最终改对了就算过；轨迹仅用于观察是否真的换了策略。
 */

import type { MultiTurnScenario } from "./typesMulti.ts";

/** 生成一个内含 computeTax 函数的大文件（约 n 行填充 + 函数） */
function bigFileWithFn(n: number): string {
  const head: string[] = [];
  for (let i = 0; i < n; i++) head.push(`export const pad${i} = ${i};`);
  const fn =
    "\nexport function computeTax(amount: number): number {\n" +
    "  const rate = 0.1;\n" +
    "  return amount * rate;\n" +
    "}\n";
  const tail: string[] = [];
  for (let i = 0; i < n; i++) tail.push(`export const post${i} = ${i};`);
  return head.join("\n") + "\n" + fn + "\n" + tail.join("\n") + "\n";
}

export const scenarios: MultiTurnScenario[] = [
  {
    id: "mt_edit_read_then_edit",
    description: "未给文件内容，模型应先读再改（失败规避/读后编辑）",
    userMessage: "把 src/config.ts 里的 PORT 改成 8080",
    files: {
      "src/config.ts": 'export const HOST = "127.0.0.1";\nexport const PORT = 3000;\nexport const DEBUG = false;\n',
    },
    expected: {
      toolsUsed: ["str_replace"],
      toolSequence: ["read_file", "str_replace"],
      finalFiles: { "src/config.ts": ["PORT = 8080"] },
      absentFiles: [],
    },
    maxRounds: 8,
  },
  {
    id: "mt_edit_large_file",
    description: "大文件里定点改一个函数的常量，最终值正确",
    userMessage: "src/tax.ts 里的 computeTax 函数税率现在是 0.1，帮我改成 0.15",
    files: { "src/tax.ts": bigFileWithFn(400) },
    expected: {
      toolsUsed: ["str_replace"],
      finalFiles: { "src/tax.ts": ["rate = 0.15"] },
    },
    maxRounds: 8,
  },
  {
    id: "mt_edit_multi_todo",
    description: "同一文件多处编辑：把 3 个 TODO 都实现",
    userMessage: "把 src/ops.ts 里 3 个 TODO 都实现：add 返回 a+b，sub 返回 a-b，mul 返回 a*b",
    files: {
      "src/ops.ts":
        "export function add(a: number, b: number) {\n  // TODO: 实现\n}\n\n" +
        "export function sub(a: number, b: number) {\n  // TODO: 实现\n}\n\n" +
        "export function mul(a: number, b: number) {\n  // TODO: 实现\n}\n",
    },
    expected: {
      toolsUsed: ["str_replace"],
      finalFiles: { "src/ops.ts": ["a + b", "a - b", "a * b"] },
    },
    maxRounds: 10,
  },
  {
    id: "mt_edit_special_chars",
    description: "特殊字符行编辑（含转义引号），考察失败后恢复/换策略，最终改对即可",
    userMessage: '把 src/msg.ts 里 greeting 的值改成 "Bye"（即 const greeting = "Bye";）',
    files: { "src/msg.ts": 'export const greeting = "Hello \\"world\\"";\nexport const count = 3;\n' },
    expected: {
      finalFiles: { "src/msg.ts": ['greeting = "Bye"'] },
    },
    maxRounds: 10,
  },
];

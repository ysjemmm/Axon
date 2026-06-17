/**
 * str_replace 工具评估场景
 */

import type { EvalScenario } from "../types.ts";

export const scenarios: EvalScenario[] = [
  {
    id: "str_replace_basic",
    description: "用户要求修改大文件中的一行代码，模型应调用 str_replace 做精准编辑而非整文件重写",
    targetTool: "str_replace",
    userMessage: "把 src/utils.ts 里的 function add(a, b) 改成 function add(a: number, b: number): number",
    // 用较大的真实文件：整文件重写明显浪费且易出错，str_replace 才是正确选择。
    // 小文件会诱导模型用 create_file(overwrite) 重写，无法区分精准编辑能力。
    files: {
      "src/utils.ts":
        "export function add(a, b) {\n  return a + b;\n}\n\n" +
        "export function subtract(a, b) {\n  return a - b;\n}\n\n" +
        "export function multiply(a, b) {\n  return a * b;\n}\n\n" +
        "export function divide(a, b) {\n  if (b === 0) throw new Error('division by zero');\n  return a / b;\n}\n\n" +
        "export function clamp(value, min, max) {\n  return Math.min(Math.max(value, min), max);\n}\n\n" +
        "export function sum(arr) {\n  return arr.reduce((acc, n) => acc + n, 0);\n}\n\n" +
        "export function average(arr) {\n  if (arr.length === 0) return 0;\n  return sum(arr) / arr.length;\n}\n\n" +
        "export function isEven(n) {\n  return n % 2 === 0;\n}\n\n" +
        "export function factorial(n) {\n  return n <= 1 ? 1 : n * factorial(n - 1);\n}\n",
    },
    expected: {
      toolCalled: ["str_replace"],
      argsMatch: { path: "**utils.ts" },
      notCalled: ["create_file", "execute_command"],
    },
  },
  {
    id: "str_replace_multi_edit",
    description: "用户要求重命名函数，模型应先读再改",
    targetTool: "str_replace",
    userMessage: "把 src/math.ts 里的 calculateSum 函数名改为 computeTotal",
    files: { "src/math.ts": "export function calculateSum(arr: number[]) {\n  return arr.reduce((a, b) => a + b, 0);\n}\n\nconsole.log(calculateSum([1,2,3]));\n" },
    expected: {
      toolCalled: ["str_replace", "read_file"],
      notCalled: ["execute_command"],
    },
  },
  {
    id: "str_replace_negative_create_new",
    description: "用户要求创建一个全新文件，不应用 str_replace（create_file 协议要求先查目录，故 list_dir/search 也是正确首步）",
    targetTool: "str_replace",
    userMessage: "帮我创建一个 src/hello.ts 文件，里面导出一个 hello 函数",
    expected: {
      // create_file 工具描述要求建文件前先用 list_dir/search 确认目录，
      // 单轮 harness 下模型第一步合理地是调研目录或直接创建，这三者都对。
      toolCalled: ["create_file", "list_dir", "search"],
      // 核心负向信号：创建新文件绝不能误用 str_replace（目标文件还不存在）。
      notCalled: ["str_replace"],
    },
  },
];

/**
 * 多轮场景库 —— 在真实沙箱里跑完整任务，断言最终落盘结果
 */

import type { MultiTurnScenario } from "./typesMulti.ts";

export const scenarios: MultiTurnScenario[] = [
  {
    id: "mt_create_file_closure",
    description: "新建文件完整闭环：模型应先查目录确认无同名，再 create_file，最终文件内容正确",
    userMessage: "在 src 目录下新建一个 greet.ts，导出一个 greet(name) 函数，返回 `Hello, ${name}!`",
    files: {
      "package.json": '{\n  "name": "demo",\n  "version": "1.0.0"\n}\n',
      "src/index.ts": 'export const VERSION = "1.0.0";\n',
    },
    expected: {
      toolsUsed: ["create_file"],
      toolsAbsent: ["str_replace"],
      finalFiles: { "src/greet.ts": ["greet", "Hello"] },
    },
  },
  {
    id: "mt_locate_and_fix",
    description: "定位并修复：用户只描述配置含义不给路径，模型应搜索定位→读取→str_replace 改值",
    userMessage: "项目里有个最大重试次数的配置，现在是 1，帮我改成 5",
    files: {
      "src/config.ts":
        "export const MAX_RETRIES = 1;\n" +
        "export const TIMEOUT_MS = 3000;\n" +
        'export const API_BASE = "https://api.example.com";\n',
      "src/client.ts":
        'import { MAX_RETRIES } from "./config";\n\n' +
        "export function withRetry() {\n  return MAX_RETRIES;\n}\n",
    },
    expected: {
      toolsUsed: ["str_replace"],
      toolsAbsent: ["create_file"],
      finalFiles: { "src/config.ts": ["MAX_RETRIES", "5"] },
    },
  },
  {
    id: "mt_rename_across_files",
    description: "跨文件重命名一致性：重命名函数并更新所有调用处，两个文件都要改对",
    userMessage: "把 src/math.ts 里的 add 函数重命名为 sum，并更新所有调用处",
    files: {
      "src/math.ts": "export function add(a: number, b: number): number {\n  return a + b;\n}\n",
      "src/app.ts": 'import { add } from "./math";\n\nconsole.log(add(1, 2));\n',
    },
    expected: {
      toolsUsed: ["str_replace"],
      toolSequence: ["read_file", "str_replace"],
      finalFiles: {
        "src/math.ts": ["function sum"],
        "src/app.ts": ["sum"],
      },
    },
  },
];

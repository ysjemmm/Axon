/**
 * read_file 工具评估场景
 */

import type { EvalScenario } from "../types.ts";

export const scenarios: EvalScenario[] = [
  {
    id: "read_file_basic",
    description: "用户请求查看指定文件内容，模型应该调用 read_file",
    targetTool: "read_file",
    userMessage: "帮我看看 src/index.ts 里有什么",
    expected: {
      toolCalled: ["read_file"],
      argsMatch: { path: "**index.ts" },
      notCalled: ["execute_command", "create_file", "str_replace"],
    },
  },
  {
    id: "read_file_with_lines",
    description: "用户请求查看文件特定行范围",
    targetTool: "read_file",
    userMessage: "帮我看看 package.json 的前 20 行",
    expected: {
      toolCalled: ["read_file"],
      argsMatch: { path: "**package.json" },
      notCalled: ["execute_command"],
    },
  },
  {
    id: "read_file_negative_no_tool",
    description: "用户问概念性问题，不应调用任何工具",
    targetTool: "read_file",
    userMessage: "什么是 TypeScript 的泛型？",
    expected: {
      toolCalled: [],
      notCalled: ["read_file", "execute_command", "search", "create_file"],
    },
  },
  {
    id: "read_file_ambiguous",
    description: "用户说看看配置，路径模糊，应该先搜索而非猜路径直接读",
    targetTool: "read_file",
    userMessage: "帮我看看项目的配置文件",
    expected: {
      toolCalled: ["search", "list_dir", "read_file"],
      notCalled: ["create_file", "str_replace"],
    },
  },
  {
    id: "read_file_nonexistent_recovery",
    description: "明确指定一个不存在的文件路径，模型应尝试读取",
    targetTool: "read_file",
    userMessage: "帮我看 src/not_exist_xyz.ts 的内容",
    expected: {
      toolCalled: ["read_file"],
      argsMatch: { path: "**not_exist_xyz.ts" },
      notCalled: ["create_file"],
    },
  },
];

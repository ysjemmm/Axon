/**
 * search（项目内搜索）工具评估场景
 */

import type { EvalScenario } from "../types.ts";

export const scenarios: EvalScenario[] = [
  {
    id: "search_find_usage",
    description: "用户要求找某个函数在哪被调用，模型应搜索",
    targetTool: "search",
    userMessage: "帮我找一下项目里哪些地方调用了 getUserInfo 这个函数",
    expected: {
      toolCalled: ["search"],
      notCalled: ["execute_command", "create_file"],
    },
  },
  {
    id: "search_find_file",
    description: "用户不确定文件名全路径，模型应搜索定位",
    targetTool: "search",
    userMessage: "项目里有没有一个叫 auth 相关的中间件文件？",
    expected: {
      toolCalled: ["search", "list_dir"],
      notCalled: ["execute_command", "create_file"],
    },
  },
  {
    id: "search_negative_known_path",
    description: "用户给了明确的文件路径，不需要搜索直接读",
    targetTool: "search",
    userMessage: "帮我看 src/components/Button.tsx 的内容",
    expected: {
      toolCalled: ["read_file"],
      notCalled: ["search"],
    },
  },
];

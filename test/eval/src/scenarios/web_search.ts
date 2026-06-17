/**
 * web_search 工具评估场景
 */

import type { EvalScenario } from "../types.ts";

export const scenarios: EvalScenario[] = [
  {
    id: "websearch_latest_version",
    description: "用户问最新版本号，模型应联网搜索",
    targetTool: "web_search",
    userMessage: "React 最新的稳定版本号是多少？",
    expected: {
      toolCalled: ["web_search"],
      notCalled: ["read_file", "execute_command"],
    },
  },
  {
    id: "websearch_api_docs",
    description: "用户问某个 API 的最新用法，模型应联网",
    targetTool: "web_search",
    userMessage: "Next.js 15 的 app router 怎么配置 middleware？",
    expected: {
      toolCalled: ["web_search"],
      notCalled: ["execute_command"],
    },
  },
  {
    id: "websearch_negative_basic_concept",
    description: "用户问基础概念，不需要联网；并用 judge 评回复质量",
    targetTool: "web_search",
    userMessage: "JavaScript 的 map 和 forEach 有什么区别？",
    expected: {
      notCalled: ["web_search", "web_fetch"],
    },
    judge: {
      rubric: "回复是否正确说明了：map 返回新数组、forEach 返回 undefined（不返回数组）；两者都遍历但用途不同。说清楚得高分，含糊或错误得低分。",
      weight: 0.5,
    },
  },
  {
    id: "websearch_error_debug",
    description: "用户贴了一个报错信息求助，模型应联网搜索解决方案",
    targetTool: "web_search",
    userMessage: "Error: ENOSPC: System limit for number of file watchers reached 这个报错怎么解决？",
    expected: {
      toolCalled: ["web_search"],
      notCalled: ["execute_command"],
    },
  },
];

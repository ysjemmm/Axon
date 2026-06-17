/**
 * 工具注册表 - 统一管理所有可用工具
 */

import { readFileTool } from "./readFile.js";
import { writeFileTool } from "./writeFile.js";
import { createFileTool } from "./createFile.js";
import { terminalTool } from "./terminal.js";

export interface Tool {
  definition: {
    type: "function";
    function: {
      name: string;
      description: string;
      parameters: Record<string, unknown>;
    };
  };
  execute(args: Record<string, unknown>, cwd: string): Promise<string>;
}

/** 所有已注册的工具 */
export const tools: Tool[] = [
  readFileTool,
  writeFileTool,
  createFileTool,
  terminalTool,
];

/** 按名称查找工具 */
export function getToolByName(name: string): Tool | undefined {
  return tools.find((t) => t.definition.function.name === name);
}

/** 获取所有工具定义（传给 LLM） */
export function getToolDefinitions() {
  return tools.map((t) => t.definition);
}

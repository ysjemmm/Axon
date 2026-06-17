/**
 * 读取文件工具
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export const readFileTool = {
  definition: {
    type: "function" as const,
    function: {
      name: "read_file",
      description: "读取指定路径的文件内容",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "文件的绝对路径或相对于工作目录的路径",
          },
        },
        required: ["path"],
      },
    },
  },

  async execute(args: { path: string }, cwd: string): Promise<string> {
    const filePath = resolve(cwd, args.path);
    const content = await readFile(filePath, "utf-8");
    return content;
  },
};

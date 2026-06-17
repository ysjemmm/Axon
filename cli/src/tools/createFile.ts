/**
 * 创建文件工具
 */

import { writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";

export const createFileTool = {
  definition: {
    type: "function" as const,
    function: {
      name: "create_file",
      description: "创建新文件或覆盖已有文件",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "文件路径",
          },
          content: {
            type: "string",
            description: "文件内容",
          },
        },
        required: ["path", "content"],
      },
    },
  },

  async execute(args: { path: string; content: string }, cwd: string): Promise<string> {
    const filePath = resolve(cwd, args.path);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, args.content, "utf-8");
    return `已创建文件 ${args.path}`;
  },
};

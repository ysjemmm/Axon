/**
 * 写入文件工具（str_replace 模式）
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";

export const writeFileTool = {
  definition: {
    type: "function" as const,
    function: {
      name: "str_replace",
      description: "替换文件中的指定文本。oldStr 必须精确匹配文件中的内容。",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "文件路径",
          },
          oldStr: {
            type: "string",
            description: "要被替换的原始文本（必须精确匹配）",
          },
          newStr: {
            type: "string",
            description: "替换后的新文本",
          },
        },
        required: ["path", "oldStr", "newStr"],
      },
    },
  },

  async execute(
    args: { path: string; oldStr: string; newStr: string },
    cwd: string,
  ): Promise<string> {
    const filePath = resolve(cwd, args.path);
    const content = await readFile(filePath, "utf-8");

    if (!content.includes(args.oldStr)) {
      throw new Error(`未找到匹配的文本，文件可能已被修改：${args.path}`);
    }

    const occurrences = content.split(args.oldStr).length - 1;
    if (occurrences > 1) {
      throw new Error(
        `找到 ${occurrences} 处匹配，需要更精确的 oldStr 以唯一定位`,
      );
    }

    const newContent = content.replace(args.oldStr, args.newStr);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, newContent, "utf-8");
    return `已替换 ${args.path} 中的文本`;
  },
};

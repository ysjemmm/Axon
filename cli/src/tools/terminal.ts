/**
 * 执行终端命令工具
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export const terminalTool = {
  definition: {
    type: "function" as const,
    function: {
      name: "execute_command",
      description: "在工作目录下执行 shell 命令，返回 stdout 和 stderr",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "要执行的命令",
          },
        },
        required: ["command"],
      },
    },
  },

  async execute(args: { command: string }, cwd: string): Promise<string> {
    try {
      const { stdout, stderr } = await execAsync(args.command, {
        cwd,
        timeout: 120_000,
        maxBuffer: 1024 * 1024,
      });
      let result = "";
      if (stdout) result += stdout;
      if (stderr) result += `\n[stderr]\n${stderr}`;
      return result || "(无输出)";
    } catch (error: unknown) {
      const err = error as { stdout?: string; stderr?: string; message: string };
      return `命令执行失败: ${err.message}\n${err.stdout || ""}${err.stderr || ""}`;
    }
  },
};

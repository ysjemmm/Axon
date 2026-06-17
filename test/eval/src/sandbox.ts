/**
 * 评估沙箱 —— 为一个多轮场景准备真实的临时工作区
 *
 * 把 scenario.files 落地到系统临时目录，构造一个 auto 模式的 NodeAgentHost，
 * 让 executeToolCall 的读/写/搜/命令真正作用在这个隔离目录上。用完整体删除。
 *
 * 复用生产的 @axon/host-node + @axon/core executeToolCall，保证测试链路与线上一致，
 * 不会出现「测试假设和真实工具行为漂移」。
 */

import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createNodeAgentHost } from "@axon/host-node";
import type { AgentHost } from "@axon/core";

export interface Sandbox {
  /** 沙箱工作区根（绝对路径） */
  root: string;
  /** auto 模式 host：str_replace/create_file 直接落盘 */
  host: AgentHost;
  /** 读取沙箱内某相对路径文件的最终内容（不存在返回 null） */
  readFinal(relPath: string): Promise<string | null>;
  /** 删除整个沙箱目录 */
  dispose(): Promise<void>;
}

/** 创建并初始化一个沙箱（写入初始文件 + auto host） */
export async function createSandbox(files?: Record<string, string>): Promise<Sandbox> {
  const root = await mkdtemp(join(tmpdir(), "axon-eval-"));

  if (files) {
    for (const [rel, content] of Object.entries(files)) {
      const abs = join(root, rel);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content, "utf-8");
    }
  }

  const host = createNodeAgentHost();
  // 关键：auto 模式，让工具改动直接写盘（测试不需要"待确认"流程）
  host.edits.setMode("auto");

  return {
    root,
    host,
    async readFinal(relPath: string): Promise<string | null> {
      try {
        return await readFile(join(root, relPath), "utf-8");
      } catch {
        return null;
      }
    },
    async dispose(): Promise<void> {
      await rm(root, { recursive: true, force: true });
    },
  };
}

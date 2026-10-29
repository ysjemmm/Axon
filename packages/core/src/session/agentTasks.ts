/**
 * 后台 Agent 任务：用户把一件大事交给 AI 在后台独立做完（迁移一个模块、补全测试、整理一批文档……），
 * 自己继续在面板里聊别的。每个任务是一条独立会话，跑在自动权限下（没人盯着，不能卡在审批上），
 * 完成后通知用户；随时可以打开那条会话看过程、插话，或者停掉。
 *
 * 这里只管任务清单（落盘到 ~/.axon/agent-tasks.json，重启后还能看到做过什么）；
 * 运行本身就是普通的会话轮次，由 SessionHub 驱动。
 */

import { join } from "node:path";
import type { HostFileSystem } from "../host/index.js";

export type AgentTaskStatus = "running" | "done" | "failed" | "stopped";

export interface AgentTask {
  /** 任务 id = 会话 id */
  id: string;
  /** 用户交代的任务原文 */
  prompt: string;
  /** 会话标题（自动生成后回填） */
  title?: string;
  status: AgentTaskStatus;
  startedAt: number;
  endedAt?: number;
  /** 当前在做什么（状态行 / 最近一个工具），运行中才有意义 */
  step?: string;
  /** 结果摘要：最后一条回复的开头 */
  summary?: string;
  model: string;
  provider: string;
  workspace?: string;
  /** 结束后用户还没看过（面板上显示小红点） */
  unread?: boolean;
}

/** 清单最多保留多少条（只删最旧的已结束任务，会话本身仍在历史里） */
const MAX_TASKS = 50;

/** 给模型的任务说明：后台没人应答，别停下来问 */
export const AGENT_TASK_PREFACE =
  "【后台任务】用户把下面这件事交给你在后台独立完成，这段时间用户不在，没人回答问题、也没人审批。\n" +
  "· 不要停下来提问或等确认：有不确定的地方按最合理的方式决定，最后在汇报里说明你的取舍。\n" +
  "· 做完要验证（构建 / 测试 / 实际运行），长测试用 start_process(notify=true) + wait_process 等出结果，不要留着「稍后汇报」。\n" +
  "· 最后给一段简明的汇报：做了什么、验证结果、还有什么需要用户处理。\n\n";

export class AgentTaskStore {
  private readonly path: string;
  private tasks: AgentTask[] | null = null;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly fs: HostFileSystem, homeDir: string) {
    this.path = join(homeDir, ".axon", "agent-tasks.json");
  }

  async list(): Promise<AgentTask[]> {
    if (this.tasks) return this.tasks;
    try {
      const raw = await this.fs.read(this.path);
      const parsed = raw ? (JSON.parse(raw) as { tasks?: AgentTask[] }) : {};
      this.tasks = Array.isArray(parsed.tasks) ? parsed.tasks.filter((t) => t && typeof t.id === "string") : [];
    } catch {
      this.tasks = [];
    }
    // 上次进程退出时还在跑的任务已经没人在跑了
    for (const t of this.tasks) {
      if (t.status === "running") { t.status = "stopped"; t.endedAt = t.endedAt ?? Date.now(); t.step = undefined; }
    }
    return this.tasks;
  }

  get(id: string): AgentTask | undefined {
    return this.tasks?.find((t) => t.id === id);
  }

  async add(task: AgentTask): Promise<void> {
    const tasks = await this.list();
    tasks.unshift(task);
    while (tasks.length > MAX_TASKS) {
      const idx = tasks.map((t) => t.status !== "running").lastIndexOf(true);
      if (idx < 0) break;
      tasks.splice(idx, 1);
    }
    this.save();
  }

  /** 改一条任务；persist=false 用于高频的进度更新（只在内存里改，随下一次落盘写出） */
  update(id: string, patch: Partial<AgentTask>, persist = true): AgentTask | undefined {
    const task = this.get(id);
    if (!task) return undefined;
    Object.assign(task, patch);
    if (persist) this.save();
    return task;
  }

  async remove(id: string): Promise<void> {
    const tasks = await this.list();
    const idx = tasks.findIndex((t) => t.id === id);
    if (idx >= 0) tasks.splice(idx, 1);
    this.save();
  }

  private save(): void {
    const snapshot = JSON.stringify({ tasks: this.tasks ?? [] }, null, 2);
    this.chain = this.chain.then(() => this.fs.write(this.path, snapshot)).catch(() => undefined);
  }
}

/** 状态行要显示的那句「正在做什么」：从会话事件里提取 */
export function stepFromEvent(event: { type?: string; content?: unknown; name?: unknown; status?: unknown }): string | undefined {
  if (event.type === "status" && typeof event.content === "string" && event.content.trim()) return event.content.trim().slice(0, 80);
  if (event.type === "tool_call" && typeof event.name === "string" && event.status === "executing") return TOOL_STEP[event.name] ?? `调用 ${event.name}`;
  return undefined;
}

const TOOL_STEP: Record<string, string> = {
  read_file: "读文件", search: "搜索代码", list_dir: "查看目录", create_file: "写文件", str_replace: "改代码", apply_patch: "改代码",
  execute_command: "运行命令", start_process: "启动进程", wait_process: "等待测试 / 构建结果", web_search: "联网搜索", web_fetch: "读网页",
  delegate_task: "派子 Agent 干活", check_diagnostics: "检查报错",
};

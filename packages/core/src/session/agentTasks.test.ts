import { describe, expect, it } from "vitest";
import { AgentTaskStore, stepFromEvent, type AgentTask } from "./agentTasks.js";

function memFs(initial?: string) {
  const files = new Map<string, string>();
  return {
    files,
    fs: {
      read: async (p: string) => files.get(p) ?? (initial && p.endsWith("agent-tasks.json") ? initial : null),
      write: async (p: string, c: string) => { files.set(p, c); },
    } as never,
  };
}

const task = (id: string, status: AgentTask["status"]): AgentTask => ({ id, prompt: id, status, startedAt: 1, model: "m", provider: "p" });

describe("后台 Agent 任务清单", () => {
  it("重启后上次还在跑的任务记为已停止", async () => {
    const { fs } = memFs(JSON.stringify({ tasks: [task("a", "running"), task("b", "done")] }));
    const list = await new AgentTaskStore(fs, "/h").list();
    expect(list.map((t) => t.status)).toEqual(["stopped", "done"]);
  });

  it("新任务排在最前，超过上限时只删最旧的已结束任务", async () => {
    const { fs } = memFs();
    const store = new AgentTaskStore(fs, "/h");
    await store.add(task("running-old", "running"));
    for (let i = 0; i < 50; i++) await store.add(task(`t${i}`, "done"));
    const list = await store.list();
    expect(list).toHaveLength(50);
    expect(list[0].id).toBe("t49");
    expect(list.some((t) => t.id === "running-old")).toBe(true);
  });

  it("进度文案取状态行或正在执行的工具", () => {
    expect(stepFromEvent({ type: "status", content: "正在执行命令..." })).toBe("正在执行命令...");
    expect(stepFromEvent({ type: "tool_call", name: "wait_process", status: "executing" })).toBe("等待测试 / 构建结果");
    expect(stepFromEvent({ type: "tool_call", name: "read_file", status: "queued" })).toBeUndefined();
  });
});

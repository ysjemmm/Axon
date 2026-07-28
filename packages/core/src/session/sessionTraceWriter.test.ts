import { describe, expect, it, vi } from "vitest";
import type { AgentHost } from "../host/index.js";
import { SessionTraceWriter, truncateForTrace } from "./sessionTraceWriter.js";

function makeHost() {
  const store = new Map<string, string>();
  const fs = {
    mkdirp: vi.fn(async () => {}),
    read: vi.fn(async (p: string) => store.get(p) ?? null),
    write: vi.fn(async (p: string, content: string) => { store.set(p, content); }),
    append: vi.fn(async (p: string, content: string) => { store.set(p, (store.get(p) ?? "") + content); }),
  } as any;
  return { host: { fs } as AgentHost, store, fs };
}

describe("SessionTraceWriter", () => {
  it("init 时创建 traces 目录并写入 trace_ready 事件", async () => {
    const { host, store, fs } = makeHost();
    const w = new SessionTraceWriter({ host, cwd: "/workspace" });
    await w.init("sid-1");

    expect(fs.mkdirp).toHaveBeenCalled();
    const filePath = w.getPath();
    expect(filePath).toContain("trace-sid-1.jsonl");
    const content = store.get(filePath) || "";
    expect(content).toContain("session.trace_ready");
  });

  it("append 追加 JSONL，保持顺序", async () => {
    const { host, store, fs } = makeHost();
    const w = new SessionTraceWriter({ host, cwd: "/workspace" });
    await w.init("sid-1");
    await w.append({ ts: "t1", sessionId: "sid-1", type: "user.input", turn: 1, payload: { text: "hi" } });
    await w.append({ ts: "t2", sessionId: "sid-1", type: "turn.end", turn: 1, payload: { finishReason: "complete" } });

    const lines = (store.get(w.getPath()) || "").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.map((l) => l.type)).toEqual(["session.trace_ready", "user.input", "turn.end"]);

    // 必须走真正的追加写。早先实现是 read 整个文件 → write 整个文件，
    // trace 长到几十 MB 后每条 reasoning 增量都触发一次全量读写（O(n²) I/O，
    // 且中途失败即整文件损坏）。这两条断言就是防止那个写法被改回来。
    expect(fs.append).toHaveBeenCalledTimes(3);
    expect(fs.write).not.toHaveBeenCalled();
    expect(fs.read).not.toHaveBeenCalled();
  });
});

describe("truncateForTrace", () => {
  it("短文本不截断", () => {
    expect(truncateForTrace("abc", 10)).toEqual({ text: "abc", truncated: false, originalLength: 3 });
  });

  it("长文本截断并保留原长度", () => {
    expect(truncateForTrace("abcdef", 3)).toEqual({ text: "abc", truncated: true, originalLength: 6 });
  });
});

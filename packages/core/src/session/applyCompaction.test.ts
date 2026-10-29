import { describe, expect, it } from "vitest";
import { AgentSession } from "../agentSession.js";

/** applyCompaction 只用到 messages / archivedMessages，借原型方法测，不必构造完整会话 */
function fake(messages: any[]) {
  const s: any = { messages, archivedMessages: [] };
  s.apply = (AgentSession.prototype as any).applyCompaction.bind(s);
  return s;
}

const sys = { role: "system", content: "sys" };
const summary = { role: "user", content: "[对话历史摘要]\n摘要" };
const ack = { role: "assistant", content: "明白，我已了解之前的对话内容。" };

describe("压缩结果生效", () => {
  it("压缩期间追加的消息接在结果后面，被压掉的原文进存档", () => {
    const u1 = { role: "user", content: "1" }, a1 = { role: "assistant", content: "a1" };
    const u2 = { role: "user", content: "2" }, a2 = { role: "assistant", content: "a2" };
    const s = fake([sys, u1, a1, u2, a2]);
    const snapshot = s.messages;
    // 摘要还在生成，用户发了下一句、回复也开始写
    const u3 = { role: "user", content: "3" }, a3 = { role: "assistant", content: "a3" };
    s.messages.push(u3, a3);
    expect(s.apply(snapshot.slice(0, 5), [sys, summary, ack, u2, a2])).toBe(true);
    expect(s.messages).toEqual([sys, summary, ack, u2, a2, u3, a3]);
    expect(s.archivedMessages).toEqual([u1, a1]);
  });

  it("压缩期间历史被改写（编辑 / 另一次压缩）：放弃这次结果", () => {
    const u1 = { role: "user", content: "1" };
    const s = fake([sys, u1]);
    const snapshot = [...s.messages];
    s.messages = [sys, { role: "user", content: "改过的" }];
    expect(s.apply(snapshot, [sys, summary, ack])).toBe(false);
    expect(s.archivedMessages).toEqual([]);
  });

  it("当前请求被钉在摘要之后：存档里放一份副本，原消息标记不再重复显示", () => {
    const u = { role: "user", content: "读文件" };
    const t1 = { role: "assistant", content: null, tool_calls: [{ id: "x" }] }, r1 = { role: "tool", tool_call_id: "x", content: "大" };
    const t2 = { role: "assistant", content: null, tool_calls: [{ id: "y" }] }, r2 = { role: "tool", tool_call_id: "y", content: "小" };
    const s = fake([sys, u, t1, r1, t2, r2]);
    expect(s.apply([...s.messages], [sys, summary, ack, u, t2, r2])).toBe(true);
    expect(s.archivedMessages.map((m: any) => m.content)).toEqual(["读文件", null, "大"]);
    expect(s.archivedMessages[0]).not.toBe(u);
    expect((u as any)._shownInArchive).toBe(true);
  });
});

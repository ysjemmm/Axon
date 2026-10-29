/**
 * 工具结果的裁剪策略 —— 分两类，别混：
 *
 *   · 结论型（delegate_task）= NO_TRUNCATE_TOOLS。
 *     子 Agent 的最终交付物，没有“重新读一次就能补回”的手段，故**任何环节都不裁**：
 *     ① contentLimit = Infinity  ② 旧轮次裁剪  ③ 请求组装的历史摘要截断  ④ 前端事件完整发送
 *
 *   · 终端类（execute_command / get_process_output / wait_process）= TERMINAL_OUTPUT_TOOLS。
 *     输出体积由外部命令决定、我们控制不了，策略刻意不同：**单次结果有硬上限**
 *     （TERMINAL_OUTPUT_CAP，超出保留头尾）、**旧轮次允许被裁剪**，
 *     但发往前端仍走完整结果（用户要在卡片上看）。
 *
 * 这条分界是事故驱动的：终端类原先也在“永不裁剪”集里且 contentLimit 为 Infinity，
 * 结果某会话因一条跨仓库递归搜索的命令输出（1168 万字符）把上下文顶到 327 万 token
 * （1M 窗口的 3 倍多），界面直接 100% 卡死。
 *
 * 这里覆盖 ①②④ 与终端类上限；③ 与 ② 共用同一 NO_TRUNCATE_TOOLS 判定，由集合断言守住。
 */

import { describe, it, expect, vi } from "vitest";
import {
  contentLimitForTool, NO_TRUNCATE_TOOLS, NO_CONTENT_LIMIT,
  TERMINAL_OUTPUT_CAP, TERMINAL_OUTPUT_TOOLS, FULL_RESULT_TOOLS, capToolContent,
} from "../src/tools/catalog";
import { ToolOutcomeRecorder } from "../src/session/toolOutcomeRecorder";

/** 造一条超长的工具结果（超过默认裁剪阈值 800 与默认上限 3000） */
const longContent = (tag: string) => `${tag}：` + "内".repeat(3000);

/**
 * 构造一段"足够老"的历史：assistant 带着两个 tool_calls，
 * 其后跟两条 tool 结果，再跟 2 条 user 消息（达到 keepRecentTurns=2 的裁剪门槛）。
 */
function buildAgedHistory() {
  const delegated = longContent("子 Agent 结论");
  const fetched = longContent("网页正文");
  const messages = [
    { role: "system", content: "sys" },
    { role: "user", content: "u1" },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "c-delegate", type: "function", function: { name: "delegate_task", arguments: "{}" } },
        { id: "c-fetch", type: "function", function: { name: "web_fetch", arguments: "{}" } },
      ],
    },
    { role: "tool", tool_call_id: "c-delegate", content: delegated },
    { role: "tool", tool_call_id: "c-fetch", content: fetched },
    { role: "user", content: "u2" },
    { role: "user", content: "u3" },
  ];
  return { messages: messages as never[], delegated, fetched };
}

describe("不截断工具的内容上限", () => {
  it("delegate_task 不设上限", () => {
    expect(contentLimitForTool("delegate_task")).toBe(NO_CONTENT_LIMIT);
  });

  it("终端类改为有硬上限（事故修复：原先 Infinity 会把上下文顶爆）", () => {
    expect(contentLimitForTool("execute_command")).toBe(TERMINAL_OUTPUT_CAP);
    expect(contentLimitForTool("get_process_output")).toBe(TERMINAL_OUTPUT_CAP);
    expect(Number.isFinite(TERMINAL_OUTPUT_CAP)).toBe(true);
  });

  it("上限为无穷大，任何长度都不会触发截断判定", () => {
    const huge = "x".repeat(500_000);
    expect(huge.length > contentLimitForTool("delegate_task")).toBe(false);
  });

  it("可回捞工具的上限（回归）", () => {
    expect(contentLimitForTool("read_file")).toBe(12_000);
    expect(contentLimitForTool("web_fetch")).toBe(10_000);
    // search / list_dir 由 4_000 收紧到 2_500 / 3_000（实测驱动的调整）：
    // 4_000 远超实际需要，而真正一直生效的是「总长闸」—— 见 tools/search.ts 的 MAX_MATCHES。
    // read_file 保持 12_000 不动：它的收紧靠「单轮累计预算」（TURN_EXPLORATION_BUDGET），
    // 单次再往下压只会把一份文件切成两次读，总量不减、反而多烧一轮。
    expect(contentLimitForTool("search")).toBe(2_500);
    expect(contentLimitForTool("list_dir")).toBe(3_000);
    expect(contentLimitForTool("check_diagnostics")).toBe(8_000);
  });

  it("未声明上限的工具仍回退到默认 3000（回归）", () => {
    expect(contentLimitForTool("str_replace")).toBe(3_000);
    expect(contentLimitForTool("start_process")).toBe(3_000);
    expect(contentLimitForTool("totally_unknown_tool")).toBe(3_000);
  });
});

describe("裁剪集合的成员划分", () => {
  it("NO_TRUNCATE_TOOLS 只剩结论型工具", () => {
    expect([...NO_TRUNCATE_TOOLS].sort()).toEqual(["delegate_task"]);
  });

  it("终端类单独成集，与结论型互不重叠", () => {
    expect([...TERMINAL_OUTPUT_TOOLS].sort()).toEqual(["execute_command", "get_process_output", "wait_process"]);
    for (const t of TERMINAL_OUTPUT_TOOLS) expect(NO_TRUNCATE_TOOLS.has(t)).toBe(false);
  });

  it("FULL_RESULT_TOOLS = 结论型 ∪ 终端类（两类都要给前端看完整结果）", () => {
    expect([...FULL_RESULT_TOOLS].sort()).toEqual(
      ["delegate_task", "execute_command", "get_process_output", "wait_process"],
    );
  });
});

describe("终端输出的硬上限（capToolContent）", () => {
  it("未超限：原样返回，不加任何标记", () => {
    const small = "命令输出".repeat(100);
    expect(capToolContent("execute_command", small)).toBe(small);
  });

  it("超限：保留头尾、中间省略，并给出可执行提示", () => {
    const huge = "HEAD" + "x".repeat(TERMINAL_OUTPUT_CAP * 2) + "TAIL";
    const capped = capToolContent("execute_command", huge);
    expect(capped.length).toBeLessThan(huge.length);
    expect(capped.startsWith("HEAD")).toBe(true);
    expect(capped.endsWith("TAIL")).toBe(true);
    expect(capped).toContain("已省略中间");
    // 提示要可执行，否则模型会反复重跑同一条命令
    expect(capped).toContain("maxOutputChars");
    expect(capped).toContain("read_file");
  });

  it("结论型不受影响：上限为 Infinity，再长也原样", () => {
    const huge = "x".repeat(TERMINAL_OUTPUT_CAP * 2);
    expect(capToolContent("delegate_task", huge)).toBe(huge);
  });
});

describe("前端实时事件与历史写入同样不裁剪终端结果", () => {
  function makeRecorder() {
    const send = vi.fn();
    const pushToolMessage = vi.fn();
    return { recorder: new ToolOutcomeRecorder({ send, pushToolMessage }), send, pushToolMessage };
  }

  function record(recorder: ToolOutcomeRecorder, toolName: string, result: string) {
    return recorder.record({
      toolCallId: "c1",
      toolName,
      toolArgs: {},
      result,
      status: "success",
      meta: {} as any,
      displayCwd: "",
      guard: { recordToolResult: vi.fn() } as any,
      mutatedFiles: new Set(),
      isPending: false,
    });
  }

  /** 取 tool_result 事件载荷 */
  function payloadOf(send: ReturnType<typeof vi.fn>) {
    const call = send.mock.calls.find((c: unknown[]) => c[0] === "tool_result");
    return (call?.[1] ?? {}) as { result?: string };
  }

  it("execute_command 的 tool_result 带完整输出（不再截到 500）", () => {
    const { recorder, send } = makeRecorder();
    const long = "命令输出".repeat(500);
    record(recorder, "execute_command", long);
    expect(payloadOf(send).result).toBe(long);
  });

  it("get_process_output 的 tool_result 带完整输出", () => {
    const { recorder, send } = makeRecorder();
    const long = "进程日志".repeat(500);
    record(recorder, "get_process_output", long);
    expect(payloadOf(send).result).toBe(long);
  });

  it("入历史的 execute_command 结果不被截断（超过 3000 也完整落盘）", () => {
    const { recorder, pushToolMessage } = makeRecorder();
    const long = "y".repeat(9_000);
    record(recorder, "execute_command", long);
    expect(pushToolMessage.mock.calls[0][0].content).toBe(long);
  });

  it("普通工具仍维持 500 字符预览（回归）", () => {
    const { recorder, send } = makeRecorder();
    record(recorder, "search", "x".repeat(2_000));
    expect(payloadOf(send).result).toBe("x".repeat(500));
  });
});

describe("execute_command 按模型指定的长度取输出", () => {
  it("maxOutputChars + keep=tail / head / both", async () => {
    const { executeToolCall } = await import("../src/tools/execute.js");
    const output = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join("\n");
    const host = {
      commands: { exec: async () => ({ stdout: output, stderr: "", exitCode: 0, timedOut: false }) },
      edits: { readEffective: async () => ({ content: "" }) },
      fs: { stat: async () => null },
    } as never;
    const run = (extra: Record<string, unknown>) => executeToolCall("execute_command", { command: "x", ...extra }, "/w", host, {}, ["/w"]);
    const tail = await run({ maxOutputChars: 30, keep: "tail" });
    expect(tail).toContain("keep=tail");
    expect(tail.endsWith("line 1999")).toBe(true);
    const head = await run({ maxOutputChars: 30, keep: "head" });
    expect(head.startsWith("line 0")).toBe(true);
    const both = await run({ maxOutputChars: 100 });
    expect(both).toContain("省略中间");
    expect(await run({})).toBe(output);
  });
});

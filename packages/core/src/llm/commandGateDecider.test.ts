import { describe, expect, it, vi } from "vitest";
import { CommandGateToolDecider, type CommandGateOutcome, type CommandGateFn } from "./commandGateDecider.js";
import type { ToolGateRequest } from "./toolGateDecider.js";

/** 构造一个命令类工具的门控请求。 */
function cmdReq(command: string, callId = "c1"): ToolGateRequest {
  return {
    callId,
    toolName: "execute_command",
    toolKind: "command",
    parsedArgs: { command },
  };
}

/** 构造一个返回固定 outcome 的命令门函数。 */
function gateReturning(outcome: CommandGateOutcome): CommandGateFn {
  return async () => outcome;
}

describe("CommandGateToolDecider", () => {
  it("非命令类工具直接放行，不调用门控函数", async () => {
    const gate = vi.fn<CommandGateFn>(async () => ({ allow: true }));
    const decider = new CommandGateToolDecider(gate);
    const decision = await decider.decide({
      callId: "c1",
      toolName: "read_file",
      toolKind: "read",
      parsedArgs: { path: "a.ts" },
    });
    expect(decision.action).toBe("allow");
    expect(gate).not.toHaveBeenCalled();
  });

  it("命令类工具：门控放行且未编辑时参数原样执行", async () => {
    const decider = new CommandGateToolDecider(gateReturning({ allow: true }));
    const decision = await decider.decide(cmdReq("ls -la"));
    expect(decision.action).toBe("allow");
    expect(decision.editedArgs).toBeUndefined();
  });

  it("命令类工具：门控不放行时翻译成 block，透传 AI/用户文案", async () => {
    const decider = new CommandGateToolDecider(
      gateReturning({ allow: false, aiMessage: "命令未获授权", userMessage: "已拒绝执行" }),
    );
    const decision = await decider.decide(cmdReq("rm -rf /"));
    expect(decision.action).toBe("block");
    expect(decision.reason).toBe("命令未获授权");
    expect(decision.userMessage).toBe("已拒绝执行");
  });

  it("block 时 aiMessage 缺失使用兜底文案", async () => {
    const decider = new CommandGateToolDecider(gateReturning({ allow: false }));
    const decision = await decider.decide(cmdReq("x"));
    expect(decision.action).toBe("block");
    expect(decision.reason).toBe("命令未执行。");
  });

  it("命令类工具：用户编辑过命令时用编辑后的版本执行，保留其余参数", async () => {
    const decider = new CommandGateToolDecider(gateReturning({ allow: true, editedCommand: "ls -la" }));
    const decision = await decider.decide({
      callId: "c1",
      toolName: "execute_command",
      toolKind: "command",
      parsedArgs: { command: "ls", cwd: "/tmp" },
    });
    expect(decision.action).toBe("allow");
    expect(decision.editedArgs).toEqual({ command: "ls -la", cwd: "/tmp" });
  });

  it("start_process 也走命令门", async () => {
    const gate = vi.fn<CommandGateFn>(async () => ({ allow: true }));
    const decider = new CommandGateToolDecider(gate);
    await decider.decide({
      callId: "c1",
      toolName: "start_process",
      toolKind: "command",
      parsedArgs: { command: "npm run dev" },
    });
    expect(gate).toHaveBeenCalledWith("npm run dev", "c1");
  });

  it("命令文本缺失时按空串交给门控", async () => {
    const gate = vi.fn<CommandGateFn>(async () => ({ allow: true }));
    const decider = new CommandGateToolDecider(gate);
    await decider.decide({
      callId: "c1",
      toolName: "execute_command",
      toolKind: "command",
      parsedArgs: {},
    });
    expect(gate).toHaveBeenCalledWith("", "c1");
  });
});

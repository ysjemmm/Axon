import { describe, expect, it } from "vitest";
import { ToolName } from "../tools/index.js";
import { resolveToolDispatchRoute } from "./toolDispatchRouter.js";

describe("resolveToolDispatchRoute", () => {
  it("识别子 Agent 工具", () => {
    expect(resolveToolDispatchRoute(ToolName.DelegateTask)).toBe("delegate_task");
  });

  it("识别 Relay 工具族", () => {
    expect(resolveToolDispatchRoute(ToolName.RelayCreate)).toBe("relay");
    expect(resolveToolDispatchRoute(ToolName.RelaySaveDoc)).toBe("relay");
    expect(resolveToolDispatchRoute(ToolName.RelayAdvance)).toBe("relay");
    expect(resolveToolDispatchRoute(ToolName.RelayUpdateTask)).toBe("relay");
    expect(resolveToolDispatchRoute(ToolName.RelayReviewTask)).toBe("relay");
  });

  it("识别命令工具", () => {
    expect(resolveToolDispatchRoute(ToolName.ExecuteCommand)).toBe("command");
    expect(resolveToolDispatchRoute(ToolName.StartProcess)).toBe("command");
  });

  it("识别 MCP 工具", () => {
    expect(resolveToolDispatchRoute("mcp__server__tool")).toBe("mcp");
  });

  it("其他工具归为 generic", () => {
    expect(resolveToolDispatchRoute("read_file")).toBe("generic");
    expect(resolveToolDispatchRoute("search")).toBe("generic");
  });
});

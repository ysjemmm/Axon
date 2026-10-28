import { describe, expect, it } from "vitest";
import {
  ToolGroupTracker, describeToolCall, generateToolGroupSummary, isGroupableTool, sanitizeSummary,
} from "./toolGroupSummary.js";

const call = (id: string, name: string, args: Record<string, unknown> = {}) => ({ id, name, arguments: JSON.stringify(args) });

describe("ToolGroupTracker：分组规则与前端折叠行一致", () => {
  it("连续工具轮成一组，出现可见正文时结束", () => {
    const t = new ToolGroupTracker();
    expect(t.onRound("我先定位历史会话面板的代码", [call("a", "search", { query: "SessionSidebar" })])).toEqual([]);
    expect(t.onRound(null, [call("b", "read_file", { path: "/x/App.tsx" })])).toEqual([]);
    expect(t.onRound("", [call("c", "read_file", { path: "/x/SessionSidebar.tsx" })])).toEqual([]);
    const closed = t.onRound("找到了，问题在这里", []);
    expect(closed).toHaveLength(1);
    expect(closed[0].anchorToolCallId).toBe("a");
    expect(closed[0].actions).toEqual(["搜索代码「SessionSidebar」", "读取文件 App.tsx", "读取文件 SessionSidebar.tsx"]);
  });

  it("工具轮自带的可见正文先切断上一组，本轮工具开新组", () => {
    const t = new ToolGroupTracker();
    t.onRound(null, [call("a", "search"), call("b", "read_file")]);
    const closed = t.onRound("再看下存储实现", [call("c", "read_file")]);
    expect(closed.map((g) => g.anchorToolCallId)).toEqual(["a"]);
    t.onRound(null, [call("d", "list_dir")]);
    expect(t.close().map((g) => g.anchorToolCallId)).toEqual(["c"]);
  });

  it("弱内容（纯标点）不切断分组", () => {
    const t = new ToolGroupTracker();
    t.onRound(null, [call("a", "search")]);
    expect(t.onRound("...", [call("b", "read_file")])).toEqual([]);
    expect(t.close()[0].actions).toHaveLength(2);
  });

  it("不收进折叠行的工具（编辑等）切断分组，自身不入组", () => {
    const t = new ToolGroupTracker();
    const closed = t.onRound(null, [call("a", "read_file"), call("b", "search"), call("e", "str_replace"), call("c", "read_file")]);
    expect(closed.map((g) => g.anchorToolCallId)).toEqual(["a"]);
    // 编辑之后只剩 1 个工具，不够成组
    expect(t.close()).toEqual([]);
  });

  it("单个工具不成组", () => {
    const t = new ToolGroupTracker();
    t.onRound(null, [call("a", "read_file")]);
    expect(t.onRound("看完了", [])).toEqual([]);
  });

  it("relay / 编辑 / 产物等不可分组，读写探索类可分组", () => {
    for (const n of ["str_replace", "create_file", "apply_patch", "create_artifact", "ask_user", "use_skill", "relay_create"]) {
      expect(isGroupableTool(n)).toBe(false);
    }
    for (const n of ["read_file", "search", "list_dir", "execute_command", "web_search", "open_browser"]) {
      expect(isGroupableTool(n)).toBe(true);
    }
  });
});

describe("describeToolCall / sanitizeSummary", () => {
  it("只给动作和对象，不给大段参数", () => {
    expect(describeToolCall(call("1", "execute_command", { command: "git status" }))).toBe("执行命令 git status");
    expect(describeToolCall(call("1", "read_file", { path: "C:\\proj\\src\\a.ts" }))).toBe("读取文件 a.ts");
    expect(describeToolCall({ id: "1", name: "read_file", arguments: "{broken" })).toBe("读取文件");
  });

  it("清洗模型输出：首行、去引号句号、截断", () => {
    expect(sanitizeSummary("「查看了历史会话面板。」\n解释……")).toBe("查看了历史会话面板");
    expect(sanitizeSummary("x".repeat(60)).length).toBe(41);
  });
});

describe("generateToolGroupSummary", () => {
  it("关闭思考、不带工具，用当前模型生成并清洗", async () => {
    let seen: any;
    const strategy: any = {
      name: "chat_completions",
      runTurn: async (p: any) => {
        seen = p;
        return { content: "定位了历史会话面板与存储实现。", toolCalls: [] };
      },
    };
    const text = await generateToolGroupSummary({
      strategy, model: "deepseek-v4-flash", request: "修历史会话", actions: ["读取文件 a.ts", "搜索代码「b」"],
    });
    expect(text).toBe("定位了历史会话面板与存储实现");
    expect(seen.model).toBe("deepseek-v4-flash");
    expect(seen.think).toBe(false);
    expect(seen.tools).toEqual([]);
    expect(seen.messages[1].content).toContain("- 读取文件 a.ts");
  });
});

describe("正文一出现就提前收尾", () => {
  it("流式阶段 close 之后，本轮 onRound 遇到同一段正文不会重复产出分组", () => {
    const t = new ToolGroupTracker();
    t.onRound(null, [call("a", "search"), call("b", "read_file")]);
    // 下一轮刚流出第一句正文：立即收尾
    expect(t.close().map((g) => g.anchorToolCallId)).toEqual(["a"]);
    // 这一轮结束时 onRound 带着同一段正文和新的工具调用
    expect(t.onRound("找到了，再看下存储实现", [call("c", "read_file")])).toEqual([]);
    expect(t.onRound(null, [call("d", "search")])).toEqual([]);
    expect(t.close().map((g) => g.anchorToolCallId)).toEqual(["c"]);
  });
});

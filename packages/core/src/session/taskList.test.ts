import { describe, expect, it } from "vitest";
import { formatTasksForModel, latestTasksFromMessages, parseTaskArgs, taskUpdateResult } from "./taskList.js";

describe("任务清单 update_tasks", () => {
  it("宽松解析：status 的常见写法、title 的别名，空标题跳过", () => {
    const { tasks } = parseTaskArgs({ tasks: [
      { title: "读代码", status: "done" },
      { content: "改实现", status: "in-progress" },
      { title: "  ", status: "pending" },
      { title: "跑测试" },
    ] });
    expect(tasks).toEqual([
      { title: "读代码", status: "completed" },
      { title: "改实现", status: "in_progress" },
      { title: "跑测试", status: "pending" },
    ]);
  });

  it("tasks 以 JSON 字符串传入也能解析；不是数组时报错给模型", () => {
    expect(parseTaskArgs({ tasks: '[{"title":"a","status":"pending"}]' }).tasks).toHaveLength(1);
    expect(parseTaskArgs({ tasks: 3 }).error).toMatch(/数组/);
    expect(parseTaskArgs({ tasks: [] }).error).toMatch(/为空/);
  });

  it("回执给出进度与下一步，多项进行中时提醒", () => {
    expect(taskUpdateResult([{ title: "a", status: "completed" }, { title: "b", status: "pending" }])).toBe("任务清单已更新：1/2 完成，接下来：b。");
    expect(taskUpdateResult([{ title: "a", status: "in_progress" }, { title: "b", status: "in_progress" }])).toMatch(/同时有 2 项进行中/);
    expect(taskUpdateResult([{ title: "a", status: "completed" }])).toMatch(/全部完成/);
  });

  it("从历史找最后一次调用的清单", () => {
    const call = (tasks: unknown) => ({ role: "assistant", content: null, tool_calls: [{ id: "x", type: "function", function: { name: "update_tasks", arguments: JSON.stringify({ tasks }) } }] });
    const messages: any[] = [
      { role: "user", content: "做三件事" },
      call([{ title: "a", status: "in_progress" }]),
      { role: "tool", tool_call_id: "x", content: "ok" },
      call([{ title: "a", status: "completed" }, { title: "b", status: "in_progress" }]),
    ];
    expect(latestTasksFromMessages(messages)).toEqual([{ title: "a", status: "completed" }, { title: "b", status: "in_progress" }]);
    expect(latestTasksFromMessages([{ role: "user", content: "x" }] as any)).toBeNull();
  });

  it("压缩后注入：未完成才注入，全部完成不再提醒", () => {
    expect(formatTasksForModel([{ title: "a", status: "completed" }, { title: "b", status: "in_progress" }])).toContain("[>] b");
    expect(formatTasksForModel([{ title: "a", status: "completed" }])).toBeNull();
  });
});

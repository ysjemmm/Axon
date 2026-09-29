import { describe, it, expect } from "vitest";
import { filterPersistableMessages, filterTransientMessages, stripChangeMeta, slimDiffBodies, findDiffBody } from "./persistable.js";

describe("stripChangeMeta", () => {
  it("保留工具产出的 diff 字段，只剥离内存态标记", () => {
    const msg = {
      role: "assistant",
      content: "改好了",
      tool_calls: [{ id: "tc-1", type: "function", function: { name: "str_replace", arguments: "{}" } }],
      fileDiff: { path: "a.ts", oldContent: "x", newContent: "y" },
      fileDiffs: [{ path: "a.ts" }],
      diffs: [{ path: "b.ts" }],
      pendingDiffs: [{ path: "c.ts" }],
      reverted: false,
      undoable: true,
    };
    const out = stripChangeMeta(msg);
    // ⚠️ 回归：这两个是工具调用的产出，刷新后工具卡片与改动面板靠它重建，绝不能剥
    //（曾把它们列进剥离名单，导致编辑 / apply_patch / create_file 卡片刷新后整体消失）
    expect(out.fileDiff).toEqual({ path: "a.ts", oldContent: "x", newContent: "y" });
    expect(out.fileDiffs).toEqual([{ path: "a.ts" }]);
    expect(out.diffs).toBeUndefined();
    expect(out.pendingDiffs).toBeUndefined();
    expect(out.reverted).toBeUndefined();
    expect(out.undoable).toBeUndefined();
    expect(out.role).toBe("assistant");
    expect(out.content).toBe("改好了");
    expect(out.tool_calls).toHaveLength(1);
  });

  it("无目标字段时零拷贝返回同一引用", () => {
    const msg = { role: "user", content: "你好" };
    expect(stripChangeMeta(msg)).toBe(msg);
  });

  it("不修改原对象（内存态消息不受影响）", () => {
    const msg = { role: "tool", content: "已编辑 a.ts", fileDiff: { path: "a.ts" }, undoable: true };
    const out = stripChangeMeta(msg);
    expect(out).not.toBe(msg);
    expect(msg.fileDiff).toEqual({ path: "a.ts" });
    expect(msg.undoable).toBe(true);
    expect(out.fileDiff).toEqual({ path: "a.ts" });
    expect(out.content).toBe("已编辑 a.ts");
  });
});

describe("filterPersistableMessages", () => {
  it("过滤 _transient 与 _ephemeralInjected 消息", () => {
    const out = filterPersistableMessages([
      { role: "user", content: "正常" },
      { role: "assistant", content: "瞬态", _transient: true },
      { role: "user", content: "临时注入", _ephemeralInjected: true },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].content).toBe("正常");
  });

  it("过滤的同时剥离内存态标记，但保留工具产出", () => {
    const out = filterPersistableMessages([
      {
        role: "assistant",
        content: "已应用补丁",
        fileDiff: { path: "x.ts" },
        undoable: true,
      } as Record<string, unknown>,
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].undoable).toBeUndefined();
    expect(out[0].fileDiff).toEqual({ path: "x.ts" });
  });

  it("回归：落盘后读回，文件改动字段仍在（编辑卡片刷新后不消失）", () => {
    const toolMsg = {
      role: "tool",
      content: "已编辑 a.ts",
      fileDiff: { path: "a.ts", oldContent: "x", newContent: "y" },
      fileDiffs: [{ path: "a.ts", oldContent: "x", newContent: "y" }],
    };
    const [saved] = filterPersistableMessages([toolMsg]);
    // 前端 handleSessionLoaded 正是用这两个字段重建 seg.diff / seg.diffs
    expect(saved.fileDiff).toBeDefined();
    expect(saved.fileDiffs).toBeDefined();
  });
});

describe("filterTransientMessages", () => {
  it("只过滤瞬态消息，不剥离改动字段（运行中下发保持完整）", () => {
    const out = filterTransientMessages([
      { role: "assistant", content: "已编辑 a.ts", fileDiff: { path: "a.ts" } } as Record<string, unknown>,
      { role: "assistant", content: "瞬态", _transient: true } as Record<string, unknown>,
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].fileDiff).toEqual({ path: "a.ts" });
  });
});

describe("slimDiffBodies", () => {
  const edit = (editId: string, oldContent: string, newContent: string) => ({
    role: "tool",
    content: "已编辑",
    fileDiff: { path: "a.ts", absPath: "/w/a.ts", editId, oldContent, newContent },
    fileDiffs: [{ path: "a.ts", absPath: "/w/a.ts", editId, oldContent, newContent }],
  });

  it("去掉前后全文，保留定位信息并打上 bodyOmitted", () => {
    const [out] = slimDiffBodies([edit("e1", "旧", "新")]) as Array<Record<string, any>>;
    expect(out.fileDiff).toEqual({ path: "a.ts", absPath: "/w/a.ts", editId: "e1", bodyOmitted: true, hadOldContent: true });
    expect(out.fileDiffs[0].oldContent).toBeUndefined();
    expect(out.fileDiffs[0].newContent).toBeUndefined();
    expect(out.fileDiffs[0].editId).toBe("e1");
    expect(out.content).toBe("已编辑");
  });

  it("create_file 新建（改动前为空）标记 hadOldContent=false，卡片据此显示「已创建」而非「已覆盖」", () => {
    const [out] = slimDiffBodies([edit("e1", "", "新文件")]) as Array<Record<string, any>>;
    expect(out.fileDiff.hadOldContent).toBe(false);
  });

  it("不修改原消息（内存态仍保留全文，按需取正文要靠它）", () => {
    const msg = edit("e1", "旧", "新");
    slimDiffBodies([msg]);
    expect(msg.fileDiff.oldContent).toBe("旧");
    expect(msg.fileDiffs[0].newContent).toBe("新");
  });

  it("没有 diff 的消息原样返回同一引用", () => {
    const msg = { role: "user", content: "你好" };
    expect(slimDiffBodies([msg])[0]).toBe(msg);
  });
});

describe("findDiffBody", () => {
  const msgs = [
    { role: "tool", fileDiff: { path: "a.ts", editId: "e1", oldContent: "v0", newContent: "v1" } },
    { role: "tool", fileDiffs: [{ path: "a.ts", absPath: "/w/a.ts", editId: "e2", oldContent: "v1", newContent: "v2" }] },
  ];

  it("按 editId 精确取回某一次改动（同一文件多次改动互不混淆）", () => {
    expect(findDiffBody(msgs, { editId: "e1" })).toEqual({ oldContent: "v0", newContent: "v1" });
    expect(findDiffBody(msgs, { editId: "e2" })).toEqual({ oldContent: "v1", newContent: "v2" });
  });

  it("只给路径时取最近一次改动，绝对路径也能匹配", () => {
    expect(findDiffBody(msgs, { path: "a.ts" })).toEqual({ oldContent: "v1", newContent: "v2" });
    expect(findDiffBody(msgs, { path: "/w/a.ts" })).toEqual({ oldContent: "v1", newContent: "v2" });
  });

  it("已被瘦身的 diff 不算命中（避免把空正文当成结果返回）", () => {
    const slim = slimDiffBodies(msgs as object[]);
    expect(findDiffBody(slim, { editId: "e1" })).toBeNull();
  });

  it("找不到返回 null", () => {
    expect(findDiffBody(msgs, { editId: "nope" })).toBeNull();
  });
});

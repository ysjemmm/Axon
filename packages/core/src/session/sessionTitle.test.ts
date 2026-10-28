import { describe, expect, it } from "vitest";
import { autoSessionTitle, renameSessionTitle, uniqueSessionTitle } from "./sessionTitle.js";

describe("会话标题", () => {
  it("自动标题截断用省略号「…」而不是三个句点，并合并换行空白", () => {
    const t = autoSessionTitle("看 e-poseidon 应用，看看怎么做可以根据时间范围找到对应的日志\n再给个方案");
    expect(t.endsWith("…")).toBe(true);
    expect(t).not.toContain("...");
    expect(t).not.toContain("\n");
    expect(autoSessionTitle("短标题")).toBe("短标题");
  });

  it("重名时加序号，已带序号的接着编号", () => {
    expect(uniqueSessionTitle("方案", ["方案"])).toBe("方案 (2)");
    expect(uniqueSessionTitle("方案", ["方案", "方案 (2)"])).toBe("方案 (3)");
    expect(uniqueSessionTitle("方案 (2)", ["方案 (2)"])).toBe("方案 (3)");
    expect(uniqueSessionTitle("方案", ["别的"])).toBe("方案");
  });

  it("占位标题「新对话」不去重", () => {
    expect(uniqueSessionTitle("新对话", ["新对话"])).toBe("新对话");
  });

  it("重命名与其它会话去重，不和自己比", async () => {
    const sessions = [{ id: "a", title: "日志排查" }, { id: "b", title: "旧标题" }];
    const updates: any[] = [];
    const storage: any = {
      listSessions: async () => sessions,
      updateSession: async (id: string, patch: any) => updates.push({ id, ...patch }),
    };
    expect(await renameSessionTitle(storage, "b", "日志排查")).toBe("日志排查 (2)");
    expect(await renameSessionTitle(storage, "a", "日志排查")).toBe("日志排查");
    expect(await renameSessionTitle(storage, "a", "   ")).toBeNull();
    expect(updates).toEqual([{ id: "b", title: "日志排查 (2)" }, { id: "a", title: "日志排查" }]);
  });
});

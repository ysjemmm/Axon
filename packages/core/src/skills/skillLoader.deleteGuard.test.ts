import { afterEach, describe, expect, it } from "vitest";
import { skillDeleteRejection } from "./skillLoader.js";
import { setBuiltinPowersDir } from "../powers/powerLoader.js";

afterEach(() => setBuiltinPowersDir(null));

describe("skillDeleteRejection：哪些 skill 不能删、为什么", () => {
  it("内置方法论 → 拒绝，并指出替代做法（覆盖 / 禁用）", () => {
    const msg = skillDeleteRejection({ name: "systematic-debugging", source: "builtin", dir: "" });
    expect(msg).toBeTruthy();
    expect(msg).toContain("内置方法论");
    expect(msg).toContain("覆盖");
    expect(msg).toContain("禁用");
  });

  it("能力包捆绑的 skill → 拒绝，并指向 Powers 面板", () => {
    setBuiltinPowersDir("C:\\ext\\media\\powers");
    const msg = skillDeleteRejection({ name: "excel", source: "power", dir: "C:\\Users\\u\\.axon\\powers\\my-pack\\skills\\excel" });
    expect(msg).toBeTruthy();
    expect(msg).toContain("能力包");
    expect(msg).toContain("Powers");
  });

  it("内置能力包捆绑的 skill → 拒绝，并说明是只读捆绑", () => {
    setBuiltinPowersDir("C:\\ext\\media\\powers");
    const msg = skillDeleteRejection({ name: "excel", source: "power", dir: "C:\\ext\\media\\powers\\doc-forge\\skills\\excel" });
    expect(msg).toBeTruthy();
    expect(msg).toContain("只读");
  });

  it("全局 / 工作区 skill → 可删（返回 null）", () => {
    expect(skillDeleteRejection({ name: "my-skill", source: "global", dir: "C:\\Users\\u\\.axon\\skills\\my-skill" })).toBeNull();
    expect(skillDeleteRejection({ name: "proj-skill", source: "workspace", dir: "C:\\ws\\.axon\\skills\\proj-skill" })).toBeNull();
  });

  it("未注入内置根目录时，power 来源不会被误判为只读捆绑（web/server 形态）", () => {
    setBuiltinPowersDir(null);
    const msg = skillDeleteRejection({ name: "excel", source: "power", dir: "C:\\ext\\media\\powers\\doc-forge\\skills\\excel" });
    // 仍拒绝（属于能力包），但不该声称是"内置只读"——那个判定依赖注入的内置根
    expect(msg).toBeTruthy();
    expect(msg).not.toContain("只读");
  });
});

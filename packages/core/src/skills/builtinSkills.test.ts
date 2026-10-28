import { describe, expect, it } from "vitest";
import { BUILTIN_SKILLS, getBuiltinSkill } from "./builtinSkills.js";

describe("内置 skill", () => {
  it("包含资深工程实践，覆盖 N+1、无界查询、竞态、吞异常、注入等常见坑", () => {
    const skill = getBuiltinSkill("senior-engineering");
    expect(skill).toBeTruthy();
    for (const topic of ["N+1", "LIMIT", "OFFSET", "超时", "幂等", "竞态", "别吞异常", "参数化", "越权", "交付前自检"]) {
      expect(skill!.body).toContain(topic);
    }
  });

  it("名称不重复，每个都有 description / when / body", () => {
    const names = BUILTIN_SKILLS.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
    for (const s of BUILTIN_SKILLS) {
      expect(s.description && s.when && s.body).toBeTruthy();
    }
  });
});

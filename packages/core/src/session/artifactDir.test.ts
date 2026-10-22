import { describe, expect, it } from "vitest";
import { isAbsolute, resolve } from "node:path";
import { resolveArtifactDir } from "./artifactDir.js";

// 用 resolve 生成期望值，避免把 Windows / POSIX 的分隔符写死在断言里
const HOME = resolve("/home/tester");
const CWD = resolve("/work/project");

describe("resolveArtifactDir 产物目录解析", () => {
  it("用户设置了绝对路径 → 原样使用", () => {
    const configured = resolve("/data/my-artifacts");
    expect(resolveArtifactDir({ configured, cwd: CWD, homeDir: HOME, sessionId: "s1" })).toBe(configured);
  });

  it("用户设置了相对路径 → 按工作区解析", () => {
    expect(resolveArtifactDir({ configured: "out/artifacts", cwd: CWD, homeDir: HOME, sessionId: "s1" }))
      .toBe(resolve(CWD, "out/artifacts"));
  });

  it("没设置 → 默认 ~/.axon/artifacts/<会话id>", () => {
    expect(resolveArtifactDir({ configured: "", cwd: CWD, homeDir: HOME, sessionId: "abc" }))
      .toBe(resolve(HOME, ".axon", "artifacts", "abc"));
  });

  it("只有空白也视为没设置", () => {
    expect(resolveArtifactDir({ configured: "   ", cwd: CWD, homeDir: HOME, sessionId: "abc" }))
      .toBe(resolve(HOME, ".axon", "artifacts", "abc"));
  });

  it("不同会话的默认目录互不相同（同名产物不会互相覆盖）", () => {
    const a = resolveArtifactDir({ configured: "", cwd: CWD, homeDir: HOME, sessionId: "a" });
    const b = resolveArtifactDir({ configured: "", cwd: CWD, homeDir: HOME, sessionId: "b" });
    expect(a).not.toBe(b);
  });

  it("默认位置缺 homeDir 或会话 id → 返回空串，不悄悄回落到进程目录", () => {
    expect(resolveArtifactDir({ configured: "", cwd: CWD, homeDir: "", sessionId: "s1" })).toBe("");
    expect(resolveArtifactDir({ configured: "", cwd: CWD, homeDir: HOME, sessionId: "" })).toBe("");
  });

  it("用户显式设置时，即使没有 homeDir / 会话 id 也能解析", () => {
    const configured = resolve("/data/x");
    const out = resolveArtifactDir({ configured, cwd: CWD, homeDir: "", sessionId: "" });
    expect(out).toBe(configured);
    expect(isAbsolute(out)).toBe(true);
  });
});

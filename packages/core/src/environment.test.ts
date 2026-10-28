import { describe, expect, it } from "vitest";
import { buildEnvironmentNotice, describeShellEnvironment, formatLocalDate } from "./environment.js";

describe("运行环境描述", () => {
  it("按平台给出 shell：不再写死 PowerShell", () => {
    expect(describeShellEnvironment("win32").shell).toContain("PowerShell");
    expect(describeShellEnvironment("darwin")).toMatchObject({ os: "macOS" });
    expect(describeShellEnvironment("darwin").shell).not.toContain("PowerShell");
    expect(describeShellEnvironment("linux").shell).toContain("bash");
  });

  it("日期带星期，问答模式只给日期", () => {
    const now = new Date(2026, 9, 28);
    expect(formatLocalDate(now)).toBe("2026-10-28（星期三）");
    expect(buildEnvironmentNotice({ commands: false, now })).toBe("【运行环境】今天是 2026-10-28（星期三）。");
    const agent = buildEnvironmentNotice({ commands: true, now, platform: "darwin" });
    expect(agent).toContain("macOS");
    expect(agent).toContain("2026-10-28");
  });
});

import { describe, expect, it, vi } from "vitest";
import { ensureWorkspaceAxonDirs, initializeWorkspaceAxon, loadWorkspaceAxonConfig } from "./workspaceConfig.js";

function memHost(files: Record<string, string>) {
  const data = new Map(Object.entries(files));
  const dirs: string[] = [];
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const host: any = {
    fs: {
      read: vi.fn(async (p: string) => data.get(norm(p)) ?? null),
      write: vi.fn(async (p: string, content: string) => { data.set(norm(p), content); }),
      append: vi.fn(async () => {}),
      stat: vi.fn(async (p: string) => data.has(norm(p)) ? { isFile: true, isDir: false } : null),
      readdir: vi.fn(async (p: string) => {
        const root = `${norm(p)}/`;
        const seen = new Map<string, { name: string; path: string; isFile: boolean; isDir: boolean }>();
        for (const key of data.keys()) {
          if (!key.startsWith(root)) continue;
          const rest = key.slice(root.length);
          const name = rest.split("/")[0];
          const path = `${root}${name}`;
          seen.set(name, { name, path, isFile: !rest.includes("/"), isDir: rest.includes("/") });
        }
        return [...seen.values()];
      }),
      mkdirp: vi.fn(async (p: string) => { dirs.push(norm(p)); }),
      remove: vi.fn(async () => {}),
    },
  };
  return { host, dirs };
}

describe(".axon 工作区配置", () => {
  it("按用户级到工作区级加载 Axon 配置，并忽略其它 Agent 配置", async () => {
    const { host } = memHost({
      "C:/Users/test/.axon/AXON.md": "用户默认规则",
      "C:/Users/test/.axon/settings.json": JSON.stringify({ mode: "user", nested: { a: 1 } }),
      "D:/repo/AGENTS.md": "不应加载的其它 Agent 约定",
      "D:/repo/.axon/rules/frontend.md": "前端规则",
      "D:/repo/.axon/memory/decisions.md": "长期设计决策",
      "D:/repo/.axon/settings.json": JSON.stringify({ mode: "workspace", nested: { b: 2 } }),
      "E:/docs/CLAUDE.md": "不应加载的其它 Agent 约定",
      "E:/docs/.axon/rules/docs.md": "文档规则",
    });

    const config = await loadWorkspaceAxonConfig(host, ["D:/repo", "E:/docs"], "C:/Users/test");
    expect(config.prompt).toContain("用户默认规则");
    expect(config.prompt).not.toContain("不应加载的其它 Agent 约定");
    expect(config.prompt).toContain("前端规则");
    expect(config.prompt).toContain("长期设计决策");
    expect(config.prompt).not.toContain("CLAUDE.md");
    expect(config.settings.mode).toBe("workspace");
    expect(config.settings.nested).toEqual({ a: 1, b: 2 });
    expect(config.files).toContain("D:/repo/.axon/memory/decisions.md");
  });

  it("创建基础目录但不写模板文件，重复调用安全", async () => {
    const { host, dirs } = memHost({});
    await ensureWorkspaceAxonDirs(host, "D:/repo");
    await ensureWorkspaceAxonDirs(host, "D:/repo");
    expect(host.fs.mkdirp).toHaveBeenCalled();
    expect(host.fs.write).not.toHaveBeenCalled();
    expect(dirs).toContain("D:/repo/.axon/rules");
    expect(dirs).toContain("D:/repo/.axon/memory");
  });

  it("支持 settings.json 控制兼容文件、规则和记忆加载", async () => {
    const { host } = memHost({
      "D:/repo/AGENTS.md": "不应加载的兼容指令",
      "D:/repo/.axon/rules/frontend.md": "不应加载的规则",
      "D:/repo/.axon/memory/decisions.md": "不应加载的记忆",
      "D:/repo/.axon/settings.json": JSON.stringify({
        memory: { enabled: false },
        workspaceConfig: { loadRules: false },
      }),
    });
    const config = await loadWorkspaceAxonConfig(host, ["D:/repo"], "");
    expect(config.prompt).not.toContain("不应加载的兼容指令");
    expect(config.prompt).not.toContain("不应加载的规则");
    expect(config.prompt).not.toContain("不应加载的记忆");
  });

  it("初始化只补缺失文件，不覆盖用户已有 AXON.md", async () => {
    const { host } = memHost({ "D:/repo/.axon/AXON.md": "用户已经写好的说明" });
    const result = await initializeWorkspaceAxon(host, "D:/repo", "AI 草案");
    expect(result.existing.map((p) => p.replace(/\\/g, "/"))).toContain("D:/repo/.axon/AXON.md");
    expect(result.created.map((p) => p.replace(/\\/g, "/"))).toContain("D:/repo/.axon/settings.json");
    expect(await host.fs.read("D:/repo/.axon/AXON.md")).toBe("用户已经写好的说明");
  });
});

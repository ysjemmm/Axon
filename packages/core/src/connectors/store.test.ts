import { describe, expect, it } from "vitest";
import { ConnectorStore, resolveConnectorSpecs, connectorSecretsPath, connectorConfigPath } from "./store.js";
import { connectorCatalog, parseEnvLines, splitArgs } from "./catalog.js";
import { McpRegistry } from "../mcp/mcpRegistry.js";
import type { HostFileSystem, AgentHost } from "../host/index.js";

function memoryFs(): HostFileSystem & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    read: async (p) => files.get(p) ?? null,
    write: async (p, c) => { files.set(p, c); },
    append: async () => {},
    stat: async () => null,
    readdir: async () => [],
    mkdirp: async () => {},
    remove: async (p) => { files.delete(p); },
  };
}

describe("连接器", () => {
  it("密钥和配置分文件保存，列表只给「已保存」标记", async () => {
    const fs = memoryFs();
    const store = new ConnectorStore(fs, "/home/u");
    const saved = await store.save({ templateId: "github", secrets: { token: "ghp_secret" }, values: { readonly: "true" } });
    expect(saved.savedSecrets).toEqual(["token"]);
    expect(fs.files.get(connectorConfigPath("/home/u"))).not.toContain("ghp_secret");
    expect(fs.files.get(connectorSecretsPath("/home/u"))).toContain("ghp_secret");
    const listed = await store.list();
    expect(JSON.stringify(listed)).not.toContain("ghp_secret");
  });

  it("编辑时密钥留空表示不变；必填缺失时报错且不落盘", async () => {
    const fs = memoryFs();
    const store = new ConnectorStore(fs, "/home/u");
    await expect(store.save({ templateId: "qqmail", values: { user: "a@qq.com" } })).rejects.toThrow(/授权码/);
    expect(fs.files.size).toBe(0);
    const c = await store.save({ templateId: "qqmail", values: { user: "a@qq.com" }, secrets: { password: "code1" } });
    await store.save({ id: c.id, templateId: "qqmail", name: "工作邮箱", values: { user: "a@qq.com" }, secrets: { password: "" } });
    const [spec] = await resolveConnectorSpecs(fs, "/home/u");
    expect(spec).toMatchObject({ id: `connector:${c.id}`, name: "工作邮箱", transport: "builtin", builtin: "mail", source: "connector" });
    expect(spec.env).toMatchObject({ MAIL_USER: "a@qq.com", MAIL_PASSWORD: "code1", IMAP_HOST: "imap.qq.com", SMTP_PORT: "465" });
  });

  it("GitHub 只读模式带上请求头；停用的不连接；删除连同密钥一起删", async () => {
    const fs = memoryFs();
    const store = new ConnectorStore(fs, "/home/u");
    const c = await store.save({ templateId: "github", secrets: { token: "t" }, values: { readonly: "true" } });
    let [spec] = await resolveConnectorSpecs(fs, "/home/u");
    expect(spec.headers).toEqual({ Authorization: "Bearer t", "X-MCP-Readonly": "true" });
    await store.setEnabled(c.id, false);
    expect(await resolveConnectorSpecs(fs, "/home/u")).toHaveLength(0);
    [spec] = await resolveConnectorSpecs(fs, "/home/u", true);
    expect(spec.disabled).toBe(true);
    await store.remove(c.id);
    expect(fs.files.get(connectorSecretsPath("/home/u"))).not.toContain("\"t\"");
  });

  it("MCP 注册表把启用的连接器并进 server 列表", async () => {
    const fs = memoryFs();
    await new ConnectorStore(fs, "/home/u").save({ templateId: "custom-remote", values: { url: "https://x/mcp", headerName: "Authorization", autoApprove: "get_*, list_*" }, secrets: { headerValue: "Bearer k" } });
    const registry = new McpRegistry([], { fs } as unknown as AgentHost, "/home/u", null);
    const specs = await registry.resolve();
    expect(specs).toHaveLength(1);
    expect(specs[0]).toMatchObject({ transport: "http", url: "https://x/mcp", headers: { Authorization: "Bearer k" }, autoApprove: ["get_*", "list_*"] });
  });

  it("目录不带 build；参数与环境变量解析", () => {
    expect(connectorCatalog().every((t) => !("build" in t))).toBe(true);
    expect(splitArgs(`-y pkg --name "a b" 'c d'`)).toEqual(["-y", "pkg", "--name", "a b", "c d"]);
    expect(parseEnvLines("A=1\n# x\nB = two=2\nbad")).toEqual({ A: "1", B: "two=2" });
  });
});

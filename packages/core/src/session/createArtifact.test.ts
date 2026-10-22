import { describe, expect, it, vi } from "vitest";
import { join, resolve } from "node:path";
import { AgentSession } from "../agentSession.js";

/**
 * 用真实的 AgentSession.prototype.createArtifact 做行为测试，只喂它用到的几个字段：
 * 内存文件系统（host.fs）、send、getArtifactDir。这样测到的是真实实现，而不是一份复制品。
 */
function makeSession(artifactDir: string) {
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  const send = vi.fn();
  const session: any = {
    host: {
      fs: {
        mkdirp: async (p: string) => { dirs.add(p); },
        stat: async (p: string) => (files.has(p) ? { isFile: true, isDir: false } : null),
        write: async (p: string, c: string) => { files.set(p, c); },
      },
    },
    send,
    getArtifactDir: () => artifactDir,
  };
  const call = (args: Record<string, unknown>, meta?: any) =>
    (AgentSession.prototype as any).createArtifact.call(session, args, meta);
  return { files, dirs, send, call };
}

const DIR = resolve("/data/artifacts/s1");
const html = { title: "登录页", type: "html", content: "<html>hi</html>" };

describe("createArtifact 创建产物", () => {
  it("写盘到产物目录，文件名由标题 + 类型扩展名决定", async () => {
    const { files, call } = makeSession(DIR);
    const out = await call(html);
    expect(out.status).toBe("success");
    expect(files.get(join(DIR, "登录页.html"))).toBe("<html>hi</html>");
  });

  it("目录不存在会先创建", async () => {
    const { dirs, call } = makeSession(DIR);
    await call(html);
    expect(dirs.has(DIR)).toBe(true);
  });

  it("成功后发 artifact_created 事件，字段齐全", async () => {
    const { send, call } = makeSession(DIR);
    await call(html);
    expect(send).toHaveBeenCalledWith("artifact_created", expect.objectContaining({
      path: join(DIR, "登录页.html"),
      title: "登录页",
      type: "html",
      version: 1,
    }));
  });

  it("成功后把产物写进 meta（历史恢复靠它）", async () => {
    const { call } = makeSession(DIR);
    const meta: any = {};
    await call(html, meta);
    expect(meta.artifact).toMatchObject({ title: "登录页", type: "html", version: 1 });
    expect(meta.artifact.path).toBe(join(DIR, "登录页.html"));
  });

  it("size 按 UTF-8 字节数而不是字符数（中文是 3 字节）", async () => {
    const { send, call } = makeSession(DIR);
    await call({ title: "t", type: "text", content: "你好" });
    expect(send.mock.calls[0][1].size).toBe(6);
  });

  it("同名产物保存为新版本，旧文件内容不被覆盖", async () => {
    const { files, send, call } = makeSession(DIR);
    await call({ ...html, content: "v1" });
    const out = await call({ ...html, content: "v2" });
    expect(files.get(join(DIR, "登录页.html"))).toBe("v1");
    expect(files.get(join(DIR, "登录页-v2.html"))).toBe("v2");
    expect(send.mock.calls[1][1].version).toBe(2);
    expect(out.result).toMatch(/第 2 版/);
  });

  it("标题里的路径穿越不会写到产物目录之外", async () => {
    const { files, call } = makeSession(DIR);
    await call({ title: "../../evil", type: "html", content: "x" });
    for (const written of files.keys()) {
      expect(written.startsWith(DIR)).toBe(true);
    }
  });

  it("code 类型按 language 决定扩展名", async () => {
    const { files, call } = makeSession(DIR);
    await call({ title: "脚本", type: "code", language: "python", content: "print(1)" });
    expect(files.has(join(DIR, "脚本.py"))).toBe(true);
  });

  it("入参不合法 → error，不写盘不发事件，错误信息给模型看", async () => {
    const { files, send, call } = makeSession(DIR);
    const out = await call({ title: "x", type: "pdf", content: "c" });
    expect(out.status).toBe("error");
    expect(out.result).toMatch(/html/);
    expect(files.size).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it("每条失败路径都给用户一句不含内部字段名的 userMessage", async () => {
    const leaks = /\b(type|title|content|language|artifact|html|svg)\b/i;

    const bad = makeSession(DIR);
    const badMeta: any = {};
    await bad.call({ title: "x", type: "pdf", content: "c" }, badMeta);
    expect(badMeta.userMessage).toBeTruthy();
    expect(badMeta.userMessage).not.toMatch(leaks);

    const noDir = makeSession("");
    const noDirMeta: any = {};
    await noDir.call(html, noDirMeta);
    expect(noDirMeta.userMessage).toBeTruthy();
    expect(noDirMeta.userMessage).not.toMatch(leaks);

    const failing: any = {
      host: { fs: { mkdirp: async () => {}, stat: async () => null, write: async () => { throw new Error("EACCES: C:\\secret\\path") } } },
      send: vi.fn(),
      getArtifactDir: () => DIR,
    };
    const writeMeta: any = {};
    await (AgentSession.prototype as any).createArtifact.call(failing, html, writeMeta);
    expect(writeMeta.userMessage).toBeTruthy();
    // 底层异常原文（可能带本机路径）只给模型，不进用户文案
    expect(writeMeta.userMessage).not.toMatch(/EACCES|secret/);
  });

  it("成功时不设置 userMessage", async () => {
    const { call } = makeSession(DIR);
    const meta: any = {};
    await call(html, meta);
    expect(meta.userMessage).toBeUndefined();
  });

  it("拿不到产物目录（会话未建立）→ error，不写盘", async () => {
    const { files, send, call } = makeSession("");
    const out = await call(html);
    expect(out.status).toBe("error");
    expect(files.size).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it("写盘失败 → error 且不发事件（不能让界面出现一张点不开的卡片）", async () => {
    const { send, call } = makeSession(DIR);
    const session: any = {
      host: { fs: { mkdirp: async () => {}, stat: async () => null, write: async () => { throw new Error("磁盘已满"); } } },
      send,
      getArtifactDir: () => DIR,
    };
    const out = await (AgentSession.prototype as any).createArtifact.call(session, html, {});
    expect(out.status).toBe("error");
    expect(out.result).toMatch(/磁盘已满/);
    expect(send).not.toHaveBeenCalled();
  });
});

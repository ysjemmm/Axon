import { describe, expect, it, vi } from "vitest";
import { join, resolve } from "node:path";
import { AgentSession } from "../agentSession.js";
import type { MediaRenderRequest, MediaRenderResult } from "../host/mediaRenderer.js";

/**
 * 用真实的 AgentSession.prototype.renderMedia 做行为测试，只喂它用到的字段：
 * 假渲染器、内存文件系统、send、getArtifactDir、abortSignal。
 */
function makeSession(opts: {
  artifactDir?: string;
  renderer?: unknown;
  existing?: string[];
  signal?: AbortSignal;
}) {
  const existing = new Set(opts.existing ?? []);
  const send = vi.fn();
  const session: any = {
    host: {
      mediaRenderer: opts.renderer,
      fs: {
        mkdirp: async () => {},
        stat: async (p: string) => (existing.has(p) ? { isFile: true, isDir: false } : null),
      },
    },
    send,
    getArtifactDir: () => opts.artifactDir ?? DIR,
    abortSignal: opts.signal,
  };
  const call = (args: Record<string, unknown>, meta?: any) =>
    (AgentSession.prototype as any).renderMedia.call(session, args, meta);
  return { send, call };
}

const DIR = resolve("/data/artifacts/s1");
const args = { title: "冒泡排序", html: "<html></html>", format: "mp4" };

function okRenderer(overrides: Partial<MediaRenderResult> = {}) {
  const render = vi.fn(async (req: MediaRenderRequest): Promise<MediaRenderResult> => {
    req.onProgress?.({ phase: "frames", done: 1, total: 1 });
    return {
      outputPath: req.outputPath,
      durationSec: req.durationSec,
      hasAudio: false,
      frameCount: req.durationSec * req.fps,
      size: 12345,
      warnings: [],
      ...overrides,
    };
  });
  return { checkEnv: vi.fn(async () => ({ ok: true })), render };
}

describe("renderMedia 渲染成片", () => {
  it("成功：写到产物目录、填 meta、发 artifact_created，type 为输出格式", async () => {
    const renderer = okRenderer();
    const { send, call } = makeSession({ renderer });
    const meta: any = {};
    const out = await call(args, meta);

    expect(out.status).toBe("success");
    const expectedPath = join(DIR, "冒泡排序.mp4");
    expect(renderer.render).toHaveBeenCalledWith(expect.objectContaining({ outputPath: expectedPath, format: "mp4" }));
    expect(meta.artifact).toMatchObject({ path: expectedPath, title: "冒泡排序", type: "mp4", size: 12345, version: 1 });
    expect(send).toHaveBeenCalledWith("artifact_created", expect.objectContaining({ type: "mp4", path: expectedPath }));
    expect(meta.userMessage).toBeUndefined();
  });

  it("同名成片保存为新版本，不覆盖旧文件", async () => {
    const renderer = okRenderer();
    const { call } = makeSession({ renderer, existing: [join(DIR, "冒泡排序.mp4")] });
    const meta: any = {};
    const out = await call(args, meta);
    expect(meta.artifact.path).toBe(join(DIR, "冒泡排序-v2.mp4"));
    expect(meta.artifact.version).toBe(2);
    expect(out.result).toMatch(/第 2 版/);
  });

  it("渲染器给出的 warnings 原样回给模型，并要求如实转告用户", async () => {
    const renderer = okRenderer({ warnings: ["旁白合成失败（系统没有安装中文语音包），成片没有声音"] });
    const { call } = makeSession({ renderer });
    const out = await call({ ...args, narration: "大家好" });
    expect(out.status).toBe("success");
    expect(out.result).toMatch(/旁白合成失败/);
    expect(out.result).toMatch(/如实/);
  });

  it("参数被钳制时把调整说明告诉模型", async () => {
    const renderer = okRenderer();
    const { call } = makeSession({ renderer });
    const out = await call({ ...args, durationSec: 9999 });
    expect(out.result).toMatch(/参数调整/);
  });

  it("成片带音轨与无声，结果里表述不同（模型据此告诉用户）", async () => {
    const withAudio = await makeSession({ renderer: okRenderer({ hasAudio: true }) }).call({ ...args, narration: "你好" });
    expect(withAudio.result).toMatch(/带旁白音轨/);
    const silent = await makeSession({ renderer: okRenderer({ hasAudio: false }) }).call(args);
    expect(silent.result).toMatch(/无声/);
  });

  it("宿主没有渲染器 → error，并指引改用 create_artifact", async () => {
    const { send, call } = makeSession({ renderer: undefined });
    const meta: any = {};
    const out = await call(args, meta);
    expect(out.status).toBe("error");
    expect(out.result).toMatch(/create_artifact/);
    expect(meta.userMessage).toBeTruthy();
    expect(send).not.toHaveBeenCalled();
  });

  it("入参不合法 → error，不渲染不发事件", async () => {
    const renderer = okRenderer();
    const { send, call } = makeSession({ renderer });
    const out = await call({ ...args, format: "gif", narration: "你好" });
    expect(out.status).toBe("error");
    expect(renderer.render).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("环境不可用（如缺 ffmpeg）→ error，把安装办法给模型，且不启动渲染", async () => {
    const renderer = { checkEnv: vi.fn(async () => ({ ok: false, problem: "未找到 ffmpeg，请安装" })), render: vi.fn() };
    const { call } = makeSession({ renderer });
    const meta: any = {};
    const out = await call(args, meta);
    expect(out.status).toBe("error");
    expect(out.result).toMatch(/ffmpeg/);
    expect(renderer.render).not.toHaveBeenCalled();
    expect(meta.userMessage).toBeTruthy();
  });

  it("渲染抛错 → error 且不发事件（不能让界面出现一张点不开的卡片）", async () => {
    const renderer = { checkEnv: async () => ({ ok: true }), render: vi.fn(async () => { throw new Error("无法启动浏览器：C:\\secret\\chrome.exe"); }) };
    const { send, call } = makeSession({ renderer });
    const meta: any = {};
    const out = await call(args, meta);
    expect(out.status).toBe("error");
    expect(out.result).toMatch(/无法启动浏览器/);
    expect(send).not.toHaveBeenCalledWith("artifact_created", expect.anything());
    // 底层异常原文（可能带本机路径）只给模型，不进用户文案
    expect(meta.userMessage).toBeTruthy();
    expect(meta.userMessage).not.toMatch(/secret|chrome\.exe/);
  });

  it("用户取消 → 明确标成取消，而不是当作渲染故障", async () => {
    const ac = new AbortController();
    const renderer = {
      checkEnv: async () => ({ ok: true }),
      render: vi.fn(async () => { ac.abort(); throw new Error("渲染已取消"); }),
    };
    const { call } = makeSession({ renderer, signal: ac.signal });
    const meta: any = {};
    const out = await call(args, meta);
    expect(out.status).toBe("error");
    expect(out.result).toMatch(/取消/);
    expect(meta.userMessage).toMatch(/取消/);
  });

  it("拿不到产物目录 → error，不渲染", async () => {
    const renderer = okRenderer();
    const { call } = makeSession({ renderer, artifactDir: "" });
    const out = await call(args);
    expect(out.status).toBe("error");
    expect(renderer.render).not.toHaveBeenCalled();
  });

  it("进度回调被节流成 status 事件，且带帧数", async () => {
    const renderer = {
      checkEnv: async () => ({ ok: true }),
      render: vi.fn(async (req: MediaRenderRequest): Promise<MediaRenderResult> => {
        req.onProgress?.({ phase: "frames", done: 3, total: 10 });
        return { outputPath: req.outputPath, durationSec: 1, hasAudio: false, frameCount: 10, size: 1, warnings: [] };
      }),
    };
    const { send, call } = makeSession({ renderer });
    await call(args);
    const status = send.mock.calls.filter((c) => c[0] === "status");
    expect(status.length).toBeGreaterThan(0);
    expect(String(status[0][1].content)).toMatch(/3\/10/);
  });
});

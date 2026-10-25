/**
 * HttpImageGenerator —— HostImageGenerator 的 HTTP 实现（OpenAI 兼容协议）
 *
 * ── 为什么单独抽一个文件 ──
 * 文生图与本地渲染是两种完全不同的能力：渲染不花一分钱、完全可控、可复现；
 * 文生图要调外部服务、要额度、画面由服务商决定。把它们混在一个实现里，
 * 配置与失败原因都会搅在一起，用户排查时根本分不清是"没配 key"还是"浏览器起不来"。
 *
 * ── 协议 ──
 * 走 OpenAI 的 /images/generations 约定（多数中转站与国内兼容层都认这套），
 * 返回 b64_json 或 url 两种形态都支持。要接非兼容协议的服务商，实现这个接口即可，
 * core 侧只认 HostImageGenerator。
 *
 * ⚠️ 这条链路没有在真实服务上验证过（当前仓库没有生图服务的凭据）。
 * 首次接真实服务时，重点确认：size 是否被服务商接受、n 的上限、response_format 是否支持。
 */

import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { HostImageGenerator, ImageGenEnv, ImageGenRequest, ImageGenResult, ImageGenFile } from "@axon/core";

/** 生图服务配置（OpenAI 兼容协议） */
export interface ImageProviderConfig {
  /** 形如 https://api.openai.com/v1（末尾斜杠会被规整） */
  baseUrl: string;
  apiKey: string;
  /** 模型名，如 gpt-image-1 / dall-e-3；具体支持哪些取决于服务商 */
  model: string;
}

/**
 * 配置由宿主在启动时注册（与 setMediaVendorDir 同一套路）。
 * 未注册或字段不全时 checkEnv 返回不可用 —— 这样 core 侧能把"没配置"和"调用失败"
 * 区分开，给出的引导文案也不一样。
 */
let imageProviderConfig: ImageProviderConfig | undefined;

export function setImageProviderConfig(cfg: ImageProviderConfig | undefined): void {
  imageProviderConfig = cfg && cfg.baseUrl && cfg.apiKey ? cfg : undefined;
}

export function getImageProviderConfig(): ImageProviderConfig | undefined {
  return imageProviderConfig;
}

/** 选一个不冲突的文件名：同名视为新版本，不覆盖旧图（用户可能正在看上一张） */
async function versionedPath(dir: string, stem: string, index: number, count: number): Promise<string> {
  const base = count > 1 ? `${stem}-${index + 1}` : stem;
  let candidate = join(dir, `${base}.png`);
  for (let v = 2; v <= 999; v++) {
    try {
      await stat(candidate);
      candidate = join(dir, `${base}-v${v}.png`);
    } catch {
      return candidate;
    }
  }
  return candidate;
}

export class HttpImageGenerator implements HostImageGenerator {
  async checkEnv(): Promise<ImageGenEnv> {
    const cfg = imageProviderConfig;
    if (!cfg) {
      return {
        ok: false,
        problem:
          "尚未配置生图服务。请在「设置 → Axon → 图片生成」里填写服务地址（baseUrl）、API Key 和模型名，" +
          "并确认 axon.image.enabled 已打开。",
      };
    }
    return { ok: true };
  }

  async generate(req: ImageGenRequest): Promise<ImageGenResult> {
    const cfg = imageProviderConfig;
    if (!cfg) throw new Error("生图服务未配置");

    const endpoint = `${cfg.baseUrl.replace(/\/+$/, "")}/images/generations`;
    const payload: Record<string, unknown> = {
      model: cfg.model,
      prompt: req.prompt,
      n: req.count,
      size: `${req.width}x${req.height}`,
      response_format: "b64_json",
    };
    if (req.negativePrompt) payload.negative_prompt = req.negativePrompt;

    req.onProgress?.({ phase: "requesting", done: 0, total: req.count });

    const resp = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: req.signal,
    });

    if (!resp.ok) {
      const detail = await resp.text().catch(() => "");
      // 鉴权/额度/内容审核要能一眼区分，模型据此决定"让用户去配置"还是"换个描述"
      const hint =
        resp.status === 401 || resp.status === 403
          ? "（鉴权失败：请检查 API Key 与 baseUrl 是否匹配）"
          : resp.status === 429
            ? "（额度或频率受限）"
            : resp.status === 400
              ? "（请求被拒：可能 size / n / 模型名不被支持，或描述触发了内容审核）"
              : "";
      throw new Error(`生图服务返回 ${resp.status}${hint}：${detail.slice(0, 300)}`);
    }

    const json = (await resp.json()) as { data?: Array<{ b64_json?: string; url?: string }> };
    const items = Array.isArray(json.data) ? json.data : [];
    if (items.length === 0) throw new Error("生图服务没有返回图片数据");

    await mkdir(req.outputDir, { recursive: true });
    const files: ImageGenFile[] = [];
    const warnings: string[] = [];

    for (let i = 0; i < items.length; i++) {
      req.onProgress?.({ phase: "downloading", done: i, total: items.length });
      const item = items[i];
      let bytes: Buffer | undefined;

      if (typeof item.b64_json === "string" && item.b64_json) {
        bytes = Buffer.from(item.b64_json, "base64");
      } else if (typeof item.url === "string" && item.url) {
        const r = await fetch(item.url, { signal: req.signal });
        if (!r.ok) {
          warnings.push(`第 ${i + 1} 张下载失败（HTTP ${r.status}）`);
          continue;
        }
        bytes = Buffer.from(await r.arrayBuffer());
      }

      if (!bytes || bytes.length === 0) {
        warnings.push(`第 ${i + 1} 张没有可用的图像数据`);
        continue;
      }

      const path = await versionedPath(req.outputDir, req.stem, i, items.length);
      await writeFile(path, bytes);
      files.push({ path, size: bytes.length });
    }

    req.onProgress?.({ phase: "downloading", done: items.length, total: items.length });
    if (files.length === 0) throw new Error("生图服务返回了数据，但没有一张能落盘");

    return { files, warnings };
  }
}

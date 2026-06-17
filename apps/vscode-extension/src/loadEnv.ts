/**
 * 扩展端的 provider 环境变量加载
 *
 * server 形态靠 dotenv 读 server/.env；扩展宿主没有这套，需要自己把 provider 配置
 * 填进 process.env，且【必须在 import @axon/core 之前】完成——因为 core/providers.ts 的
 * PROVIDERS 是模块加载时即读取 process.env 的单例。故 extension.ts 用动态 import core，
 * 先同步调用本函数，再加载内核。
 *
 * 配置来源（按优先级，后者补充前者缺失项）：
 *  1. VS Code 设置 axon.providers（对象：{ esign: { apiKey, baseUrl }, ... }）+ axon.env（KV）
 *  2. ~/.axon/.env（dotenv 风格的 KEY=VALUE 文件）
 *
 * 这样用户既能用 IDE 设置界面配，也能复用已有的 ~/.axon/.env 文件。
 */

import * as vscode from "vscode";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/** 解析 dotenv 风格文本为 KV（忽略注释/空行，支持引号包裹的值） */
function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

/** 把一组 KV 写入 process.env（仅当该 key 尚未设置，避免覆盖宿主已有 env） */
function applyEnv(kv: Record<string, string>): void {
  for (const [k, v] of Object.entries(kv)) {
    if (process.env[k] === undefined && v !== undefined && v !== "") {
      process.env[k] = v;
    }
  }
}

/**
 * 加载 provider 环境变量到 process.env。必须在 import @axon/core 之前调用。
 * 返回已识别到的 provider 数量（供日志/诊断）。
 */
export function loadProviderEnv(): { providerCount: number; sources: string[] } {
  const sources: string[] = [];

  // 1) VS Code 设置：axon.env（扁平 KV，直接覆盖式补充）
  const cfg = vscode.workspace.getConfiguration("axon");
  const envSetting = cfg.get<Record<string, string>>("env");
  if (envSetting && typeof envSetting === "object") {
    applyEnv(envSetting);
    if (Object.keys(envSetting).length > 0) sources.push("settings:axon.env");
  }

  // 2) VS Code 设置：axon.providers（结构化 → 转成 PROVIDER_<NAME>_API_KEY/BASE_URL）
  const providersSetting = cfg.get<Record<string, { apiKey?: string; baseUrl?: string }>>("providers");
  if (providersSetting && typeof providersSetting === "object") {
    const kv: Record<string, string> = {};
    for (const [name, conf] of Object.entries(providersSetting)) {
      const upper = name.toUpperCase();
      if (conf?.apiKey) kv[`PROVIDER_${upper}_API_KEY`] = conf.apiKey;
      if (conf?.baseUrl) kv[`PROVIDER_${upper}_BASE_URL`] = conf.baseUrl;
    }
    applyEnv(kv);
    if (Object.keys(kv).length > 0) sources.push("settings:axon.providers");
  }

  // 3) ~/.axon/.env（复用用户已有的 env 文件）
  try {
    const envPath = join(homedir(), ".axon", ".env");
    const text = readFileSync(envPath, "utf-8");
    applyEnv(parseDotenv(text));
    sources.push(envPath);
  } catch {
    /* 文件不存在则跳过 */
  }

  // 统计识别到的 provider 数量
  const providerCount = Object.keys(process.env).filter((k) => /^PROVIDER_\w+_API_KEY$/.test(k)).length;
  return { providerCount, sources };
}

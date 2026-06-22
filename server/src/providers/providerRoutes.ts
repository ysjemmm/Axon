/**
 * Provider 配置路由（Controller）—— 只做请求解析与响应包装，业务委托 ProviderConfigService。
 * 管理 .axon/settings/providers.json（用户级 / 工作区级）。
 *
 * 写操作后会用 ProviderRegistry 重新解析并注入 core（refreshProviders），使运行中的会话即时生效。
 * GET /api/providers 返回脱敏（去掉 apiKey）的解析结果 + 扁平模型列表，供前端模型选择器与 Provider 管理页消费。
 */

import type { Express, Request, Response } from "express";
import { homedir } from "node:os";
import {
  ProviderRegistry,
  refreshProviders,
  probeProviderModels,
  type AgentHost,
  type ResolvedProvider,
} from "@axon/core";
import { ProviderConfigService, type ProviderLevel } from "./providerConfigService.js";

export interface ProviderRouterDeps {
  createHost: () => AgentHost;
  defaultWorkspace: string;
}

function fail(res: Response, err: unknown, status = 400): void {
  const message = (err as Error).message || "未知错误";
  res.status(/不存在/.test(message) ? 404 : status).json({ error: message });
}

function queryStr(req: Request, key: string): string | undefined {
  const v = req.query[key];
  return typeof v === "string" ? v : undefined;
}

function parseLevel(v: unknown): ProviderLevel {
  if (v === "workspace") return "workspace";
  if (v === "user" || v === undefined) return "user";
  throw new Error(`非法的 level：${String(v)}（只能是 user 或 workspace）`);
}

/** 去掉 apiKey 的脱敏 provider（仅暴露 configured 布尔，绝不把密钥回传前端） */
function maskProvider(p: ResolvedProvider) {
  const { apiKey: _omit, ...rest } = p;
  return rest;
}

/** 把解析结果摊平成前端选择器用的扁平模型列表（仅含已配置 provider 的、未禁用的模型） */
function flattenModels(providers: ResolvedProvider[]) {
  return providers
    .filter((p) => p.configured)
    .flatMap((p) =>
      p.models
        .filter((m) => !m.disabled)
        .map((m) => ({
          id: m.id,
          name: m.name,
          contextWindow: m.contextWindow,
          vision: !!m.vision,
          description: m.description || "",
          group: m.group || p.label,
          free: !!m.free,
          provider: p.name,
          builtin: p.builtin,
          tier: m.tier || "balanced",
        })),
    );
}

/** 在 Express app 上注册所有 /api/providers/* 路由 */
export function registerProviderRoutes(app: Express, deps: ProviderRouterDeps): void {
  const service = new ProviderConfigService();

  /** 用注册表重新解析并注入 core 运行时（写操作后调用） */
  const refresh = async (workspace?: string): Promise<ResolvedProvider[]> => {
    const ws = workspace || deps.defaultWorkspace;
    const registry = new ProviderRegistry([ws], deps.createHost(), homedir());
    return refreshProviders(registry);
  };

  /** 解析后的 provider 列表 + 扁平模型（脱敏），供选择器与管理页 */
  app.get("/api/providers", async (req, res) => {
    try {
      const resolved = await refresh(queryStr(req, "workspace"));
      res.json({ providers: resolved.map(maskProvider), models: flattenModels(resolved) });
    } catch (err) {
      fail(res, err, 500);
    }
  });

  /** 原始 providers.json（用户级 + 工作区级），供高级编辑 */
  app.get("/api/providers/config", async (req, res) => {
    try {
      res.json(await service.readAll(queryStr(req, "workspace")));
    } catch (err) {
      fail(res, err, 500);
    }
  });

  /** 覆盖写入某 level 的完整配置 */
  app.put("/api/providers/:level", async (req, res) => {
    try {
      const level = parseLevel(req.params.level);
      const ws = queryStr(req, "workspace");
      await service.write(level, req.body.config, ws);
      await refresh(ws);
      res.json({ ok: true });
    } catch (err) {
      fail(res, err);
    }
  });

  /** 新增/覆盖一个自定义 provider */
  app.post("/api/providers/:level/custom", async (req, res) => {
    try {
      const level = parseLevel(req.params.level);
      const ws = queryStr(req, "workspace");
      const { name, entry } = req.body;
      await service.addProvider(level, name, entry, ws);
      await refresh(ws);
      res.json({ ok: true });
    } catch (err) {
      fail(res, err);
    }
  });

  /** 删除一个自定义 provider */
  app.delete("/api/providers/:level/custom/:name", async (req, res) => {
    try {
      const level = parseLevel(req.params.level);
      const ws = queryStr(req, "workspace");
      await service.removeProvider(level, req.params.name, ws);
      await refresh(ws);
      res.json({ ok: true });
    } catch (err) {
      fail(res, err, 500);
    }
  });

  /** 在用户级 / 工作区级之间迁移一个自定义 provider（迁移后源层级删除） */
  app.post("/api/providers/move", async (req, res) => {
    try {
      const fromLevel = parseLevel(req.body?.fromLevel);
      const toLevel = parseLevel(req.body?.toLevel);
      const ws = queryStr(req, "workspace");
      const name = String(req.body?.name || "").trim();
      if (!name) throw new Error("provider 名称不能为空");
      await service.moveProvider(fromLevel, toLevel, name, ws);
      await refresh(ws);
      res.json({ ok: true });
    } catch (err) {
      fail(res, err, 500);
    }
  });

  /** 设置内置 provider 的 apiKey 覆盖 */
  app.put("/api/providers/:level/builtin-key", async (req, res) => {
    try {
      const level = parseLevel(req.params.level);
      const ws = queryStr(req, "workspace");
      const { name, apiKey } = req.body;
      await service.setBuiltinKey(level, name, apiKey || "", ws);
      await refresh(ws);
      res.json({ ok: true });
    } catch (err) {
      fail(res, err);
    }
  });

  /** 覆盖某自定义 provider 的模型数组（增/删/改/禁用统一整存） */
  app.put("/api/providers/:level/custom/:name/models", async (req, res) => {
    try {
      const level = parseLevel(req.params.level);
      const ws = queryStr(req, "workspace");
      await service.setCustomProviderModels(level, req.params.name, req.body.models || [], ws);
      await refresh(ws);
      res.json({ ok: true });
    } catch (err) {
      fail(res, err);
    }
  });

  /** best-effort 从端点拉取模型列表（直接给 baseUrl/apiKey，或给 name 由后端取已存配置） */
  app.post("/api/providers/probe-models", async (req, res) => {
    try {
      const { baseUrl, apiKey, name, level, workspace } = req.body || {};
      let url = (baseUrl || "").trim();
      let key = (apiKey || "").trim();
      if (!url && name) {
        const cfg = await service.read(parseLevel(level), workspace);
        const entry = cfg.providers?.[name];
        if (!entry) throw new Error(`provider 不存在：${name}`);
        url = (entry.baseUrl || "").trim();
        key = (entry.apiKey || "").trim();
      }
      res.json({ models: await probeProviderModels(url, key) });
    } catch (err) {
      fail(res, err);
    }
  });
}

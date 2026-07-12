/**
 * Marketplace 路由层（Controller）- 只做请求解析与响应包装，业务委托给 MarketplaceService。
 */

import type { Express, Response } from "express";
import { MarketplaceService } from "./marketplaceService.js";

function fail(res: Response, err: unknown, fallbackStatus = 400): void {
  const message = (err as Error).message || "未知错误";
  const status = /不存在/.test(message) ? 404 : fallbackStatus;
  res.status(status).json({ error: message });
}

/** 在 Express app 上注册所有 /api/marketplaces/* 路由 */
export function registerMarketplaceRoutes(app: Express): void {
  const service = new MarketplaceService();

  /** 列出所有已配置的源 */
  app.get("/api/marketplaces", async (_req, res) => {
    try {
      res.json({ sources: await service.listSources() });
    } catch (err) {
      fail(res, err, 500);
    }
  });

  /** 新增一个源 */
  app.post("/api/marketplaces", async (req, res) => {
    try {
      await service.addSource(req.body);
      res.json({ ok: true });
    } catch (err) {
      fail(res, err);
    }
  });

  /** 删除一个源 */
  app.delete("/api/marketplaces/:name", async (req, res) => {
    try {
      await service.removeSource(req.params.name);
      res.json({ ok: true });
    } catch (err) {
      fail(res, err, 500);
    }
  });

  /** 读取原始 JSON 配置（"JSON 编辑"模式） */
  app.get("/api/marketplaces/config/raw", async (_req, res) => {
    try {
      res.json({ content: await service.readRawConfig() });
    } catch (err) {
      fail(res, err, 500);
    }
  });

  /** 覆盖写入原始 JSON 配置（"JSON 编辑"模式保存） */
  app.put("/api/marketplaces/config/raw", async (req, res) => {
    try {
      await service.writeRawConfig(req.body.content);
      res.json({ ok: true });
    } catch (err) {
      fail(res, err);
    }
  });

  /** 拉取指定源的可安装条目列表 */
  app.get("/api/marketplaces/:name/items", async (req, res) => {
    try {
      res.json({ items: await service.fetchItems(req.params.name) });
    } catch (err) {
      fail(res, err, 500);
    }
  });

  /** 从远程源安装一个条目 */
  app.post("/api/marketplaces/:name/install", async (req, res) => {
    try {
      const { path, kind, workspace } = req.body || {};
      if (kind !== "skill" && kind !== "power") throw new Error("kind 必须是 skill 或 power");
      if (!path) throw new Error("path 必填");
      const result = await service.installItem(req.params.name, path, kind, workspace);
      res.json({ ok: true, ...result });
    } catch (err) {
      fail(res, err, 500);
    }
  });

}

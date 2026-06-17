/**
 * 独立 MCP 配置路由（Controller）—— 只做请求解析与响应包装，业务委托 McpConfigService。
 * 管理 .axon/settings/mcp.json（用户级 / 工作区级），与 Power 内嵌 mcp.json 互补。
 */

import type { Express, Request, Response } from "express";
import { McpConfigService, type McpLevel } from "./mcpConfigService.js";

function fail(res: Response, err: unknown, status = 400): void {
  const message = (err as Error).message || "未知错误";
  res.status(/不存在/.test(message) ? 404 : status).json({ error: message });
}

function queryStr(req: Request, key: string): string | undefined {
  const v = req.query[key];
  return typeof v === "string" ? v : undefined;
}

/** 解析并校验 level 参数（默认 user） */
function parseLevel(v: unknown): McpLevel {
  if (v === "workspace") return "workspace";
  if (v === "user" || v === undefined) return "user";
  throw new Error(`非法的 level：${String(v)}（只能是 user 或 workspace）`);
}

/** 在 Express app 上注册所有 /api/mcp/* 路由 */
export function registerMcpRoutes(app: Express): void {
  const service = new McpConfigService();

  /** 一次拉取用户级 + 工作区级配置 */
  app.get("/api/mcp", async (req, res) => {
    try {
      res.json(await service.readAll(queryStr(req, "workspace")));
    } catch (err) {
      fail(res, err, 500);
    }
  });

  /** 覆盖写入某 level 的完整配置 */
  app.put("/api/mcp/:level", async (req, res) => {
    try {
      const level = parseLevel(req.params.level);
      await service.write(level, req.body.config, queryStr(req, "workspace"));
      res.json({ ok: true });
    } catch (err) {
      fail(res, err);
    }
  });

  /** 新增 server */
  app.post("/api/mcp/:level/servers", async (req, res) => {
    try {
      const level = parseLevel(req.params.level);
      const { serverName, server } = req.body;
      await service.addServer(level, serverName, server, queryStr(req, "workspace"));
      res.json({ ok: true });
    } catch (err) {
      fail(res, err);
    }
  });

  /** 删除 server */
  app.delete("/api/mcp/:level/servers/:name", async (req, res) => {
    try {
      const level = parseLevel(req.params.level);
      await service.removeServer(level, req.params.name, queryStr(req, "workspace"));
      res.json({ ok: true });
    } catch (err) {
      fail(res, err, 500);
    }
  });
}

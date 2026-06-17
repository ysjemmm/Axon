/**
 * Power 路由层（Controller）- 只做请求解析与响应包装，业务委托给 PowerService。
 */

import type { Express, Request, Response } from "express";
import { PowerService } from "./powerService.js";

/** 统一错误转响应 */
function fail(res: Response, err: unknown, fallbackStatus = 400): void {
  const message = (err as Error).message || "未知错误";
  const status = /不存在/.test(message) ? 404 : fallbackStatus;
  res.status(status).json({ error: message });
}

/** 从 query 取可选字符串参数 */
function queryStr(req: Request, key: string): string | undefined {
  const v = req.query[key];
  return typeof v === "string" ? v : undefined;
}

/** 在 Express app 上注册所有 /api/powers/* 路由 */
export function registerPowerRoutes(app: Express): void {
  const service = new PowerService();

  /** 列出已安装的 power */
  app.get("/api/powers", async (req, res) => {
    try {
      const workspace = queryStr(req, "workspace");
      res.json({ powers: await service.list(workspace) });
    } catch (err) {
      fail(res, err, 500);
    }
  });

  /** 获取单个 power 完整信息 */
  app.get("/api/powers/:name", async (req, res) => {
    try {
      const workspace = queryStr(req, "workspace");
      const power = await service.get(req.params.name, workspace);
      if (!power) return res.status(404).json({ error: "power 不存在" });
      res.json(power);
    } catch (err) {
      fail(res, err, 500);
    }
  });

  /** 启用/禁用 power */
  app.patch("/api/powers/:name/toggle", async (req, res) => {
    try {
      const enabled = !!req.body.enabled;
      const workspace = queryStr(req, "workspace");
      await service.toggle(req.params.name, enabled, workspace);
      res.json({ ok: true, name: req.params.name, enabled });
    } catch (err) {
      fail(res, err, 500);
    }
  });

  /** 安装 power（上传 POWER.md） */
  app.post("/api/powers/install", async (req, res) => {
    try {
      const { content, workspace } = req.body;
      const result = await service.install(content, workspace);
      res.json({ ok: true, ...result });
    } catch (err) {
      fail(res, err);
    }
  });

  /** 删除 power */
  app.delete("/api/powers/:name", async (req, res) => {
    try {
      const workspace = queryStr(req, "workspace");
      await service.remove(req.params.name, workspace);
      res.json({ ok: true });
    } catch (err) {
      fail(res, err, 500);
    }
  });

  /** 读取 power 的 steering 文件 */
  app.get("/api/powers/:name/steering/:file", async (req, res) => {
    try {
      const workspace = queryStr(req, "workspace");
      const content = await service.readSteering(req.params.name, req.params.file, workspace);
      if (content === null) return res.status(404).json({ error: "steering 文件不存在" });
      res.json({ file: req.params.file, content });
    } catch (err) {
      fail(res, err, 500);
    }
  });

  /** 保存 power 的 MCP 配置 */
  app.put("/api/powers/:name/mcp", async (req, res) => {
    try {
      const workspace = queryStr(req, "workspace");
      await service.saveMcpConfig(req.params.name, req.body.config, workspace);
      res.json({ ok: true });
    } catch (err) {
      fail(res, err, 500);
    }
  });

  /** 在 Power 内添加 Skill */
  app.post("/api/powers/:name/skills", async (req, res) => {
    try {
      const workspace = queryStr(req, "workspace");
      const { skillName, description } = req.body;
      const result = await service.addSkill(req.params.name, skillName, description, workspace);
      res.json({ ok: true, ...result });
    } catch (err) {
      fail(res, err);
    }
  });

  /** 从 Power 内删除 Skill */
  app.delete("/api/powers/:name/skills/:skillName", async (req, res) => {
    try {
      const workspace = queryStr(req, "workspace");
      await service.removeSkill(req.params.name, req.params.skillName, workspace);
      res.json({ ok: true });
    } catch (err) {
      fail(res, err, 500);
    }
  });

  /** 覆盖写入 Power 内 Skill 的 SKILL.md 内容 */
  app.put("/api/powers/:name/skills/:skillName/content", async (req, res) => {
    try {
      const workspace = queryStr(req, "workspace");
      const { content } = req.body;
      await service.saveSkillContent(req.params.name, req.params.skillName, content, workspace);
      res.json({ ok: true });
    } catch (err) {
      fail(res, err, 500);
    }
  });

  /** 在 Power 内添加 MCP 服务器 */
  app.post("/api/powers/:name/mcp-servers", async (req, res) => {
    try {
      const workspace = queryStr(req, "workspace");
      const { serverName, server } = req.body;
      await service.addMcpServer(req.params.name, serverName, server, workspace);
      res.json({ ok: true });
    } catch (err) {
      fail(res, err);
    }
  });

  /** 从 Power 内删除 MCP 服务器 */
  app.delete("/api/powers/:name/mcp-servers/:serverName", async (req, res) => {
    try {
      const workspace = queryStr(req, "workspace");
      await service.removeMcpServer(req.params.name, req.params.serverName, workspace);
      res.json({ ok: true });
    } catch (err) {
      fail(res, err, 500);
    }
  });
}

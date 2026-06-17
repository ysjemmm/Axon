/**
 * Skill 路由层（Controller）- 只做请求解析与响应包装，业务委托给 SkillService。
 *
 * 把原先内联在 index.ts 里的一大段 /api/skills/* 路由抽到此处，index.ts 仅需
 * 调用 registerSkillRoutes(app) 挂载。每个 handler 保持精简（解析参数 → 调 service → 返回）。
 */

import type { Express, Request, Response } from "express";
import { SkillService } from "./skillService.js";

/** 统一把 service 抛出的错误转成响应：包含"不存在"按 404，其余按状态码 */
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

/** 在 Express app 上注册所有 /api/skills/* 路由 */
export function registerSkillRoutes(app: Express): void {
  const service = new SkillService();

  /** 列出已安装的 skill */
  app.get("/api/skills", async (_req, res) => {
    try {
      res.json({ skills: await service.list() });
    } catch (err) {
      fail(res, err, 500);
    }
  });

  /** 启用/禁用 skill */
  app.patch("/api/skills/:name/toggle", async (req, res) => {
    try {
      const disabled = !!req.body.disabled;
      await service.toggle(req.params.name, disabled);
      res.json({ ok: true, name: req.params.name, disabled });
    } catch (err) {
      fail(res, err, 500);
    }
  });

  /** 用 LLM 生成 SKILL.md 内容 */
  app.post("/api/skills/generate", async (req, res) => {
    try {
      const content = await service.generate(req.body.prompt);
      res.json({ ok: true, content });
    } catch (err) {
      fail(res, err, 500);
    }
  });

  /** 上传 SKILL.md 安装 skill（全局或项目级） */
  app.post("/api/skills/upload", async (req, res) => {
    try {
      const { content, workspace } = req.body;
      const result = await service.upload(content, workspace);
      res.json({ ok: true, ...result });
    } catch (err) {
      fail(res, err);
    }
  });

  /** 某 skill 目录的文件树 */
  app.get("/api/skills/:name/tree", async (req, res) => {
    try {
      const { dir, tree } = await service.tree(req.params.name, queryStr(req, "workspace"));
      res.json({ name: req.params.name, dir, tree });
    } catch (err) {
      fail(res, err);
    }
  });

  /** 读取 skill 目录下文件 */
  app.get("/api/skills/:name/file", async (req, res) => {
    try {
      const relPath = queryStr(req, "path") || "";
      const content = await service.readFile(req.params.name, relPath, queryStr(req, "workspace"));
      res.json({ path: relPath, content });
    } catch (err) {
      fail(res, err);
    }
  });

  /** 写入/更新 skill 目录下文件 */
  app.put("/api/skills/:name/file", async (req, res) => {
    try {
      const { path: relPath, content, workspace } = req.body;
      await service.writeFile(req.params.name, relPath, content, workspace);
      res.json({ ok: true, path: relPath });
    } catch (err) {
      fail(res, err);
    }
  });

  /** 新建 skill 目录下文件或目录 */
  app.post("/api/skills/:name/file", async (req, res) => {
    try {
      const { path: relPath, content, workspace } = req.body;
      await service.createEntry(req.params.name, relPath, content ?? "", workspace);
      res.json({ ok: true, path: relPath });
    } catch (err) {
      fail(res, err);
    }
  });

  /** 删除 skill 目录下文件或目录 */
  app.delete("/api/skills/:name/file", async (req, res) => {
    try {
      const relPath = queryStr(req, "path") || "";
      await service.deleteEntry(req.params.name, relPath, queryStr(req, "workspace"));
      res.json({ ok: true, path: relPath });
    } catch (err) {
      fail(res, err);
    }
  });

  /** 删除整个 skill */
  app.delete("/api/skills/:name", async (req, res) => {
    try {
      await service.deleteSkill(req.params.name);
      res.json({ ok: true });
    } catch (err) {
      fail(res, err, 500);
    }
  });
}

/**
 * Agent 路由层 - .axon/agents/*.json 的 CRUD
 * 对齐 skills 路由模式，保持轻量。
 */

import type { Express, Request, Response } from "express";
import { join } from "node:path";
import { readFile, writeFile, unlink, mkdir, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";

interface AgentJSON { name: string; description?: string; systemPrompt?: string; }
interface AgentEntry { name: string; filename: string; description: string; systemPrompt: string; }

function fail(res: Response, err: unknown, code = 400): void {
  const msg = (err as Error).message || "未知错误";
  res.status(/不存在/.test(msg) ? 404 : code).json({ error: msg });
}

function agentsDir(workspace: string): string {
  return join(workspace, ".axon", "agents");
}

export function registerAgentRoutes(app: Express): void {
  app.get("/api/agents", async (req, res) => {
    try {
      const ws = (req.query.workspace as string) || process.cwd();
      const dir = agentsDir(ws);
      if (!existsSync(dir)) { res.json({ agents: [] }); return; }
      const entries = await readdir(dir);
      const agents: AgentEntry[] = [];
      for (const f of entries) {
        if (!f.endsWith(".json")) continue;
        try {
          const raw = await readFile(join(dir, f), "utf-8");
          const a = JSON.parse(raw) as AgentJSON;
          agents.push({ name: a.name || f.replace(".json", ""), filename: f, description: a.description || "", systemPrompt: a.systemPrompt || "" });
        } catch { /* skip broken */ }
      }
      res.json({ agents });
    } catch (err) { fail(res, err, 500); }
  });

  app.get("/api/agents/:name", async (req, res) => {
    try {
      const ws = (req.query.workspace as string) || process.cwd();
      const path = join(agentsDir(ws), `${req.params.name}.json`);
      if (!existsSync(path)) { res.status(404).json({ error: "Agent 不存在" }); return; }
      const raw = await readFile(path, "utf-8");
      res.json(JSON.parse(raw));
    } catch (err) { fail(res, err, 500); }
  });

  app.post("/api/agents", async (req, res) => {
    try {
      const { name, description, systemPrompt, workspace } = req.body || {};
      if (!name) { res.status(400).json({ error: "name 为必填" }); return; }
      const ws = workspace || process.cwd();
      const dir = agentsDir(ws);
      await mkdir(dir, { recursive: true });
      const path = join(dir, `${name}.json`);
      if (existsSync(path)) { res.status(409).json({ error: "同名 Agent 已存在" }); return; }
      const json: AgentJSON = { name, description: description || "", systemPrompt: systemPrompt || "" };
      await writeFile(path, JSON.stringify(json, null, 2), "utf-8");
      res.json({ ok: true, name });
    } catch (err) { fail(res, err, 500); }
  });

  app.put("/api/agents/:name", async (req, res) => {
    try {
      const { name, description, systemPrompt, workspace, oldName } = req.body || {};
      const ws = workspace || process.cwd();
      const dir = agentsDir(ws);
      const oldPath = oldName ? join(dir, `${oldName}.json`) : join(dir, `${req.params.name}.json`);
      if (!existsSync(oldPath)) { res.status(404).json({ error: "Agent 不存在" }); return; }
      if (oldName && name && name !== oldName) {
        const newPath = join(dir, `${name}.json`);
        if (existsSync(newPath)) { res.status(409).json({ error: "同名 Agent 已存在" }); return; }
        await unlink(oldPath);
        const json: AgentJSON = { name, description: description || "", systemPrompt: systemPrompt || "" };
        await writeFile(newPath, JSON.stringify(json, null, 2), "utf-8");
      } else {
        const json: AgentJSON = { name: name || req.params.name, description: description || "", systemPrompt: systemPrompt || "" };
        await writeFile(oldPath, JSON.stringify(json, null, 2), "utf-8");
      }
      res.json({ ok: true, name: name || req.params.name });
    } catch (err) { fail(res, err, 500); }
  });

  app.delete("/api/agents/:name", async (req, res) => {
    try {
      const ws = (req.query.workspace as string) || process.cwd();
      const path = join(agentsDir(ws), `${req.params.name}.json`);
      if (!existsSync(path)) { res.status(404).json({ error: "Agent 不存在" }); return; }
      await unlink(path);
      res.json({ ok: true });
    } catch (err) { fail(res, err, 500); }
  });
}

/**
 * Axon Server 入口
 *
 * HTTP 服务 + WebSocket 端点，前端通过 WS 与 Agent 交互。
 * 每个 WS 连接对应一个独立的 Agent Session。
 */

import "dotenv/config";
import express from "express";
import cors from "cors";
import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { homedir } from "node:os";
import { JsonFileStorage } from "./storage/index.js";
import { directoryBrowser } from "./fsBrowser.js";
import { loadConfig, saveConfig, type WorkspaceGroup } from "./config.js";
import { registerSkillRoutes } from "./skills/skillRoutes.js";
import { registerMcpRoutes } from "./mcp/mcpRoutes.js";
import { registerPowerRoutes } from "./powers/powerRoutes.js";
import { registerMarketplaceRoutes } from "./marketplace/marketplaceRoutes.js";
import { registerProviderRoutes } from "./providers/providerRoutes.js";
import { RelayStore, SessionHub, renameSessionTitle, AXON_PROVIDER, ProviderRegistry, refreshProviders, DEFAULT_COMPACTION_CONFIG, type AgentEvent, type ControlCommand, type CompactionUserConfig } from "@axon/core";
import { createNodeAgentHost, FileCommandTrustStore, createNodeMcpCapability } from "@axon/host-node";
import { WsChannel } from "./wsChannel.js";
import { webSearch, webFetch } from "./webSearch.js";
import { httpAuthMiddleware, verifyWsToken, bindHost, logSecurityPosture } from "./auth.js";

const PORT = parseInt(process.env.PORT || "3001", 10);
// 默认工作区：未指定时用当前目录。会话可各自绑定不同工作区
const DEFAULT_WORKSPACE = process.env.WORKSPACE_DIR || process.cwd();
// 监听地址：默认仅回环（本机安全），显式设置 BIND_HOST 才对外
const HOST = bindHost();

/**
 * 滚动压缩配置（axon.compaction.* 的 Web 形态等价物）。
 *
 * 显式在此声明，不依赖 SessionHub/core 包的兜底默认值：滚动压缩会静默把早期
 * 消息替换为 LLM 摘要，用户无感知（不弹窗），必须由运维/用户显式开启。
 * 默认关闭，与 VS Code 扩展的 axon.compaction.enabled 默认值保持一致。
 * 可通过环境变量 AXON_COMPACTION_ENABLED=true 显式开启。
 */
function readCompactionConfig(): CompactionUserConfig {
  return {
    enabled: process.env.AXON_COMPACTION_ENABLED === "true",
    triggerTokens: parseInt(process.env.AXON_COMPACTION_TRIGGER_TOKENS || "", 10) || DEFAULT_COMPACTION_CONFIG.triggerTokens,
    keepRecentMessages: parseInt(process.env.AXON_COMPACTION_KEEP_RECENT || "", 10) || DEFAULT_COMPACTION_CONFIG.keepRecentMessages,
    toolResultPruneChars: DEFAULT_COMPACTION_CONFIG.toolResultPruneChars,
    toolResultKeepTurns: DEFAULT_COMPACTION_CONFIG.toolResultKeepTurns,
  };
}

// 会话存储固定在用户目录 ~/.axon（与工作区解耦）
const storage = new JsonFileStorage();

// HTTP 服务
const app = express();
app.use(cors());
app.use(express.json({ limit: "25mb" }));
// 鉴权中间件（配置了 AXON_AUTH_TOKEN 才生效；/health 始终放行）
app.use(httpAuthMiddleware());

app.get("/health", (_req, res) => {
  res.json({ status: "ok", defaultWorkspace: DEFAULT_WORKSPACE });
});

// ── 目录浏览 API（前端目录选择器逐层下钻用）─────────────────────────────────

/** 列出某路径下的子目录；path 省略时返回盘符列表（Windows）或根目录 */
app.get("/api/fs/list", async (req, res) => {
  try {
    const path = typeof req.query.path === "string" ? req.query.path : undefined;
    const result = await directoryBrowser.browse(path || undefined);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/** 校验某路径是否为有效目录 */
app.get("/api/fs/validate", async (req, res) => {
  const path = typeof req.query.path === "string" ? req.query.path : "";
  const valid = path ? await directoryBrowser.isValidDir(path) : false;
  res.json({ valid });
});

// ── 会话管理 REST API ─────────────────────────────────────────────────────

/** 列出所有会话 */
app.get("/api/sessions", async (_req, res) => {
  const sessions = await storage.listSessions();
  res.json({ sessions });
});

/** 获取单个会话 */
app.get("/api/sessions/:id", async (req, res) => {
  const session = await storage.getSession(req.params.id);
  if (!session) return res.status(404).json({ error: "会话不存在" });
  res.json(session);
});

/** 创建新会话 */
app.post("/api/sessions", async (req, res) => {
  const { title, model, provider, workspace } = req.body;
  const session = await storage.createSession({
    id: "",
    title: title || "新对话",
    model: model || "auto",
    provider: provider || AXON_PROVIDER,
    workspace: workspace || DEFAULT_WORKSPACE,
    messages: [],
    totalTokens: 0,
  });
  res.json(session);
});

/** 更新会话（目前只有重命名）：标题与其它会话去重，返回最终标题（可能带了「 (2)」序号） */
app.patch("/api/sessions/:id", async (req, res) => {
  const { title, ...rest } = req.body || {};
  if (Object.keys(rest).length > 0) await storage.updateSession(req.params.id, rest);
  const finalTitle = typeof title === "string" ? await renameSessionTitle(storage, req.params.id, title) : null;
  res.json({ ok: true, ...(finalTitle ? { title: finalTitle } : {}) });
});

/** 删除会话 */
app.delete("/api/sessions/:id", async (req, res) => {
  await storage.deleteSession(req.params.id);
  res.json({ ok: true });
});

// ── 工作区组管理 API ──────────────────────────────────────────────────────

/** 获取所有工作区组 */
app.get("/api/workspace-groups", async (_req, res) => {
  const config = await loadConfig();
  res.json({ groups: config.workspaceGroups });
});

/** 创建工作区组 */
app.post("/api/workspace-groups", async (req, res) => {
  const { name, paths } = req.body;
  if (!name || !Array.isArray(paths) || paths.length === 0) {
    return res.status(400).json({ error: "name 和 paths（非空数组）必填" });
  }
  const config = await loadConfig();
  const id = `wg-${Date.now().toString(36)}`;
  const group: WorkspaceGroup = { id, name, paths };
  config.workspaceGroups.push(group);
  await saveConfig(config);
  res.json(group);
});

/** 更新工作区组 */
app.put("/api/workspace-groups/:id", async (req, res) => {
  const { name, paths } = req.body;
  const config = await loadConfig();
  const idx = config.workspaceGroups.findIndex((g) => g.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "工作区组不存在" });
  if (name) config.workspaceGroups[idx].name = name;
  if (Array.isArray(paths) && paths.length > 0) config.workspaceGroups[idx].paths = paths;
  await saveConfig(config);
  res.json(config.workspaceGroups[idx]);
});

/** 删除工作区组 */
app.delete("/api/workspace-groups/:id", async (req, res) => {
  const config = await loadConfig();
  config.workspaceGroups = config.workspaceGroups.filter((g) => g.id !== req.params.id);
  await saveConfig(config);
  res.json({ ok: true });
});

// ── Skill 管理 API ───────────────────────────────────────────────────────
// 业务逻辑已抽到 skills/skillService.ts，路由注册见 registerSkillRoutes。
registerSkillRoutes(app);

// ── Power 能力扩展包 API ─────────────────────────────────────────────────
// 业务逻辑在 powers/powerService.ts，路由注册见 registerPowerRoutes。
registerPowerRoutes(app);

// ── Marketplace（Skill/Power 远程源）API ─────────────────────────────────
// 业务逻辑在 marketplace/marketplaceService.ts，路由注册见 registerMarketplaceRoutes。
registerMarketplaceRoutes(app);

// ── 独立 MCP 配置 API ─────────────────────────────────────────────────────
// 管理 .axon/settings/mcp.json（用户级/工作区级），与 Power 内嵌 mcp.json 互补。
registerMcpRoutes(app);

// ── Provider 配置 API ─────────────────────────────────────────────────────
// 管理 .axon/settings/providers.json（自定义 provider + 内置 key 覆盖），写后即时注入 core 运行时。
registerProviderRoutes(app, { createHost: () => createNodeAgentHost(), defaultWorkspace: DEFAULT_WORKSPACE });

// 启动时把内置目录 + providers.json 解析并注入 core（custom provider 立即可用；
// 未注入时 getClient 也会回退读 env，故此步失败不致命）。
void refreshProviders(new ProviderRegistry([DEFAULT_WORKSPACE], createNodeAgentHost(), homedir()))
  .then((list) => console.log(`   Provider: 已解析 ${list.length} 个（${list.filter((p) => p.configured).length} 个已配置）`))
  .catch((err) => console.warn("[axon] provider 初次注入失败（将回退 env）:", (err as Error).message));

// ── Relay 长任务工作流 API ────────────────────────────────────────────────
// Agent 把 relay 写进【会话工作区】的 .axon/relays/；主目录 .axon/relays/ 下可能有历史遗留产物。
// 因此读取时把两者都作为根合并，避免只认一个根导致列表为空。

/** relay 候选落盘根：请求工作区（缺省 DEFAULT_WORKSPACE）+ 主目录（历史遗留） */
function relayRoots(req: { query: Record<string, unknown> }): string[] {
  const ws = typeof req.query.workspace === "string" && req.query.workspace ? req.query.workspace : DEFAULT_WORKSPACE;
  return [ws, homedir()];
}

/** 列出所有 relay 摘要（工作区 + 主目录合并） */
app.get("/api/relays", async (req, res) => {
  try {
    const store = new RelayStore(relayRoots(req), createNodeAgentHost());
    const relays = await store.list();
    res.json({ relays });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/** 获取单个 relay 完整数据（含三份文档正文） */
app.get("/api/relays/:id", async (req, res) => {
  try {
    const store = new RelayStore(relayRoots(req), createNodeAgentHost());
    const relay = await store.get(req.params.id);
    if (!relay) return res.status(404).json({ error: "relay 不存在" });
    res.json(relay);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/** 更新单个任务状态（前端面板手动勾选用） */
app.patch("/api/relays/:id/tasks/:taskId", async (req, res) => {
  const status = req.body?.status;
  if (!["pending", "in_progress", "completed"].includes(status)) {
    return res.status(400).json({ error: "status 非法" });
  }
  try {
    const store = new RelayStore(relayRoots(req), createNodeAgentHost());
    const relay = await store.setTaskStatus(req.params.id, req.params.taskId, status);
    if (!relay) return res.status(404).json({ error: "relay 不存在" });
    res.json(relay);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/** 删除 relay */
app.delete("/api/relays/:id", async (req, res) => {
  try {
    const store = new RelayStore(relayRoots(req), createNodeAgentHost());
    await store.remove(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

const server = createServer(app);

// WebSocket 服务
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws: WebSocket, req) => {
  // WS 握手鉴权：配置了 token 时校验失败直接关闭连接
  if (!verifyWsToken(req)) {
    console.warn("[ws] 拒绝未授权连接");
    ws.close(4401, "未授权");
    return;
  }
  console.log("[ws] 新连接");

  // 每个连接一个 WsChannel + 一个 SessionHub：把 ws 消息翻译成 ControlCommand 交给 hub.dispatch。
  // 会话生命周期、工作区绑定、编辑确认、持久化、标题生成等逻辑全部收敛在 @axon/core 的 SessionHub。
  const channel = new WsChannel(ws);
  const web = { search: webSearch, fetch: webFetch };
  const hub = new SessionHub({
    storage,
    channel,
    createHost: () => createNodeAgentHost(),
    isValidDir: (p) => directoryBrowser.isValidDir(p),
    resolveWorkspaceGroup: async (groupId) => {
      const config = await loadConfig();
      const g = config.workspaceGroups.find((x) => x.id === groupId);
      return g ? { id: g.id, name: g.name, paths: g.paths } : null;
    },
    defaultWorkspace: DEFAULT_WORKSPACE,
    homeDir: homedir(),
    web,
    mcp: createNodeMcpCapability(),
    commandTrust: new FileCommandTrustStore(),
    getCompactionConfig: readCompactionConfig,
    // 动画 / 视频生成开关：Web 形态没有设置面板，用环境变量显式开启（默认关闭）。
    // 开启后首次渲染会自动下载 ffmpeg 到用户缓存。
    getMediaEnabled: () => process.env.AXON_MEDIA_ENABLED === "1",
  });

  ws.on("message", async (data) => {
    // msg 在 try 外声明，catch 块（取消请求持久化）也需要访问它
    let msg: any;
    try {
      msg = JSON.parse(data.toString());
      await hub.dispatch(msg as ControlCommand);
    } catch (err) {
      const error = err as Error;
      // 取消请求：不发错误消息给前端（用户主动取消不是错误），但仍需持久化已产生的消息
      if (error.name === "AbortError" || error.message?.includes("aborted")) {
        // user_message 的取消交给 hub 持久化已产生的消息；其它指令仅补一个 stream_end
        if (msg && msg.type === "user_message") {
          await hub.persistOnCancel(msg);
        } else {
          channel.emit({ type: "stream_end", elapsed: 0, tokens: 0 } as AgentEvent);
        }
        return;
      }
      channel.emit({ type: "error", content: error.message } as AgentEvent);
    }
  });

  ws.on("close", () => {
    // 连接关闭，hub 持有的 session 随 GC 回收
    console.log("[ws] 连接关闭");
  });
});

server.listen(PORT, HOST, () => {
  console.log(`🧠 Axon Server 启动`);
  console.log(`   HTTP: http://${HOST}:${PORT}`);
  console.log(`   WS:   ws://${HOST}:${PORT}/ws`);
  console.log(`   模型: 多 provider 模式`);
  console.log(`   默认工作区: ${DEFAULT_WORKSPACE}`);
  logSecurityPosture(HOST);
});

/**
 * 工具按需加载：常用工具常驻，不常用的整组工具（浏览器自动化、Relay、产物、表单、媒体、工具很多的 MCP 服务）
 * 平时不放进请求，用到时再加载。
 *
 * ── 为什么 ──
 * 主 Agent 的工具定义每轮都要随请求发送，48 个工具约 1.2 万 token；接一个 GitHub 这样的 MCP 服务
 * 又是几十个工具、上万 token。全量常驻既占上下文，又让模型在一堆不相关的工具里分心。
 *
 * ── 怎么保证不因此「能力不足」 ──
 * 1. 索引：load_tools 的描述里列出每个未加载组的用途和工具名，模型始终知道有什么可用。
 * 2. 预加载：用户这句话命中关键词（「浏览器」「localhost」「截图」…）时先加载对应组。
 * 3. 直接调用也行：模型直接调了未加载组里的工具名，照常执行，并把整组加载上（执行层按名字路由，不依赖工具清单）。
 * 4. 加载后整个会话保持：工具清单只在加载那一下变化（只让提示缓存失效一次）；重开会话时从历史里用过的工具推回来。
 */

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { ToolDef } from "../llm/types.js";

export const LOAD_TOOLS = "load_tools";

export interface ToolGroup {
  id: string;
  /** 一句话用途（给模型看的索引） */
  summary: string;
  tools: string[];
  /** 用户输入命中时预加载 */
  triggers?: RegExp;
}

const BROWSER_TOOLS = [
  "open_browser", "close_browser", "screenshot_page", "get_browser_logs", "get_browser_network", "get_browser_storage",
  "browser_click", "browser_type", "browser_press", "browser_hover", "browser_select", "browser_scroll", "browser_wait",
  "browser_eval", "browser_get_html", "browser_set_viewport", "browser_reload", "browser_back", "browser_forward",
];

/** 内置的按需工具组 */
export const STATIC_TOOL_GROUPS: ToolGroup[] = [
  {
    id: "browser",
    summary: "浏览器自动化：打开网页 / 本地页面、点击输入、截图、看控制台报错和网络请求（验证前端效果、调试页面时用）",
    tools: BROWSER_TOOLS,
    triggers: /浏览器|网页|页面|前端|界面|样式|截图|点击|控制台|localhost|127\.0\.0\.1|playwright|e2e|browser|devtools/i,
  },
  {
    id: "relay",
    summary: "Relay 工作流：需求 / 设计 / 计划三份文档、确认门、子 Agent 按任务执行，用于要跨多次会话推进的大功能",
    tools: ["relay_create", "relay_save_doc", "relay_advance", "relay_update_task", "relay_review_task"],
    triggers: /relay|需求文档|设计文档|实施计划|分阶段/i,
  },
  {
    id: "artifact",
    summary: "产物交付：生成用户要单独打开 / 保存的成品（HTML 原型、SVG、报告、文档、独立脚本），存到产物目录并可局部修改、读回",
    tools: ["create_artifact", "edit_artifact", "read_artifact"],
    triggers: /产物|原型|html|svg|报告|海报|图表|演示|幻灯|ppt|落地页|demo|示意图|一页纸/i,
  },
  {
    id: "form",
    summary: "表单：开工前请用户一次填一组参数（多个字段 / 表格 / 控件），比逐个提问省事",
    tools: ["ask_form"],
    triggers: /表单|填写|问卷|参数配置/i,
  },
  {
    id: "media",
    summary: "媒体生成：把 HTML 动画渲染成 GIF / MP4、文生图",
    tools: ["render_media", "generate_image"],
    triggers: /动画|视频|gif|mp4|生图|画一张|配图|插画|海报/i,
  },
];

/** MCP 服务工具不超过这个数就常驻（小服务不值得多一步加载） */
export const MCP_EAGER_MAX = 6;
/** 索引里每组最多列几个工具名 */
const INDEX_TOOL_NAMES = 12;

/** MCP 工具映射里需要的字段（见 AgentSession.mcpToolMap） */
type McpToolMap = Map<string, { serverName: string; toolName: string }>;

const toolName = (def: ToolDef) => (def as { function?: { name?: string } }).function?.name ?? "";

function mcpTriggers(serverName: string, toolNames: string[]): RegExp | undefined {
  const words = serverName.split(/[\s_\-·:：]+/).filter((w) => w.length >= 2).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (toolNames.some((n) => /mail/i.test(n))) words.push("邮件", "邮箱", "收件", "发件", "email", "mail");
  if (toolNames.some((n) => /issue|pull_request|repositor/i.test(n))) words.push("github", "issue", "pr", "仓库");
  return words.length ? new RegExp(words.join("|"), "i") : undefined;
}

export class ToolLoadout {
  private readonly loaded = new Set<string>();
  private hydrated = false;

  /** 当前工具清单下的全部按需组（内置组 + 工具多的 MCP 服务） */
  groups(all: ToolDef[], mcpMap: McpToolMap, exempt: string[] = []): ToolGroup[] {
    const present = new Set(all.map(toolName));
    const groups: ToolGroup[] = [];
    for (const group of STATIC_TOOL_GROUPS) {
      if (exempt.includes(group.id)) continue;
      const tools = group.tools.filter((t) => present.has(t));
      if (tools.length) groups.push({ ...group, tools });
    }
    const byServer = new Map<string, string[]>();
    for (const [name, info] of mcpMap) {
      if (!present.has(name)) continue;
      const list = byServer.get(info.serverName) ?? [];
      list.push(name);
      byServer.set(info.serverName, list);
    }
    for (const [serverName, tools] of byServer) {
      if (tools.length <= MCP_EAGER_MAX) continue;
      const raw = tools.map((t) => mcpMap.get(t)?.toolName ?? t);
      groups.push({ id: `mcp:${serverName}`, summary: `[MCP·${serverName}] ${tools.length} 个工具，如 ${raw.slice(0, 6).join("、")}`, tools, triggers: mcpTriggers(serverName, raw) });
    }
    return groups;
  }

  isLoaded(groupId: string): boolean {
    return this.loaded.has(groupId);
  }

  /** 从历史推回已加载的组：用过的工具、load_tools 调用（重开会话 / 进程重启后） */
  hydrate(messages: ChatCompletionMessageParam[], groups: ToolGroup[]): void {
    if (this.hydrated) return;
    this.hydrated = true;
    for (const message of messages) {
      const calls = (message as { tool_calls?: { function?: { name?: string; arguments?: string } }[] }).tool_calls;
      for (const call of calls ?? []) {
        const name = call.function?.name ?? "";
        if (name === LOAD_TOOLS) {
          try { this.load(JSON.parse(call.function?.arguments || "{}"), groups); } catch { /* 参数损坏：忽略 */ }
        } else {
          this.noteToolUsed(name, groups);
        }
      }
    }
  }

  /** 用户输入命中关键词时预加载 */
  preload(input: string, groups: ToolGroup[]): string[] {
    const added: string[] = [];
    for (const group of groups) {
      if (!this.loaded.has(group.id) && group.triggers?.test(input)) {
        this.loaded.add(group.id);
        added.push(group.id);
      }
    }
    return added;
  }

  /** 模型直接调用了某个工具：所在组标记为已加载（调用本身照常执行） */
  noteToolUsed(name: string, groups: ToolGroup[]): void {
    const group = groups.find((g) => g.tools.includes(name));
    if (group) this.loaded.add(group.id);
  }

  /** load_tools：按组名或工具名加载 */
  load(args: { groups?: unknown; tools?: unknown }, groups: ToolGroup[]): { loaded: ToolGroup[]; unknown: string[] } {
    const wanted = [
      ...(Array.isArray(args.groups) ? args.groups : typeof args.groups === "string" ? [args.groups] : []),
      ...(Array.isArray(args.tools) ? args.tools : typeof args.tools === "string" ? [args.tools] : []),
    ].map(String).map((s) => s.trim()).filter(Boolean);
    const loaded: ToolGroup[] = [];
    const unknown: string[] = [];
    for (const key of wanted) {
      const group = groups.find((g) => g.id === key || g.id.toLowerCase() === key.toLowerCase() || g.tools.includes(key));
      if (!group) { unknown.push(key); continue; }
      this.loaded.add(group.id);
      if (!loaded.includes(group)) loaded.push(group);
    }
    return { loaded, unknown };
  }

  /** 过滤出本轮要发给模型的工具：常驻 + 已加载组；还有未加载组时附上 load_tools（带索引） */
  apply(all: ToolDef[], groups: ToolGroup[]): ToolDef[] {
    const pending = groups.filter((g) => !this.loaded.has(g.id));
    if (pending.length === 0) return all;
    const hidden = new Set(pending.flatMap((g) => g.tools));
    return [...all.filter((def) => !hidden.has(toolName(def))), loadToolsDef(pending)];
  }
}

function loadToolsDef(pending: ToolGroup[]): ToolDef {
  const index = pending.map((g) => {
    const names = g.id.startsWith("mcp:") ? "" : `（${g.tools.slice(0, INDEX_TOOL_NAMES).join("、")}${g.tools.length > INDEX_TOOL_NAMES ? "…" : ""}）`;
    return `- ${g.id}：${g.summary}${names}`;
  });
  return {
    type: "function",
    function: {
      name: LOAD_TOOLS,
      description:
        "加载默认没有放进工具列表的工具组。加载后本会话一直可用，同一组不用重复加载。\n" +
        "需要下面某类能力时先调用本工具（一次可以加载多组），下一步就能直接用这些工具；不确定要不要用时不必提前加载。\n\n" +
        `可加载的工具组：\n${index.join("\n")}`,
      parameters: {
        type: "object",
        properties: {
          groups: { type: "array", items: { type: "string" }, description: "要加载的组名，如 [\"browser\"]" },
        },
        required: ["groups"],
      },
    },
  } as ToolDef;
}

/** 工具回执 */
export function loadToolsResult(result: { loaded: ToolGroup[]; unknown: string[] }, available: ToolGroup[]): { result: string; status: "success" | "error" } {
  if (result.loaded.length === 0) {
    return { result: `没有找到要加载的工具组：${result.unknown.join("、") || "（空）"}。可加载的组：${available.map((g) => g.id).join("、") || "（无）"}`, status: "error" };
  }
  const parts = result.loaded.map((g) => `${g.id}（${g.tools.length} 个工具）`);
  return {
    result: `已加载：${parts.join("、")}。现在可以直接调用这些工具。${result.unknown.length ? `（未找到：${result.unknown.join("、")}）` : ""}`,
    status: "success",
  };
}

/**
 * 连接器目录：常用服务的「填几个字段就能用」的预设。每个连接器最终编译成一个 MCP server 规格，
 * 由现有的 MCP 运行时连接，工具自动出现在 Agent 的工具集里（见 McpRegistry 的 connector 来源）。
 *
 * 和直接写 mcp.json 的区别：用户不需要知道命令、参数、环境变量名，只填「令牌 / 邮箱 / 授权码」；
 * 密钥单独存放（见 store.ts），不会出现在 mcp.json 或工作区里。
 *
 * 加一个连接器：在 CONNECTOR_TEMPLATES 里加一项，写清楚字段和 build。
 */

import type { McpServerSpec } from "../mcp/types.js";

export type ConnectorCategory = "dev" | "mail" | "office" | "data" | "custom";

export const CONNECTOR_CATEGORIES: { id: ConnectorCategory; label: string }[] = [
  { id: "dev", label: "开发" },
  { id: "mail", label: "邮箱" },
  { id: "office", label: "办公协作" },
  { id: "data", label: "数据" },
  { id: "custom", label: "自定义" },
];

export interface ConnectorField {
  key: string;
  label: string;
  type: "text" | "secret" | "boolean" | "select" | "textarea";
  placeholder?: string;
  hint?: string;
  required?: boolean;
  default?: string;
  options?: { value: string; label: string }[];
}

/** 编译出的 server 规格（id / name / source 由注册表补上） */
export type ConnectorSpec = Omit<McpServerSpec, "id" | "name" | "source">;

export interface ConnectorTemplate {
  id: string;
  name: string;
  category: ConnectorCategory;
  description: string;
  /** 图标键（前端映射到图标） */
  icon: string;
  /** 怎么拿到令牌 / 授权码：一两句话 + 链接 */
  setup?: string;
  docsUrl?: string;
  fields: ConnectorField[];
  /**
   * 授权方式（缺省 = 填字段）：
   *   · oauth：远程 MCP 标准授权，点「连接」去浏览器授权，不用填令牌
   *   · github-device：GitHub 设备码登录（用 Axon 自己的 GitHub OAuth App），登录后令牌自动填进 token 字段
   */
  auth?: "oauth" | "github-device";
  /** values 已合并默认值与密钥；ctx.id 是连接器 id（OAuth 凭据按它存放） */
  build: (values: Record<string, string>, ctx: { id: string }) => ConnectorSpec;
}

/** 给前端的目录（不含 build） */
export type ConnectorTemplateInfo = Omit<ConnectorTemplate, "build">;

const truthy = (v: string | undefined) => v === "true" || v === "1";

/** 简单的命令行拆分：支持双引号 / 单引号包住含空格的参数 */
export function splitArgs(input: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/** KEY=VALUE 每行一个 */
export function parseEnvLines(input: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of input.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return env;
}

/** 邮箱连接器（Axon 内置的 IMAP/SMTP server）：不同邮箱只是服务器地址和说明不同 */
function mailTemplate(id: string, name: string, preset: { imapHost: string; smtpHost: string; setup: string; docsUrl?: string; passwordLabel: string }): ConnectorTemplate {
  return {
    id,
    name,
    category: "mail",
    description: "读取、搜索邮件和附件，起草并发送邮件（发送前会请你确认）",
    icon: "mail",
    setup: preset.setup,
    docsUrl: preset.docsUrl,
    fields: [
      { key: "user", label: "邮箱地址", type: "text", placeholder: "name@example.com", required: true },
      { key: "password", label: preset.passwordLabel, type: "secret", required: true },
      { key: "imapHost", label: "收信服务器（IMAP）", type: "text", default: preset.imapHost, required: true },
      { key: "imapPort", label: "IMAP 端口", type: "text", default: "993" },
      { key: "smtpHost", label: "发信服务器（SMTP）", type: "text", default: preset.smtpHost, required: true },
      { key: "smtpPort", label: "SMTP 端口", type: "text", default: "465" },
    ],
    build: (v) => ({
      transport: "builtin",
      builtin: "mail",
      env: {
        MAIL_USER: v.user,
        MAIL_PASSWORD: v.password,
        IMAP_HOST: v.imapHost,
        IMAP_PORT: v.imapPort || "993",
        SMTP_HOST: v.smtpHost,
        SMTP_PORT: v.smtpPort || "465",
      },
      // 只读的放行；发送邮件每次都要用户确认
      autoApprove: ["mail_list_folders", "mail_search", "mail_read", "mail_save_attachment"],
    }),
  };
}

/**
 * 远程 MCP + OAuth 的连接器：服务方托管 MCP，支持动态注册客户端，点「连接」去浏览器授权即可。
 * autoApprove 只放查询类工具（名字按各家公开的工具命名，猜不中的就是每次确认，不会多放行）。
 */
function oauthTemplate(t: { id: string; name: string; category: ConnectorCategory; description: string; icon: string; url: string; autoApprove: string[]; docsUrl?: string }): ConnectorTemplate {
  return {
    id: t.id,
    name: t.name,
    category: t.category,
    description: t.description,
    icon: t.icon,
    docsUrl: t.docsUrl,
    auth: "oauth",
    setup: `点「连接」会打开浏览器，登录 ${t.name} 并同意授权后自动回到 Axon，不需要复制令牌。`,
    fields: [],
    build: (_v, ctx) => ({ transport: "http", url: t.url, oauth: { key: ctx.id }, autoApprove: t.autoApprove }),
  };
}

export const CONNECTOR_TEMPLATES: ConnectorTemplate[] = [
  {
    id: "github",
    name: "GitHub",
    category: "dev",
    description: "查仓库、代码、Issue、PR、Actions，创建 Issue 和 PR",
    icon: "github",
    auth: "github-device",
    setup: "点「使用 GitHub 登录」，在打开的页面输入显示的验证码并授权即可。也可以手动填一个个人访问令牌（Settings → Developer settings → Personal access tokens）。",
    docsUrl: "https://github.com/settings/personal-access-tokens",
    fields: [
      { key: "token", label: "个人访问令牌", type: "secret", placeholder: "github_pat_…", required: true },
      { key: "readonly", label: "只读模式（只查询，不做任何修改）", type: "boolean", default: "true" },
    ],
    build: (v) => ({
      transport: "http",
      url: "https://api.githubcopilot.com/mcp/",
      headers: {
        Authorization: `Bearer ${v.token}`,
        ...(truthy(v.readonly) ? { "X-MCP-Readonly": "true" } : {}),
      },
      autoApprove: ["get_*", "list_*", "search_*"],
    }),
  },
  {
    id: "gitlab",
    name: "GitLab",
    category: "dev",
    description: "查项目、文件、Issue、合并请求，也支持自建 GitLab",
    icon: "gitlab",
    setup: "在 GitLab → 偏好设置 → 访问令牌 创建一个令牌（勾选 api 或 read_api）。需要本机装有 Node.js。",
    fields: [
      { key: "token", label: "访问令牌", type: "secret", placeholder: "glpat-…", required: true },
      { key: "apiUrl", label: "API 地址", type: "text", default: "https://gitlab.com/api/v4", hint: "自建 GitLab 填 https://你的域名/api/v4" },
    ],
    build: (v) => ({
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-gitlab"],
      env: { GITLAB_PERSONAL_ACCESS_TOKEN: v.token, GITLAB_API_URL: v.apiUrl || "https://gitlab.com/api/v4" },
      autoApprove: ["get_*", "list_*", "search_*"],
    }),
  },
  mailTemplate("gmail", "Gmail", {
    imapHost: "imap.gmail.com",
    smtpHost: "smtp.gmail.com",
    passwordLabel: "应用专用密码",
    setup: "Gmail 不能直接用登录密码：先开启两步验证，再到 Google 账号 → 安全性 → 应用专用密码 生成一个 16 位密码填到这里。",
    docsUrl: "https://myaccount.google.com/apppasswords",
  }),
  mailTemplate("qqmail", "QQ 邮箱", {
    imapHost: "imap.qq.com",
    smtpHost: "smtp.qq.com",
    passwordLabel: "授权码",
    setup: "在 QQ 邮箱网页版 → 设置 → 账号 → POP3/IMAP/SMTP 服务 中开启 IMAP/SMTP，按提示获取授权码（不是 QQ 密码）。",
  }),
  mailTemplate("163mail", "163 邮箱", {
    imapHost: "imap.163.com",
    smtpHost: "smtp.163.com",
    passwordLabel: "授权码",
    setup: "在 163 邮箱网页版 → 设置 → POP3/SMTP/IMAP 中开启 IMAP/SMTP 服务，按提示获取授权码（不是登录密码）。",
  }),
  mailTemplate("exmail", "腾讯企业邮", {
    imapHost: "imap.exmail.qq.com",
    smtpHost: "smtp.exmail.qq.com",
    passwordLabel: "密码或客户端专用密码",
    setup: "开启了安全登录的账号需要在 企业邮箱 → 设置 → 微信绑定/客户端专用密码 中生成专用密码。",
  }),
  mailTemplate("imap", "其他邮箱（IMAP）", {
    imapHost: "",
    smtpHost: "",
    passwordLabel: "密码或授权码",
    setup: "填写邮箱服务商提供的 IMAP / SMTP 服务器地址。大部分邮箱需要先在网页版设置里开启 IMAP/SMTP。",
  }),
  {
    id: "feishu",
    name: "飞书",
    category: "office",
    description: "读写飞书文档、多维表格、消息和日历（取决于应用权限）",
    icon: "feishu",
    setup: "在飞书开放平台创建一个企业自建应用，开通需要的权限并发布，把应用的 App ID 和 App Secret 填到这里。需要本机装有 Node.js。",
    docsUrl: "https://open.feishu.cn/app",
    fields: [
      { key: "appId", label: "App ID", type: "text", placeholder: "cli_…", required: true },
      { key: "appSecret", label: "App Secret", type: "secret", required: true },
      { key: "domain", label: "版本", type: "select", default: "feishu", options: [{ value: "feishu", label: "飞书（国内）" }, { value: "lark", label: "Lark（海外）" }] },
    ],
    build: (v) => ({
      transport: "stdio",
      command: "npx",
      args: ["-y", "@larksuiteoapi/lark-mcp", "mcp", "-a", v.appId, "-s", v.appSecret, ...(v.domain === "lark" ? ["--domain", "https://open.larksuite.com"] : [])],
    }),
  },
  oauthTemplate({
    id: "notion-oauth", name: "Notion", category: "office", icon: "notion",
    description: "搜索、读取和编辑 Notion 页面与数据库（按你的 Notion 账号权限）",
    url: "https://mcp.notion.com/mcp",
    autoApprove: ["notion-search", "notion-fetch", "notion-get-*"],
  }),
  oauthTemplate({
    id: "linear", name: "Linear", category: "dev", icon: "linear",
    description: "查看和管理 Linear 的 Issue、项目、周期与评论",
    url: "https://mcp.linear.app/mcp",
    autoApprove: ["list_*", "get_*", "search_*"],
  }),
  oauthTemplate({
    id: "atlassian", name: "Jira / Confluence", category: "office", icon: "atlassian",
    description: "搜索和编辑 Jira 工单、Confluence 页面（Atlassian Cloud）",
    url: "https://mcp.atlassian.com/v1/mcp",
    autoApprove: ["get*", "search*", "lookup*", "atlassianUserInfo"],
  }),
  oauthTemplate({
    id: "sentry", name: "Sentry", category: "dev", icon: "sentry",
    description: "查看 Sentry 的报错、Issue 详情和发布情况，定位线上问题",
    url: "https://mcp.sentry.dev/mcp",
    autoApprove: ["find_*", "get_*", "search_*", "whoami"],
  }),
  oauthTemplate({
    id: "stripe", name: "Stripe", category: "data", icon: "stripe",
    description: "查询 Stripe 的客户、订单、支付与订阅",
    url: "https://mcp.stripe.com",
    autoApprove: ["list_*", "retrieve_*", "search_*", "get_*"],
  }),
  {
    id: "notion",
    name: "Notion（集成令牌）",
    category: "office",
    description: "搜索、读取和编辑 Notion 页面与数据库",
    icon: "notion",
    setup: "在 Notion → 设置 → 集成 创建一个内部集成，复制令牌；再到需要访问的页面里把这个集成加为连接。需要本机装有 Node.js。",
    docsUrl: "https://www.notion.so/profile/integrations",
    fields: [{ key: "token", label: "集成令牌", type: "secret", placeholder: "ntn_…", required: true }],
    build: (v) => ({
      transport: "stdio",
      command: "npx",
      args: ["-y", "@notionhq/notion-mcp-server"],
      env: { NOTION_TOKEN: v.token },
    }),
  },
  {
    id: "slack",
    name: "Slack",
    category: "office",
    description: "读取频道消息、发送消息、查看成员",
    icon: "slack",
    setup: "在 api.slack.com/apps 创建应用，添加 Bot Token Scopes（如 channels:history、chat:write）并安装到工作区，复制 Bot Token。需要本机装有 Node.js。",
    docsUrl: "https://api.slack.com/apps",
    fields: [
      { key: "token", label: "Bot Token", type: "secret", placeholder: "xoxb-…", required: true },
      { key: "teamId", label: "工作区 ID", type: "text", placeholder: "T01234567", required: true },
    ],
    build: (v) => ({
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-slack"],
      env: { SLACK_BOT_TOKEN: v.token, SLACK_TEAM_ID: v.teamId },
      autoApprove: ["slack_list_channels", "slack_get_channel_history", "slack_get_thread_replies", "slack_get_users", "slack_get_user_profile"],
    }),
  },
  {
    id: "postgres",
    name: "PostgreSQL",
    category: "data",
    description: "只读查询数据库：看表结构、跑 SELECT",
    icon: "database",
    setup: "建议用一个只读账号。需要本机装有 Node.js。",
    fields: [{ key: "url", label: "连接串", type: "secret", placeholder: "postgresql://user:password@host:5432/db", required: true }],
    build: (v) => ({
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-postgres", v.url],
      autoApprove: ["query"],
    }),
  },
  {
    id: "custom-remote-oauth",
    name: "自定义（远程 · 浏览器授权）",
    category: "custom",
    description: "连接支持 MCP 标准 OAuth 授权的远程服务，点「连接」去浏览器授权",
    icon: "globe",
    auth: "oauth",
    fields: [
      { key: "url", label: "服务地址", type: "text", placeholder: "https://example.com/mcp", required: true },
      { key: "autoApprove", label: "免确认的工具", type: "text", placeholder: "如 get_*, list_*（逗号分隔，留空表示每次都确认）" },
    ],
    build: (v, ctx) => ({
      transport: "http",
      url: v.url,
      oauth: { key: ctx.id },
      autoApprove: (v.autoApprove || "").split(/[,，\s]+/).filter(Boolean),
    }),
  },
  {
    id: "custom-remote",
    name: "自定义（远程地址）",
    category: "custom",
    description: "连接任意远程 MCP 服务（Streamable HTTP / SSE）",
    icon: "globe",
    fields: [
      { key: "url", label: "服务地址", type: "text", placeholder: "https://example.com/mcp", required: true },
      { key: "headerName", label: "鉴权请求头", type: "text", default: "Authorization", hint: "不需要鉴权就清空" },
      { key: "headerValue", label: "请求头的值", type: "secret", placeholder: "Bearer …" },
      { key: "autoApprove", label: "免确认的工具", type: "text", placeholder: "如 get_*, list_*（逗号分隔，留空表示每次都确认）" },
    ],
    build: (v) => ({
      transport: "http",
      url: v.url,
      ...(v.headerName && v.headerValue ? { headers: { [v.headerName]: v.headerValue } } : {}),
      autoApprove: (v.autoApprove || "").split(/[,，\s]+/).filter(Boolean),
    }),
  },
  {
    id: "custom-local",
    name: "自定义（本地命令）",
    category: "custom",
    description: "运行一个本地 MCP 服务，例如 npx 包或 Python 脚本",
    icon: "terminal",
    fields: [
      { key: "command", label: "命令", type: "text", placeholder: "npx", required: true },
      { key: "args", label: "参数", type: "text", placeholder: "-y @scope/some-mcp-server --flag value" },
      { key: "env", label: "环境变量（含密钥）", type: "textarea", placeholder: "API_KEY=...\nOTHER=...", hint: "每行一个 KEY=VALUE，按密钥保存" },
      { key: "autoApprove", label: "免确认的工具", type: "text", placeholder: "如 get_*, list_*（逗号分隔）" },
    ],
    build: (v) => ({
      transport: "stdio",
      command: v.command,
      args: splitArgs(v.args || ""),
      env: parseEnvLines(v.env || ""),
      autoApprove: (v.autoApprove || "").split(/[,，\s]+/).filter(Boolean),
    }),
  },
];

export function getConnectorTemplate(id: string): ConnectorTemplate | undefined {
  return CONNECTOR_TEMPLATES.find((t) => t.id === id);
}

export function connectorCatalog(): ConnectorTemplateInfo[] {
  return CONNECTOR_TEMPLATES.map(({ build: _build, ...info }) => info);
}

/** 字段是否按密钥保存（secret 和 textarea 环境变量都算） */
export function isSecretField(field: ConnectorField): boolean {
  return field.type === "secret" || field.type === "textarea";
}

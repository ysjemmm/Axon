/**
 * 内置邮箱 MCP server（IMAP 收信 + SMTP 发信），给「邮箱」类连接器用（Gmail / QQ / 163 / 企业邮 / 任意 IMAP）。
 *
 * 为什么自己写：通用的邮箱 MCP server 要么只支持 Gmail OAuth（需要注册 Google 应用），要么维护状况不明。
 * 国内办公最常用的是 QQ / 163 / 企业邮，这些都只支持「授权码 + IMAP/SMTP」，用标准协议最稳。
 *
 * 运行在宿主进程内（InMemoryTransport），不起子进程。配置全部来自连接器编译出的 env。
 * 每次调用独立建连、用完即登出：调用频率低，长连接的保活与断线重连反而更容易出问题。
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { ImapFlow, type SearchObject } from "imapflow";
import { simpleParser, type AddressObject } from "mailparser";
import nodemailer from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer/index.js";

interface MailConfig {
  user: string;
  password: string;
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
}

const MAX_BODY_CHARS = 20_000;
const MAX_LIMIT = 50;

function readConfig(env: Record<string, string>): MailConfig {
  const config = {
    user: env.MAIL_USER || "",
    password: env.MAIL_PASSWORD || "",
    imapHost: env.IMAP_HOST || "",
    imapPort: Number(env.IMAP_PORT) || 993,
    smtpHost: env.SMTP_HOST || "",
    smtpPort: Number(env.SMTP_PORT) || 465,
  };
  if (!config.user || !config.password || !config.imapHost) throw new Error("邮箱连接器缺少邮箱地址、授权码或 IMAP 服务器");
  return config;
}

/** 常见报错翻译成人话：授权码错、没开 IMAP、连不上服务器 */
function explain(err: unknown): string {
  const raw = (err as { responseText?: string; message?: string })?.responseText || (err as Error)?.message || String(err);
  if (/auth|login|invalid credentials|password|535|authenticat/i.test(raw)) return `登录失败：邮箱地址或授权码不对，或者邮箱没有开启 IMAP/SMTP 服务。（${raw}）`;
  if (/ENOTFOUND|EAI_AGAIN/i.test(raw)) return `找不到邮件服务器，请检查服务器地址。（${raw}）`;
  if (/ECONNREFUSED|ETIMEDOUT|timeout/i.test(raw)) return `连不上邮件服务器，请检查端口和网络。（${raw}）`;
  return raw;
}

async function withImap<T>(config: MailConfig, fn: (client: ImapFlow) => Promise<T>): Promise<T> {
  const client = new ImapFlow({
    host: config.imapHost,
    port: config.imapPort,
    secure: config.imapPort === 993,
    auth: { user: config.user, pass: config.password },
    logger: false,
    disableAutoIdle: true,
    // 163 等邮箱要求客户端先发 ID 才允许访问收件箱
    clientInfo: { name: "Axon", version: "1.0.0" },
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.logout().catch(() => undefined);
  }
}

const addressText = (a?: AddressObject | AddressObject[]) => (Array.isArray(a) ? a.map((x) => x.text).join(", ") : a?.text ?? "");

function envelopeAddress(list?: { name?: string; address?: string }[]): string {
  return (list ?? []).map((a) => (a.name ? `${a.name} <${a.address}>` : a.address ?? "")).join(", ");
}

function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&quot;/g, "\"")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 收件人：字符串（逗号分隔）或数组都接受 */
function recipients(v: unknown): string | undefined {
  if (Array.isArray(v)) return v.filter((x) => typeof x === "string" && x.trim()).join(", ") || undefined;
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

const TOOLS = [
  {
    name: "mail_list_folders",
    description: "列出邮箱里的文件夹（收件箱、已发送、草稿箱、自定义文件夹等）。",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "mail_search",
    description: "搜索邮件，按时间从新到旧返回摘要（uid、时间、发件人、主题、是否已读、附件数）。读正文用 mail_read。",
    inputSchema: {
      type: "object",
      properties: {
        folder: { type: "string", description: "文件夹，默认 INBOX（收件箱）" },
        text: { type: "string", description: "在主题和正文里搜索的关键词" },
        from: { type: "string", description: "发件人（地址或名字的一部分）" },
        subject: { type: "string", description: "主题包含" },
        since: { type: "string", description: "起始日期 YYYY-MM-DD（含）" },
        before: { type: "string", description: "截止日期 YYYY-MM-DD（不含）" },
        unread: { type: "boolean", description: "只看未读" },
        limit: { type: "number", description: `最多返回几封，默认 20，最大 ${MAX_LIMIT}` },
      },
    },
  },
  {
    name: "mail_read",
    description: "读取一封邮件的完整内容：发件人、收件人、时间、正文、附件列表（附件用 mail_save_attachment 保存）。不会把邮件标为已读。",
    inputSchema: {
      type: "object",
      properties: {
        uid: { type: "number", description: "mail_search 返回的 uid" },
        folder: { type: "string", description: "文件夹，默认 INBOX" },
      },
      required: ["uid"],
    },
  },
  {
    name: "mail_save_attachment",
    description: "把邮件附件保存到本地文件夹，返回保存后的路径。",
    inputSchema: {
      type: "object",
      properties: {
        uid: { type: "number" },
        folder: { type: "string", description: "文件夹，默认 INBOX" },
        index: { type: "number", description: "附件序号（mail_read 列出的，从 1 开始）；不填则保存全部附件" },
        saveDir: { type: "string", description: "保存到哪个文件夹（绝对路径）" },
      },
      required: ["uid", "saveDir"],
    },
  },
  {
    name: "mail_send",
    description: "发送一封邮件（可带附件、可作为回复）。发送前用户会看到内容并确认。",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "收件人，多个用逗号分隔" },
        cc: { type: "string", description: "抄送" },
        bcc: { type: "string", description: "密送" },
        subject: { type: "string" },
        text: { type: "string", description: "正文（纯文本）" },
        html: { type: "string", description: "可选：HTML 正文" },
        attachments: { type: "array", items: { type: "string" }, description: "附件的本地绝对路径" },
        replyToUid: { type: "number", description: "可选：回复哪封邮件（uid），会带上引用关系" },
        replyFolder: { type: "string", description: "被回复邮件所在文件夹，默认 INBOX" },
      },
      required: ["to", "subject", "text"],
    },
  },
];

async function listFolders(config: MailConfig): Promise<string> {
  return withImap(config, async (client) => {
    const boxes = await client.list();
    return boxes.map((b) => `- ${b.path}${b.specialUse ? `（${b.specialUse}）` : ""}`).join("\n") || "（没有文件夹）";
  });
}

async function search(config: MailConfig, args: Record<string, unknown>): Promise<string> {
  const folder = typeof args.folder === "string" && args.folder ? args.folder : "INBOX";
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(args.limit) || 20));
  const query: SearchObject = {};
  if (typeof args.text === "string" && args.text) query.text = args.text;
  if (typeof args.from === "string" && args.from) query.from = args.from;
  if (typeof args.subject === "string" && args.subject) query.subject = args.subject;
  if (typeof args.since === "string" && args.since) query.since = args.since;
  if (typeof args.before === "string" && args.before) query.before = args.before;
  if (args.unread === true) query.seen = false;
  if (Object.keys(query).length === 0) query.all = true;
  return withImap(config, async (client) => {
    const lock = await client.getMailboxLock(folder);
    try {
      const uids = (await client.search(query, { uid: true })) || [];
      const picked = uids.slice(-limit).reverse();
      if (picked.length === 0) return `「${folder}」里没有符合条件的邮件。`;
      const rows: string[] = [];
      for await (const msg of client.fetch(picked, { uid: true, envelope: true, flags: true, bodyStructure: true, internalDate: true }, { uid: true })) {
        const attachments = countAttachments(msg.bodyStructure);
        const date = msg.envelope?.date ?? msg.internalDate;
        rows.push(`uid=${msg.uid} | ${date ? new Date(date).toLocaleString("zh-CN", { hour12: false }) : ""} | ${envelopeAddress(msg.envelope?.from)} | ${msg.envelope?.subject ?? "（无主题）"}${msg.flags?.has("\\Seen") ? "" : " | 未读"}${attachments ? ` | 附件 ${attachments}` : ""}`);
      }
      rows.sort((a, b) => Number(b.match(/uid=(\d+)/)?.[1]) - Number(a.match(/uid=(\d+)/)?.[1]));
      return `「${folder}」共 ${uids.length} 封符合条件，显示最新 ${rows.length} 封：\n${rows.join("\n")}`;
    } finally {
      lock.release();
    }
  });
}

function countAttachments(node: unknown): number {
  const n = node as { disposition?: string; childNodes?: unknown[] } | undefined;
  if (!n) return 0;
  const self = n.disposition === "attachment" ? 1 : 0;
  return self + (n.childNodes ?? []).reduce<number>((sum, child) => sum + countAttachments(child), 0);
}

async function fetchParsed(config: MailConfig, uid: number, folder: string) {
  return withImap(config, async (client) => {
    const lock = await client.getMailboxLock(folder);
    try {
      const msg = await client.fetchOne(String(uid), { source: true, uid: true }, { uid: true });
      if (!msg || !msg.source) throw new Error(`「${folder}」里找不到 uid=${uid} 的邮件`);
      return simpleParser(msg.source);
    } finally {
      lock.release();
    }
  });
}

async function read(config: MailConfig, args: Record<string, unknown>): Promise<string> {
  const uid = Number(args.uid);
  if (!uid) throw new Error("缺少 uid");
  const folder = typeof args.folder === "string" && args.folder ? args.folder : "INBOX";
  const mail = await fetchParsed(config, uid, folder);
  let body = mail.text?.trim() || (typeof mail.html === "string" ? htmlToText(mail.html) : "");
  if (body.length > MAX_BODY_CHARS) body = `${body.slice(0, MAX_BODY_CHARS)}\n…（正文过长，已截断）`;
  const attachments = mail.attachments.map((a, i) => `${i + 1}. ${a.filename || "（未命名）"}（${a.contentType}，${Math.ceil(a.size / 1024)} KB）`);
  return [
    `主题：${mail.subject ?? "（无主题）"}`,
    `发件人：${addressText(mail.from)}`,
    `收件人：${addressText(mail.to)}`,
    ...(mail.cc ? [`抄送：${addressText(mail.cc)}`] : []),
    `时间：${mail.date ? mail.date.toLocaleString("zh-CN", { hour12: false }) : ""}`,
    "",
    body || "（没有正文）",
    ...(attachments.length ? ["", "附件：", ...attachments] : []),
  ].join("\n");
}

async function saveAttachment(config: MailConfig, args: Record<string, unknown>): Promise<string> {
  const uid = Number(args.uid);
  const saveDir = typeof args.saveDir === "string" ? args.saveDir : "";
  if (!uid || !saveDir || !isAbsolute(saveDir)) throw new Error("需要 uid 和保存目录（绝对路径）");
  const folder = typeof args.folder === "string" && args.folder ? args.folder : "INBOX";
  const mail = await fetchParsed(config, uid, folder);
  const index = Number(args.index) || 0;
  const targets = index ? [mail.attachments[index - 1]].filter(Boolean) : mail.attachments;
  if (targets.length === 0) throw new Error(index ? `没有第 ${index} 个附件` : "这封邮件没有附件");
  await mkdir(saveDir, { recursive: true });
  const saved: string[] = [];
  for (const [i, att] of targets.entries()) {
    // 文件名去掉路径成分，防止附件名里带 ../ 写到别处
    const name = basename(att.filename || `附件${index || i + 1}`).replace(/[\\/:*?"<>|]/g, "_");
    const path = join(saveDir, name);
    await writeFile(path, att.content);
    saved.push(path);
  }
  return `已保存 ${saved.length} 个附件：\n${saved.map((p) => `- ${p}`).join("\n")}`;
}

async function send(config: MailConfig, args: Record<string, unknown>): Promise<string> {
  const to = recipients(args.to);
  if (!to) throw new Error("缺少收件人");
  if (!config.smtpHost) throw new Error("没有配置 SMTP 服务器，不能发信");
  const attachmentPaths = Array.isArray(args.attachments) ? args.attachments.filter((p): p is string => typeof p === "string") : [];
  const attachments = await Promise.all(attachmentPaths.map(async (p) => {
    if (!isAbsolute(p)) throw new Error(`附件路径必须是绝对路径：${p}`);
    return { filename: basename(p), content: await readFile(p) };
  }));
  const message: Record<string, unknown> = {
    from: config.user,
    to,
    cc: recipients(args.cc),
    bcc: recipients(args.bcc),
    subject: typeof args.subject === "string" ? args.subject : "",
    text: typeof args.text === "string" ? args.text : "",
    ...(typeof args.html === "string" && args.html ? { html: args.html } : {}),
    attachments,
  };
  if (args.replyToUid) {
    const original = await fetchParsed(config, Number(args.replyToUid), typeof args.replyFolder === "string" && args.replyFolder ? args.replyFolder : "INBOX");
    if (original.messageId) {
      message.inReplyTo = original.messageId;
      message.references = [...(Array.isArray(original.references) ? original.references : original.references ? [original.references] : []), original.messageId];
    }
  }
  const transporter = nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpPort === 465,
    auth: { user: config.user, pass: config.password },
  });
  const info = await transporter.sendMail(message);
  // QQ / 163 等用 SMTP 发出的信不会自动进「已发送」：补存一份，用户在网页版也能看到
  let sentNote = "";
  try {
    const raw = await new MailComposer(message).compile().build();
    await withImap(config, async (client) => {
      const sent = (await client.list()).find((b) => b.specialUse === "\\Sent");
      if (sent) await client.append(sent.path, raw, ["\\Seen"]);
    });
  } catch {
    sentNote = "（已发出，但没能存到「已发送」文件夹）";
  }
  return `邮件已发送给 ${to}${sentNote}。Message-ID: ${info.messageId}`;
}

/** 测试连接：真的登录一次 IMAP（列工具不能说明授权码是对的） */
export async function verifyMail(env: Record<string, string>): Promise<void> {
  const config = readConfig(env);
  try {
    await withImap(config, async (client) => { await client.list(); });
  } catch (err) {
    throw new Error(explain(err));
  }
}

export function createMailServer(env: Record<string, string>): Server {
  const config = readConfig(env);
  const server = new Server({ name: "axon-mail", version: "1.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    try {
      let text: string;
      switch (request.params.name) {
        case "mail_list_folders": text = await listFolders(config); break;
        case "mail_search": text = await search(config, args); break;
        case "mail_read": text = await read(config, args); break;
        case "mail_save_attachment": text = await saveAttachment(config, args); break;
        case "mail_send": text = await send(config, args); break;
        default: return { content: [{ type: "text", text: `未知工具：${request.params.name}` }], isError: true };
      }
      return { content: [{ type: "text", text }] };
    } catch (err) {
      return { content: [{ type: "text", text: explain(err) }], isError: true };
    }
  });
  return server;
}

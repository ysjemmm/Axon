/**
 * 远程 MCP 的 OAuth 授权（连接器「一键连接」）。
 *
 * 走 MCP 标准授权：服务端返回 401 → 发现授权服务器 → 动态注册客户端（Axon 不用去每家申请应用）
 * → 浏览器授权（PKCE）→ 换取令牌；之后令牌过期由 SDK 自动用 refresh token 续期。
 * 协议细节都在官方 SDK 的 auth() 里，这里只负责三件事：
 *   · 凭据存放：~/.axon/secrets/connector-oauth.json（仅本人可读），按连接器 id 分开
 *   · 回调：本机临时起一个 127.0.0.1 的小服务接授权码（RFC 8252 的回环重定向）
 *   · 区分前台 / 后台：只有用户点「连接」时才打开浏览器；后台连接发现需要重新授权时直接报错，
 *     界面提示用户重新连接，绝不在后台突然弹出授权页
 */

import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { auth, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";

interface StoredEntry {
  client?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  /** 拿到令牌的时刻：配合 expires_in 判断是否快过期（展示用，续期由 SDK 负责） */
  tokensAt?: number;
  codeVerifier?: string;
  /** 注册客户端时用的回调端口：动态注册的 redirect_uri 带端口，之后要用同一个 */
  port?: number;
  /** 授权的服务地址：换了地址就不能沿用旧凭据 */
  serverUrl?: string;
}

/** 后台连接发现需要用户重新授权 */
export class OAuthReauthRequired extends Error {
  constructor() {
    super("需要重新授权：请在「连接器」里点「连接」，在浏览器里完成授权");
    this.name = "OAuthReauthRequired";
  }
}

export class OAuthCredentialStore {
  private data: Record<string, StoredEntry>;

  constructor(private readonly path: string = join(homedir(), ".axon", "secrets", "connector-oauth.json")) {
    try {
      this.data = JSON.parse(readFileSync(path, "utf8")) as Record<string, StoredEntry>;
    } catch {
      this.data = {};
    }
  }

  get(key: string): StoredEntry {
    return this.data[key] ?? {};
  }

  update(key: string, patch: Partial<StoredEntry>): void {
    this.data[key] = { ...this.get(key), ...patch };
    this.flush();
  }

  remove(key: string): void {
    delete this.data[key];
    this.flush();
  }

  private flush(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      writeFileSync(this.path, JSON.stringify(this.data, null, 2), { mode: 0o600 });
      chmodSync(this.path, 0o600);
    } catch (err) {
      console.warn("[mcp-oauth] 保存授权凭据失败:", (err as Error).message);
    }
  }
}

/** SDK 要的 provider：凭据读写走存储；interactive=false 时需要跳转授权就抛 OAuthReauthRequired */
export class StoredOAuthProvider implements OAuthClientProvider {
  private stateValue = randomBytes(16).toString("hex");

  constructor(
    private readonly store: OAuthCredentialStore,
    private readonly key: string,
    private readonly redirect: string | undefined,
    private readonly onRedirect?: (url: URL) => void,
  ) {}

  get redirectUrl(): string | undefined {
    return this.redirect ?? (this.store.get(this.key).port ? `http://127.0.0.1:${this.store.get(this.key).port}/callback` : undefined);
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Axon",
      redirect_uris: this.redirectUrl ? [this.redirectUrl] : [],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  state(): string {
    return this.stateValue;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.store.get(this.key).client;
  }

  saveClientInformation(info: OAuthClientInformationMixed): void {
    this.store.update(this.key, { client: info });
  }

  tokens(): OAuthTokens | undefined {
    return this.store.get(this.key).tokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    this.store.update(this.key, { tokens, tokensAt: Date.now() });
  }

  redirectToAuthorization(url: URL): void {
    if (!this.onRedirect) throw new OAuthReauthRequired();
    this.onRedirect(url);
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.store.update(this.key, { codeVerifier });
  }

  codeVerifier(): string {
    const v = this.store.get(this.key).codeVerifier;
    if (!v) throw new Error("缺少 PKCE code verifier，请重新连接");
    return v;
  }

  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
    if (scope === "all") this.store.remove(this.key);
    else if (scope === "client") this.store.update(this.key, { client: undefined, tokens: undefined });
    else if (scope === "tokens") this.store.update(this.key, { tokens: undefined });
    else if (scope === "verifier") this.store.update(this.key, { codeVerifier: undefined });
  }
}

/** 授权完成页（回调服务返回给浏览器的） */
function resultPage(ok: boolean, message: string): string {
  const color = ok ? "#16a34a" : "#dc2626";
  return `<!doctype html><html><head><meta charset="utf-8"><title>Axon</title></head><body style="font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#fafafa"><div style="text-align:center"><div style="font-size:40px;color:${color}">${ok ? "✓" : "✕"}</div><h2 style="margin:12px 0 6px">${ok ? "授权完成" : "授权没有完成"}</h2><p style="color:#666">${message}</p></div></body></html>`;
}

/** 在 127.0.0.1 上起回调服务；port 被占用时返回 null */
function listen(port: number): Promise<{ server: Server; port: number } | null> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(null));
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ server, port: typeof addr === "object" && addr ? addr.port : port });
    });
  });
}

/** 授权等待上限：用户去浏览器里登录、选工作区，给足 5 分钟 */
const AUTHORIZE_TIMEOUT_MS = 5 * 60_000;

/**
 * 交互式授权：打开浏览器 → 等回调 → 换令牌。已有有效令牌（或能续期）时直接返回，不打开浏览器。
 * openUrl 由调用方决定怎么打开（扩展里用 VS Code 打开外部链接，Web 里由页面打开）。
 */
export async function authorizeInteractive(opts: {
  store: OAuthCredentialStore;
  key: string;
  serverUrl: string;
  openUrl: (url: string) => void;
  signal?: AbortSignal;
}): Promise<void> {
  const { store, key, serverUrl, openUrl, signal } = opts;
  // 服务地址变了：旧凭据作废
  if (store.get(key).serverUrl && store.get(key).serverUrl !== serverUrl) store.remove(key);
  store.update(key, { serverUrl });

  // 回调端口：沿用注册时的端口；被占用就换一个，并丢掉旧的客户端注册（它绑定的是旧端口）
  let bound = store.get(key).port ? await listen(store.get(key).port!) : null;
  if (!bound) {
    if (store.get(key).port) store.update(key, { client: undefined, tokens: undefined });
    bound = await listen(0);
    if (!bound) throw new Error("无法在本机启动授权回调服务");
    store.update(key, { port: bound.port });
  }
  const { server, port } = bound;
  const redirect = `http://127.0.0.1:${port}/callback`;

  try {
    let opened = false;
    const provider = new StoredOAuthProvider(store, key, redirect, (url) => { opened = true; openUrl(url.toString()); });
    const codePromise = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("等待授权超时（5 分钟），请重试")), AUTHORIZE_TIMEOUT_MS);
      signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("已取消授权")); }, { once: true });
      server.on("request", (req, res) => {
        const url = new URL(req.url ?? "/", redirect);
        if (url.pathname !== "/callback") { res.writeHead(404).end(); return; }
        const error = url.searchParams.get("error");
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        if (error || !code) {
          res.end(resultPage(false, error === "access_denied" ? "你拒绝了授权，可以关闭这个页面。" : `服务方返回：${error ?? "没有授权码"}`));
          clearTimeout(timer);
          reject(new Error(error === "access_denied" ? "你拒绝了授权" : `授权失败：${error ?? "没有收到授权码"}`));
          return;
        }
        if (state !== provider.state()) {
          res.end(resultPage(false, "授权回调校验失败，请回到 Axon 重试。"));
          return;
        }
        res.end(resultPage(true, "可以关闭这个页面，回到 Axon 继续。"));
        clearTimeout(timer);
        resolve(code);
      });
    });
    codePromise.catch(() => undefined);

    const first = await auth(provider, { serverUrl });
    if (first === "AUTHORIZED" && !opened) return;
    const code = await codePromise;
    const second = await auth(provider, { serverUrl, authorizationCode: code });
    if (second !== "AUTHORIZED") throw new Error("授权没有完成，请重试");
  } finally {
    server.close();
  }
}

/** 连接状态（界面用）：有没有令牌、什么时候过期（有 refresh token 时过期也能自动续） */
export function oauthStatus(store: OAuthCredentialStore, key: string): { connected: boolean; expiresAt?: number; refreshable: boolean } {
  const entry = store.get(key);
  if (!entry.tokens?.access_token) return { connected: false, refreshable: false };
  const expiresAt = entry.tokens.expires_in && entry.tokensAt ? entry.tokensAt + entry.tokens.expires_in * 1000 : undefined;
  return { connected: true, expiresAt, refreshable: !!entry.tokens.refresh_token };
}

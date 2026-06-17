/**
 * 访问鉴权 - Server 形态的最小防护。
 *
 * 背景：Axon 是 Server + Web 形态，agent 能执行任意命令、读写工作区文件。
 * 一旦端口对外可达且无鉴权，等同于远程任意命令执行。这里提供一层可选的
 * token 鉴权，覆盖 HTTP 与 WebSocket 两个入口。
 *
 * 配置（环境变量）：
 * - AXON_AUTH_TOKEN：设置后强制校验。HTTP 走 Authorization: Bearer <token> 或 ?token=
 *   WS 走握手 URL 的 ?token= 查询参数。
 * - 未设置时：仅当 BIND_HOST 为非回环地址时打印高危警告（默认仍放行，便于本机开发）。
 */

import type { Request, Response, NextFunction, RequestHandler } from "express";
import type { IncomingMessage } from "node:http";

/** 读取配置的鉴权 token（未配置返回空串） */
export function getAuthToken(): string {
  return (process.env.AXON_AUTH_TOKEN || "").trim();
}

/** 是否启用了鉴权 */
export function authEnabled(): boolean {
  return getAuthToken().length > 0;
}

/** 从请求里提取 token：优先 Authorization: Bearer，其次 ?token= 查询参数 */
function extractHttpToken(req: Request): string {
  const header = req.headers["authorization"];
  if (typeof header === "string" && header.startsWith("Bearer ")) {
    return header.slice("Bearer ".length).trim();
  }
  const q = req.query.token;
  return typeof q === "string" ? q : "";
}

/**
 * Express 鉴权中间件。未配置 token 时直接放行（本机开发友好）；
 * 配置后校验失败返回 401。/health 始终放行（供探活）。
 */
export function httpAuthMiddleware(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!authEnabled()) return next();
    if (req.path === "/health") return next();
    if (extractHttpToken(req) === getAuthToken()) return next();
    res.status(401).json({ error: "未授权：缺少或错误的访问 token" });
  };
}

/** 校验 WebSocket 握手请求的 token（从握手 URL 的 ?token= 取） */
export function verifyWsToken(req: IncomingMessage): boolean {
  if (!authEnabled()) return true;
  try {
    const url = new URL(req.url || "", "http://localhost");
    return url.searchParams.get("token") === getAuthToken();
  } catch {
    return false;
  }
}

/** 返回服务监听的主机地址：默认仅回环（127.0.0.1），显式设置 BIND_HOST 才对外 */
export function bindHost(): string {
  return (process.env.BIND_HOST || "127.0.0.1").trim();
}

/** 判断地址是否为回环（本机）地址 */
export function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

/** 启动时打印安全态势提示：对外暴露却没鉴权属于高危 */
export function logSecurityPosture(host: string): void {
  if (!isLoopback(host) && !authEnabled()) {
    console.warn(
      `⚠️  [安全] 服务绑定到非回环地址 ${host} 但未设置 AXON_AUTH_TOKEN。` +
      `agent 可执行任意命令，等同于对外开放远程命令执行风险。` +
      `请设置 AXON_AUTH_TOKEN 启用鉴权，或将 BIND_HOST 改回 127.0.0.1。`,
    );
  } else if (authEnabled()) {
    console.log(`🔒 [安全] 已启用 token 鉴权（HTTP + WS）`);
  }
}

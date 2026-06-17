/**
 * API 基础地址配置 - 统一管理后端连接地址
 *
 * 规则：
 * - 优先读 Vite 环境变量 VITE_API_PORT（可在 .env 中配置）
 * - 默认端口 3001
 * - protocol 和 hostname 从当前页面 URL 动态获取（支持 localhost / IP / 域名）
 * - WS 协议跟随 HTTP：https → wss，http → ws
 */

const API_PORT = import.meta.env.VITE_API_PORT || "3001";

/** HTTP API 基础地址，如 "http://localhost:3001" */
export const API_BASE = `${window.location.protocol}//${window.location.hostname}:${API_PORT}`;

/** WebSocket 基础地址，如 "ws://localhost:3001" */
export const WS_BASE = `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.hostname}:${API_PORT}`;

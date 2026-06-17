/**
 * 会话编排层出口。
 *
 * SessionHub 把会话生命周期与具体传输解耦：各形态（server WsChannel / VS Code 进程内）
 * 只需注入 SessionHubDeps，并把入站消息翻译成 ControlCommand 交给 hub.dispatch。
 */

export * from "./types.js";
export { SessionHub } from "./sessionHub.js";

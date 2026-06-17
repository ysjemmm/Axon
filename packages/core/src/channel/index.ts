/**
 * AgentChannel —— 呈现端抽象（两层抽象之 ②）
 *
 * Agent 的“嘴和耳”：决定“事件往哪送、控制指令从哪来”。
 * @axon/core 只面向这个接口收发，绝不直接 import ws / vscode。
 *
 * 三种适配实现（均在各自 app/adapter 内，不在 core）：
 *   · WsChannel       —— ws.send / ws.on("message")（web 形态，协议零改动）
 *   · VSCodeChannel   —— webview.postMessage / onDidReceiveMessage（Code OSS 进程内形态）
 *   · CliChannel      —— stdout / stdin（终端形态）
 */

export * from "./events.js";
export * from "./commands.js";

import type { AgentEvent } from "./events.js";

/**
 * 出站通道：Agent 把事件推给 UI。
 * AgentSession 内部原本的 this.send(type, data) 改为 this.channel.emit({ type, ...data })。
 */
export interface AgentChannel {
  /** 推送一个事件到 UI。实现负责序列化与传输；连接不可用时应静默丢弃，不抛错打断 agent loop */
  emit(event: AgentEvent): void;
}

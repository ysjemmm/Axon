/**
 * WsChannel —— AgentChannel 的 WebSocket 适配实现（web 形态）
 *
 * @axon/core 的 AgentSession / SessionHub 只面向 AgentChannel 收发，
 * 由本类把出站 AgentEvent 序列化为 JSON 并通过 ws.send 推给前端。
 * 协议零改动：事件结构与原 index.ts 直接 ws.send(JSON.stringify({type,...})) 完全一致。
 */

import type { AgentChannel, AgentEvent } from "@axon/core";
import { WebSocket } from "ws";

export class WsChannel implements AgentChannel {
  constructor(private ws: WebSocket) {}

  /** 推送事件到前端；连接未就绪时静默丢弃，不打断 agent loop */
  emit(event: AgentEvent): void {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(event));
    }
  }
}

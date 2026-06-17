import { useCallback, useEffect, useRef, useState } from "react";
import { createAgentConnection, type AgentConnection } from "../lib/transport";

export interface WsMessage {
  type: string;
  content?: string;
  name?: string;
  args?: Record<string, unknown>;
  result?: string;
  used?: number;
  max?: number;
}

type MessageHandler = (msg: WsMessage) => void;

/**
 * Agent 连接 Hook（形态无关）。
 *
 * 底层通过 transport.createAgentConnection 适配：
 *  - 浏览器：WebSocket（含自动重连）
 *  - VS Code webview：postMessage（恒连接）
 *
 * 公开签名保持 { connected, send } 不变，调用方（ChatPanel）无需改动。
 * url 参数保留以兼容旧调用，但实际连接地址由 transport 决定（webview 下忽略）。
 */
export function useWebSocket(_url: string, onMessage: MessageHandler) {
  const connRef = useRef<AgentConnection | null>(null);
  const [connected, setConnected] = useState(false);
  const onMessageRef = useRef<MessageHandler>(onMessage);

  useEffect(() => {
    onMessageRef.current = onMessage;
  }, [onMessage]);

  useEffect(() => {
    const conn = createAgentConnection();
    connRef.current = conn;
    conn.onConnectedChange(setConnected);
    const unsubscribe = conn.subscribe((msg) => {
      onMessageRef.current(msg as unknown as WsMessage);
    });
    return () => {
      unsubscribe();
      conn.close();
      connRef.current = null;
    };
  }, []);

  const send = useCallback((data: Record<string, unknown>) => {
    connRef.current?.send(data);
  }, []);

  return { connected, send };
}

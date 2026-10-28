/**
 * Cowork 流程的增删查与 AI 草稿。走会话通道（sessionHub 的 cowork_* 指令），
 * IDE 扩展和独立 server 用同一套，不需要各写一份 HTTP 接口。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useSessionEvents } from "@/hooks/useSessionEvents";
import type { WsMessage } from "@/hooks/useWebSocket";
import type { CoworkFlow, CoworkFlowDraft } from "./flowTypes";

type Pending<T> = { resolve: (value: T) => void; reject: (error: Error) => void };

const newRequestId = (kind: string) => `cowork-${kind}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

export function useCoworkFlows({ clientId, connected, send }: { clientId: string; connected: boolean; send: (cmd: Record<string, unknown>) => void }) {
  const [flows, setFlows] = useState<CoworkFlow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const pendingSaves = useRef(new Map<string, Pending<CoworkFlow>>());
  const pendingDrafts = useRef(new Map<string, Pending<CoworkFlowDraft>>());

  useEffect(() => {
    if (connected) send({ type: "cowork_list_flows", clientId });
  }, [clientId, connected, send]);

  useSessionEvents(clientId, (msg: WsMessage) => {
    const m = msg as WsMessage & { flows?: CoworkFlow[]; flow?: CoworkFlow; draft?: CoworkFlowDraft; requestId?: string; error?: string };
    if (m.type === "cowork_flows") {
      setFlows(Array.isArray(m.flows) ? m.flows : []);
      setLoaded(true);
    } else if (m.type === "cowork_flow_saved" && m.requestId) {
      const pending = pendingSaves.current.get(m.requestId);
      pendingSaves.current.delete(m.requestId);
      if (m.flow) pending?.resolve(m.flow);
      else pending?.reject(new Error(m.error || "保存失败"));
    } else if (m.type === "cowork_flow_draft" && m.requestId) {
      const pending = pendingDrafts.current.get(m.requestId);
      pendingDrafts.current.delete(m.requestId);
      if (m.draft) pending?.resolve(m.draft);
      else pending?.reject(new Error(m.error || "整理流程失败"));
    }
  });

  const save = useCallback((flow: CoworkFlowDraft) => new Promise<CoworkFlow>((resolve, reject) => {
    if (!connected) { reject(new Error("还没连上服务，请稍后再试")); return; }
    const requestId = newRequestId("save");
    pendingSaves.current.set(requestId, { resolve, reject });
    send({ type: "cowork_save_flow", clientId, requestId, flow });
  }), [clientId, connected, send]);

  const remove = useCallback((id: string) => {
    send({ type: "cowork_delete_flow", clientId, id });
  }, [clientId, send]);

  /** 让 AI 把一个做完的任务整理成流程草稿 */
  const draftFromSession = useCallback((sessionId: string) => new Promise<CoworkFlowDraft>((resolve, reject) => {
    if (!connected) { reject(new Error("还没连上服务，请稍后再试")); return; }
    const requestId = newRequestId("draft");
    pendingDrafts.current.set(requestId, { resolve, reject });
    send({ type: "cowork_draft_flow", clientId, requestId, sessionId });
  }), [clientId, connected, send]);

  return { flows, loaded, save, remove, draftFromSession };
}

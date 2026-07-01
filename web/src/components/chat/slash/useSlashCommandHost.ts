/**
 * 斜杠命令宿主能力实现 —— 把 {@link SlashCommandHost} 接口落到 VS Code 扩展宿主 + MentionEditor。
 *
 * 通道复用既有基建：
 *  - 出站：window.__axonVSCode.postMessage（与 open_file 同一条直连通道）
 *  - 入站：sessionEventBus（扩展 postToWebview 的消息按 clientId 路由回本面板）
 *
 * 资源搜索是请求/响应式（requestId 配对）。注入上下文时：先在编辑器光标处插入一个“加载中”的
 * 占位 tag（拿到 contextId），再请求扩展读取内容；扩展回灌的 add_context 带回 contextId，
 * 由 ChatPanel 用 updateTag 补全该 tag 的名称与内容（见 ChatPanel 的 add_context 处理）。
 */

import { useCallback, useMemo, useRef } from "react";
import { useSessionEvents } from "@/hooks/useSessionEvents";
import type { ResourceItem, ResourceScope, SlashCommandHost } from "./types";
import type { MentionEditorHandle } from "../MentionEditor";

interface VSCodeApiLike {
  postMessage(msg: unknown): void;
}

function getHost(): VSCodeApiLike | null {
  return (window as unknown as { __axonVSCode?: VSCodeApiLike }).__axonVSCode ?? null;
}

export function useSlashCommandHost(
  clientId: string,
  editorRef: React.RefObject<MentionEditorHandle | null>,
): SlashCommandHost {
  const pending = useRef(new Map<string, (items: ResourceItem[]) => void>());

  useSessionEvents(
    clientId,
    useCallback((msg) => {
      if ((msg as { type?: string }).type !== "resource_results") return;
      const requestId = (msg as { requestId?: string }).requestId;
      if (!requestId) return;
      const resolve = pending.current.get(requestId);
      if (!resolve) return;
      pending.current.delete(requestId);
      resolve((msg as { items?: ResourceItem[] }).items ?? []);
    }, []),
  );

  const searchResources = useCallback(
    (query: string, scope: ResourceScope) =>
      new Promise<ResourceItem[]>((resolve) => {
        const host = getHost();
        if (!host) {
          resolve([]);
          return;
        }
        const requestId = `res-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        pending.current.set(requestId, resolve);
        host.postMessage({ type: "search_resources", clientId, requestId, query, scope });
        window.setTimeout(() => {
          if (pending.current.has(requestId)) {
            pending.current.delete(requestId);
            resolve([]);
          }
        }, 5000);
      }),
    [clientId],
  );

  const addActiveFileContext = useCallback(() => {
    const cid = editorRef.current?.insertTag({ name: "当前文件", content: "加载中…", size: 0, kind: "file" });
    if (cid) getHost()?.postMessage({ type: "add_active_file_context", clientId, contextId: cid });
  }, [clientId, editorRef]);

  const addResourceContext = useCallback(
    (item: ResourceItem) => {
      const cid = editorRef.current?.insertTag({ name: item.path, content: "加载中…", size: 0, kind: item.kind });
      if (cid) getHost()?.postMessage({ type: "add_resource_context", clientId, contextId: cid, path: item.path, kind: item.kind });
    },
    [clientId, editorRef],
  );

  const addDiagnosticsContext = useCallback(() => {
    const cid = editorRef.current?.insertTag({ name: "问题", content: "加载中…", size: 0, kind: "diagnostics" });
    if (cid) getHost()?.postMessage({ type: "add_diagnostics_context", clientId, contextId: cid });
  }, [clientId, editorRef]);

  return useMemo(
    () => ({ searchResources, addActiveFileContext, addResourceContext, addDiagnosticsContext }),
    [searchResources, addActiveFileContext, addResourceContext, addDiagnosticsContext],
  );
}

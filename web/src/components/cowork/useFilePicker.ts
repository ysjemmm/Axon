/**
 * 通过宿主原生对话框选文件 / 文件夹。
 *
 * ⚠️ 必须走原生对话框：webview 的 <input type="file"> 和拖放都拿不到本地绝对路径，
 * 而 Agent 要用 openpyxl / pdfplumber 直接读这些二进制文件。
 * 每次请求带 requestId，回调按 id 分发，所以一个页面上多个「选择文件」按钮（流程的各个输入槽）互不串。
 */

import { useCallback, useRef } from "react";
import { useSessionEvents } from "@/hooks/useSessionEvents";
import type { WsMessage } from "@/hooks/useWebSocket";
import type { PickedFile } from "./flowPrompt";

export interface PickedFileInfo extends PickedFile {
  size: number;
}

type HostApi = { postMessage: (m: unknown) => void };
const hostApi = () => (window as unknown as { __axonVSCode?: HostApi }).__axonVSCode;

export function useFilePicker(clientId: string) {
  const fileCallbacks = useRef(new Map<string, (files: PickedFileInfo[]) => void>());
  const dirCallbacks = useRef(new Map<string, (path: string | undefined, error?: string) => void>());

  useSessionEvents(clientId, (msg: WsMessage) => {
    const m = msg as WsMessage & { requestId?: string; files?: PickedFileInfo[]; path?: string; error?: string };
    if (!m.requestId) return;
    if (m.type === "cowork_files_picked") {
      const cb = fileCallbacks.current.get(m.requestId);
      fileCallbacks.current.delete(m.requestId);
      cb?.(m.files || []);
    } else if (m.type === "cowork_output_dir_picked") {
      const cb = dirCallbacks.current.get(m.requestId);
      dirCallbacks.current.delete(m.requestId);
      cb?.(m.path, m.error);
    }
  });

  /** 返回 false 表示当前环境没有原生对话框（纯浏览器），调用方给出提示 */
  const pickFiles = useCallback((onPicked: (files: PickedFileInfo[]) => void): boolean => {
    const host = hostApi();
    if (!host) return false;
    const requestId = `cowork-pick-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    fileCallbacks.current.set(requestId, onPicked);
    host.postMessage({ type: "cowork_pick_files", clientId, requestId });
    return true;
  }, [clientId]);

  const pickDir = useCallback((initialPath: string, onPicked: (path: string | undefined, error?: string) => void): boolean => {
    const host = hostApi();
    if (!host) return false;
    const requestId = `cowork-output-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    dirCallbacks.current.set(requestId, onPicked);
    host.postMessage({ type: "cowork_pick_output_dir", clientId, requestId, initialPath });
    return true;
  }, [clientId]);

  return { pickFiles, pickDir };
}

/** 合并新选的文件，按路径去重 */
export function mergeFiles<T extends { path: string }>(prev: T[], added: T[]): T[] {
  const seen = new Set(prev.map((f) => f.path));
  return [...prev, ...added.filter((f) => !seen.has(f.path) && seen.add(f.path))];
}

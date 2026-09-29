/**
 * 打开原生 diff 视图 —— 所有"查看改动"按钮的统一入口。
 *
 * ── 为什么需要它 ──
 * 会话快照（session_loaded）不再携带改动前后全文，只带路径与 editId（见 core 的 slimDiffBodies）：
 * 那些全文占了快照体积的约 60%，而只有"点开 diff"这一下才用得到。
 * 于是打开 diff 分两种情况：
 *   · 手上已有正文（本次会话里刚发生的改动，tool_result 实时下发时带着全文）→ 直接打开
 *   · 正文被省略（从快照恢复的历史改动，bodyOmitted）→ 先向后端要，拿到再打开
 * 各处按钮不必关心自己属于哪种，统一调这里。
 *
 * 应答走 sessionEventBus 的全局监听（在总线分发前截获，不经过任何面板的事件处理）。
 */

import { createContext, useContext } from "react";
import { sessionEventBus } from "@/hooks/useSessionEvents";

/**
 * 所在面板的 clientId。后端靠它定位会话去取 diff 正文。
 * 由 ChatPanel 在最外层提供；卡片、改动面板等深层组件直接取，不必层层传参。
 */
export const PanelClientIdContext = createContext<string | undefined>(undefined);

export function usePanelClientId(): string | undefined {
  return useContext(PanelClientIdContext);
}

interface VSCodeApiLike {
  postMessage(msg: unknown): void;
}

export interface DiffRef {
  /** 打开 diff 用的路径（工具卡片优先传绝对路径） */
  path: string;
  /** 编辑单元 id：同一文件多次改动时靠它精确定位 */
  editId?: string;
  oldContent?: string;
  newContent?: string;
  /** 正文没随快照下发，需要按需取 */
  bodyOmitted?: boolean;
}

const FETCH_TIMEOUT_MS = 5000;

function host(): VSCodeApiLike | null {
  return (window as unknown as { __axonVSCode?: VSCodeApiLike }).__axonVSCode ?? null;
}

const pending = new Map<string, (body: { oldContent: string; newContent: string } | null) => void>();

// 截获 diff_content 应答（只装一次）
sessionEventBus.intercept((msg) => {
  const m = msg as { type?: string; requestId?: string; found?: boolean; oldContent?: string; newContent?: string };
  if (m.type !== "diff_content" || !m.requestId) return false;
  const resolve = pending.get(m.requestId);
  if (resolve) {
    pending.delete(m.requestId);
    resolve(m.found ? { oldContent: m.oldContent ?? "", newContent: m.newContent ?? "" } : null);
  }
  return true;
});

/** 向后端取某次改动的正文；取不到（超时 / 已被压缩掉）返回 null */
export function fetchDiffBody(clientId: string | undefined, ref: { editId?: string; path?: string }):
  Promise<{ oldContent: string; newContent: string } | null> {
  const h = host();
  if (!h) return Promise.resolve(null);
  return new Promise((resolve) => {
    const requestId = `diff-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    pending.set(requestId, resolve);
    h.postMessage({ type: "get_diff_content", clientId, requestId, editId: ref.editId, path: ref.path });
    window.setTimeout(() => {
      if (!pending.has(requestId)) return;
      pending.delete(requestId);
      resolve(null);
    }, FETCH_TIMEOUT_MS);
  });
}

/** 是否需要先取正文 */
function needsFetch(d: DiffRef): boolean {
  return !!d.bodyOmitted && d.oldContent === undefined && d.newContent === undefined;
}

/**
 * 打开一次改动的 diff。
 * @param clientId 所在面板的 clientId（后端据此定位会话）
 */
export async function openDiff(clientId: string | undefined, d: DiffRef): Promise<void> {
  const h = host();
  if (!h) {
    console.log("[axon] open diff:", d.path);
    return;
  }
  let body: { oldContent?: string; newContent?: string } = d;
  if (needsFetch(d)) {
    const fetched = await fetchDiffBody(clientId, { editId: d.editId, path: d.path });
    if (!fetched) {
      // 正文已不可得（例如会话被压缩过）：退回打开文件本身，比什么都不发生好
      h.postMessage({ type: "open_file", path: d.path });
      return;
    }
    body = fetched;
  }
  h.postMessage({ type: "open_diff", path: d.path, oldContent: body.oldContent, newContent: body.newContent });
}

/**
 * 打开"多次改动合并"的 diff：取最早一次的 oldContent + 最近一次的 newContent。
 * 两端各自可能被省略，分别按需取。
 */
export async function openMergedDiff(clientId: string | undefined, path: string, first: DiffRef, last: DiffRef): Promise<void> {
  const h = host();
  if (!h) return;
  const [a, b] = await Promise.all([
    needsFetch(first) ? fetchDiffBody(clientId, first) : Promise.resolve(first as { oldContent?: string; newContent?: string }),
    needsFetch(last) ? fetchDiffBody(clientId, last) : Promise.resolve(last as { oldContent?: string; newContent?: string }),
  ]);
  if (!a || !b) {
    h.postMessage({ type: "open_file", path });
    return;
  }
  h.postMessage({ type: "open_diff", path, oldContent: a.oldContent, newContent: b.newContent });
}

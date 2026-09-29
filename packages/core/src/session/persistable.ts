/**
 * 持久化消息的过滤与净化
 *
 * ── 该剥什么 ──
 * 只剥「宿主/会话内存态」的暂存与回滚标记：它们随进程生灭，落盘没有意义。
 *
 * ⚠️ 但要知道：这类状态**并不以消息字段的形式存在**——待确认改动在宿主暂存区
 * （host/edits.ts 的 getPendingDiffs）、可撤销列表在 agentSession.getUndoablePaths()，
 * 两者都经 events 单独下发给 UI（events.ts 的 pending/diffs/undoable 字段），
 * 前端读的也是段级的 seg.pending / seg.reverted / seg.undoable。
 * 所以下面这份名单在当前消息结构下实际是**防御性**的：留着是为了防止将来有人把这类
 * 状态直接挂到消息上；它今天剥不到任何真实存在的字段（可用测试里的用例验证）。
 *
 * ── ⚠️⚠️ 绝不能剥什么 ──
 * fileDiff / fileDiffs **不是 UI 冗余，是工具调用的产出**：
 *   · 生产：tools/execute.ts 写在 tool meta 上 → events.ts 下发给 UI
 *   · 消费：前端刷新后重建工具卡片与改动面板的唯一来源
 *     （sessionHandlers.handleSessionLoaded：seg.diff = m.fileDiff、seg.diffs = m.fileDiffs）
 * 一旦剥离，刷新后编辑 / apply_patch / create_file 卡片拿不到 diff，会命中
 * 「无 diff ⇒ 判定该次调用失败」的隐藏判据（同一文件里的 seg.hidden = true），
 * 被 renderSegments 整段过滤掉——卡片直接消失，改动面板同样失去内容。
 *
 * 曾经把这两个字段列进过此表，代价就是上面这条：工具信息被当成 UI 冗余丢掉了。
 * 想缩小历史文件，该另找办法（比如对 diff 内容做增量压缩），不能靠删工具产出。
 */
const CHANGE_META_FIELDS = ["diffs", "pendingDiffs", "reverted", "undoable"] as const;

/**
 * 剥离单条消息上的改动记录字段。
 * 仅在字段存在时浅拷贝（不影响内存态原件），否则原样返回零拷贝。
 */
export function stripChangeMeta<T extends object>(message: T): T {
  const record = message as Record<string, unknown>;
  let clone: Record<string, unknown> | null = null;
  for (const field of CHANGE_META_FIELDS) {
    if (record[field] === undefined) continue;
    clone ??= { ...record };
    delete clone[field];
  }
  return (clone as T | null) ?? message;
}

/** 仅过滤瞬态/临时注入消息，不剥离字段（运行中事件下发用：本会话内存态的改动照常展示） */
export function filterTransientMessages<T extends object>(messages: T[]): T[] {
  return messages.filter((m) => {
    const record = m as Record<string, unknown>;
    return !record._transient && !record._ephemeralInjected;
  });
}

/** 落盘/读盘用：过滤瞬态消息，并剥离改动记录字段 */
export function filterPersistableMessages<T extends object>(messages: T[]): T[] {
  return filterTransientMessages(messages).map((m) => stripChangeMeta(m));
}

/** diff 的轻量描述：只留定位信息，去掉改动前后全文 */
interface DiffLike {
  path?: string;
  absPath?: string;
  editId?: string;
  oldContent?: string;
  newContent?: string;
  [k: string]: unknown;
}

function slimDiff(d: DiffLike): DiffLike {
  if (d.oldContent === undefined && d.newContent === undefined) return d;
  const { oldContent: _o, newContent: _n, ...rest } = d;
  // bodyOmitted：告诉前端正文没随快照下发，打开 diff 时要按 editId / 路径向后端取。
  // hadOldContent：卡片据"改动前是否有内容"区分 create_file 的「已覆盖 / 已创建」，正文省略后要保住这一位。
  return { ...rest, bodyOmitted: true, hadOldContent: !!d.oldContent };
}

/**
 * 会话快照下发给前端用：去掉 fileDiff / fileDiffs 里的改动前后全文，只留路径与 editId。
 *
 * ── 为什么 ──
 * 每次 str_replace 都会把"改动前 / 改动后"两份**整文件**全文记在 tool 消息上。
 * 同一个大文件改 20 次就是 40 份整文件副本。实测一个 536 条消息的会话，session_loaded
 * 载荷 10.7MB，其中 6.8MB（约 60%）就是这些全文——而前端只在"点击打开 diff"时才用得到它们，
 * 卡片本身只要路径就能渲染。切回一个被卸载的 tab 时，这 10.7MB 要序列化、跨进程投递、
 * 再在 webview 里解析，是"点了要等七八百毫秒才出内容"的大头。
 *
 * ⚠️ 只作用于下发给 UI 的快照，**不作用于落盘**：磁盘上仍保留完整 fileDiff
 * （刷新后卡片靠它的路径重建、打开 diff 时靠它的正文按需回填，见 findDiffBody）。
 * 也不能改回 stripChangeMeta 那种"整个字段剥掉"——那会让刷新后编辑卡片整张消失（踩过）。
 */
export function slimDiffBodies<T extends object>(messages: T[]): T[] {
  return messages.map((m) => {
    const r = m as Record<string, unknown>;
    const fd = r.fileDiff as DiffLike | undefined;
    const fds = r.fileDiffs as DiffLike[] | undefined;
    if (!fd && !fds) return m;
    return {
      ...r,
      ...(fd ? { fileDiff: slimDiff(fd) } : {}),
      ...(fds ? { fileDiffs: fds.map(slimDiff) } : {}),
    } as T;
  });
}

/**
 * 在完整消息里找回某次改动的正文（前端按需取 diff 时用）。
 * 优先按 editId 精确匹配（同一文件多次改动各不相同），找不到再按路径取最近一次。
 */
export function findDiffBody(
  messages: object[],
  query: { editId?: string; path?: string },
): { oldContent: string; newContent: string } | null {
  const hit = (d: DiffLike | undefined): boolean => {
    if (!d || (d.oldContent === undefined && d.newContent === undefined)) return false;
    if (query.editId) return d.editId === query.editId;
    return !!query.path && (d.path === query.path || d.absPath === query.path);
  };
  // 从后往前：按路径匹配时取最近一次改动
  for (let i = messages.length - 1; i >= 0; i--) {
    const r = messages[i] as Record<string, unknown>;
    const cands = [...((r.fileDiffs as DiffLike[] | undefined) ?? []), r.fileDiff as DiffLike | undefined];
    for (const d of cands) {
      if (hit(d)) return { oldContent: d!.oldContent ?? "", newContent: d!.newContent ?? "" };
    }
  }
  return null;
}

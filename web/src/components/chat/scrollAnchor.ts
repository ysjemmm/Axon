/**
 * 滚动锚定与可见窗口收敛的纯逻辑。
 *
 * 抽出来单独成文件，是因为这两条规则是"滚动体感"的全部判据，
 * 也最容易在改动中被悄悄破坏——放在纯函数里可以直接测。
 */

/**
 * 距底部多少像素以内视为"贴底"。
 *
 * 10px 而不是 0：浏览器滚动是亚像素的（尤其在高分屏 + 缩放），
 * 内容高度变化后 scrollTop 常有零点几像素的残差，按 0 判定会误判成"用户离开了底部"，
 * 于是正当贴底的场景反而不再跟随。
 */
export const BOTTOM_THRESHOLD_PX = 10;

/**
 * 是否贴底。
 * 注意 scrollHeight - scrollTop - clientHeight 在内容不足一屏时也可能为负（某些内核），
 * 所以用 <= threshold 判定，负值同样算贴底。
 */
export function isAtBottom(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
  threshold: number = BOTTOM_THRESHOLD_PX,
): boolean {
  return scrollHeight - scrollTop - clientHeight <= threshold;
}

/**
 * 计算"折叠较早消息"的数量。
 *
 * 现状问题（本次修复的根因之一）：原实现是 `Math.max(previous, len - limit)`，
 * 只增不减。上下文压缩会把 chatHistory 从几十条替换成几条，而这个计数仍停在旧的大值上，
 * 于是 `chatHistory.slice(hiddenMessageCount)` 直接切空 —— 对话区变成一片空白（白屏），
 * 并且滚动位置随之失控。这里用 `prevLen` 区分"增长"与"收缩"：
 *
 * - 增长（正常追加消息）：保留用户已展开的范围，只补充新需要折叠的部分
 *   （沿用原有"每轮结束后折叠较早消息"的意图）
 * - 收缩（压缩 / 编辑后消息变少）：直接跟随新的需要量，绝不保留陈旧的大值
 * - 任何情况下都至少留 1 条可见，避免整个列表被切空
 *
 * @param prev 上一次的折叠数量
 * @param prevLen 上一次的会话消息总数
 * @param len 当前的会话消息总数
 * @param limit 期望保留在窗口内的最近消息数
 */
export function nextHiddenCount(prev: number, prevLen: number, len: number, limit: number): number {
  const safePrev = Math.max(0, Math.floor(prev) || 0);
  const want = Math.max(0, len - limit);
  const base = len < prevLen ? want : Math.max(safePrev, want);
  return Math.min(base, Math.max(0, len - 1));
}

/**
 * 渲染期的安全钳制：把折叠数量限制在"至少留 1 条消息可见"的范围内。
 *
 * 为什么需要两道防线：上面的 nextHiddenCount 是异步的（在 effect 里跑，paint 之后才生效），
 * 而"内容被整体替换"（上下文压缩）会让当前这一帧就已经拿着陈旧的折叠数量去 slice——
 * 中间那一帧列表会被切空，也就是用户看到的白屏。这里在 slice 之前无条件钳一次，
 * 保证任何时刻都不会切空，窗口收敛随后由 nextHiddenCount 补齐。
 *
 * @param hidden 折叠数量（可能落后于实际消息数）
 * @param len 当前会话消息总数
 */
export function safeHiddenCount(hidden: number, len: number): number {
  const safeHidden = Math.max(0, Math.floor(hidden) || 0);
  return Math.min(safeHidden, Math.max(0, len - 1));
}

/**
 * 用户手势的有效窗口（ms）。滚轮 / 触控 / 键盘翻页 / 指针按下都会把窗口往后推，
 * 只有在这个窗口内读到的"不贴底"才被采信为"用户主动离开底部"。
 */
export const USER_GESTURE_WINDOW_MS = 400;

/**
 * 结算"是否继续跟随底部"。
 *
 * ⚠️ 翻转方向刻意不对称，这是本函数存在的全部理由：
 *   · 位置贴底            → 无条件恢复跟随（任何时候贴底都算贴底）
 *   · 位置不贴底 + 有用户手势 → 采信为用户主动离开底部，停止跟随
 *   · 位置不贴底 + 内容仍在变 → 视为测量/布局的中间态，保持原判断不变
 *   · 位置不贴底 + 内容已稳定 → 只可能是用户把视口移开了，停止跟随
 *
 * 为什么必须有"内容仍在变"那一条：消息区在流式输出、收尾、取消时会连续变化，虚拟列表每次重测量
 * 都会调整 scrollTop 以维持锚点，那期间读到的位置并不代表用户意图。
 * 早先的实现是"位置不贴底就停止跟随"，一次中间态就足以永久关掉跟随，
 * 滚动条于是停在那次中间态的位置上——用户看到的就是"点取消后滚动条突然漂到别处"。
 *
 * 为什么还要有"内容已稳定"那一条：拖动原生滚动条不会派发 pointer 事件，只有 scroll 事件，
 * 光靠手势会把它漏判成中间态，反而把用户拽回底部。内容稳定时没有"中间态"可言，
 * 此时不贴底就只可能是用户自己移开的。
 */
export function resolveAtBottom(input: {
  /** 本次读到的位置是否贴底 */
  positionAtBottom: boolean;
  /** 此刻是否处于用户手势窗口内 */
  hasUserGesture: boolean;
  /** 内容是否仍在变化（含刚变化完的一小段收敛期） */
  contentSettling: boolean;
  /** 上一次的跟随判断 */
  previous: boolean;
}): boolean {
  if (input.positionAtBottom) return true;
  if (input.hasUserGesture) return false;
  if (input.contentSettling) return input.previous;
  return false;
}

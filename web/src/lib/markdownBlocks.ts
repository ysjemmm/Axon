/**
 * markdownBlocks —— 把 markdown 源文切成「稳定块」，供增量渲染使用。
 *
 * ── 为什么需要它 ──
 * 现在每次流式更新都把**整段** markdown 重新解析成 HTML、再整段写进 DOM
 * （MarkdownRenderer 的写 html 那一步）。于是每一批新字到达，整条消息的 DOM 都被推平重建，
 * 回复完成那一刻的最后一次重写尤其明显 —— 用户看到的就是"白屏刷一下"。
 * 这是历史问题，不是某次改动引入的。
 *
 * 要做到"只追加、不重建"，前提是知道**哪一段源文已经不会再变**：
 * markdown 里一个块（段落 / 标题 / 列表 / 代码围栏……）一旦被**空行**闭合，
 * 后续追加的文字就不可能再改写它 —— 它的渲染结果是稳定的，可以缓存、可以不再重渲染。
 * 只有"最后那个还没被闭合的块"会随着新字到来而变化。
 *
 * ── closed 这个标记为什么关键 ──
 * 光有块切分不够：必须区分"已闭合"与"仍开着的最后一块"。
 * 已闭合 → 渲染一次就冻结；仍开着 → 每次重渲染。少了这个标记，
 * 增量渲染就退化成"要么全不更新、要么还是整段重建"。
 *
 * ── 围栏的处理 ──
 * 代码围栏（``` 或 ~~~）内部**不吃空行**：围栏里的空行属于代码内容，
 * 不能当作块分隔。所以围栏开着时一律继续累积，直到看到同类型的闭合围栏。
 * 未闭合的围栏（流式中常见）会一直落在最后一块里，因此它不会被判为 closed —— 这正是我们要的。
 */

export interface MarkdownBlock {
  /** 块的源文（不含分隔空行） */
  text: string;
  /**
   * 是否已被空行（或围栏闭合）终结。
   * true = 后续追加不会再改变它，可缓存渲染结果；
   * false = 仍在增长的最后一块，每次更新都要重渲染。
   */
  closed: boolean;
}

/**
 * 把 markdown 切成块。
 *
 * 返回的数组里，通常只有**最后一项**的 closed 为 false；前面都应为 true。
 * 若末尾恰好以空行结束，则最后一项也是 closed=true —— 此时整段都是稳定的，
 * 调用方可据此完全跳过重渲染。
 */
export function splitMarkdownBlocks(md: string): MarkdownBlock[] {
  if (!md) return [];

  const lines = md.split(/\r?\n/);
  const blocks: MarkdownBlock[] = [];
  let cur: string[] = [];
  /** 当前所处围栏的标记字符（` 或 ~）；null 表示不在围栏内 */
  let fence: string | null = null;

  const flush = (closed: boolean): void => {
    if (cur.length === 0) return;
    blocks.push({ text: cur.join("\n"), closed });
    cur = [];
  };

  for (const line of lines) {
    const fenceMark = line.match(/^\s*(`{3,}|~{3,})/);

    if (fenceMark) {
      const mark = fenceMark[1][0];
      if (fence === null) {
        fence = mark;
        cur.push(line);
        continue;
      }
      if (fence === mark) {
        // 闭合围栏：这一行属于块内容，且围栏一闭合，该块即告终结
        fence = null;
        cur.push(line);
        flush(true);
        continue;
      }
      // 非同类型围栏出现在围栏内：按内容处理（~~~ 里的 ``` 就是普通文本）
      cur.push(line);
      continue;
    }

    if (fence === null && line.trim() === "") {
      // 空行：仅当不在围栏内时才是块分隔
      flush(true);
      continue;
    }

    cur.push(line);
  }

  // 收尾：剩下的是"还没被空行闭合的最后一块"→ closed=false
  flush(false);
  return blocks;
}

/**
 * 前 n 个块是否都稳定（已闭合）。
 * 增量渲染用它决定"到第几块可以复用缓存"，省得调用方自己遍历。
 */
export function stableBlockCount(blocks: MarkdownBlock[]): number {
  let n = 0;
  for (const b of blocks) {
    if (!b.closed) break;
    n++;
  }
  return n;
}

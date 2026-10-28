/**
 * 会话记忆的兼容式结构化存储。
 *
 * 对外仍使用完整 Markdown 字符串，保证旧快照、导入导出和前端协议兼容；
 * 内部按二级标题拆成可独立 upsert/append/delete 的知识块，避免每次更新都重写整份记忆。
 */

export type MemorySection =
  | "project"
  | "workspace"
  | "decisions"
  | "preferences"
  | "status"
  | "pitfalls"
  | "todos"
  | "other";

export type MemoryUpdateAction = "upsert" | "append" | "delete";

export interface MemoryBlock {
  key: string;
  section: MemorySection;
  title: string;
  content: string;
}

export interface MemoryUpdate {
  action: MemoryUpdateAction;
  key: string;
  section?: MemorySection;
  title?: string;
  content?: string;
}

const SECTION_BY_TITLE: Record<string, MemorySection> = {
  "项目背景": "project",
  "项目结构": "project",
  "工作区理解": "workspace",
  "工作区": "workspace",
  "设计决策": "decisions",
  "已确认的设计约束": "decisions",
  "用户偏好": "preferences",
  "偏好与约束": "preferences",
  "当前状态": "status",
  "当前实现状态": "status",
  "踩坑与规避方式": "pitfalls",
  "踩坑": "pitfalls",
  "待办": "todos",
  "后续工作": "todos",
};

const SECTION_KEYS = new Set<MemorySection>([
  "project", "workspace", "decisions", "preferences", "status", "pitfalls", "todos", "other",
]);

function normalizeKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[`*_]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120) || "memory";
}

function sectionOf(title: string): MemorySection {
  return SECTION_BY_TITLE[title.trim()] || "other";
}

/** 把旧版 Markdown 按二级标题解析为块；没有标题的内容保留成一个 other 块。 */
export function parseMemoryMarkdown(markdown: string): MemoryBlock[] {
  const source = String(markdown || "").replace(/\r\n/g, "\n").trim();
  if (!source) return [];
  const lines = source.split("\n");
  const blocks: MemoryBlock[] = [];
  let current: MemoryBlock | null = null;
  const flush = () => {
    if (!current) return;
    current.content = current.content.trim();
    if (current.title || current.content) blocks.push(current);
    current = null;
  };

  for (const line of lines) {
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) {
      flush();
      const title = heading[1].trim();
      current = { key: normalizeKey(title), section: sectionOf(title), title, content: "" };
      continue;
    }
    if (!current) {
      current = { key: "overview", section: "other", title: "会话概览", content: "" };
    }
    current.content += `${line}\n`;
  }
  flush();
  return blocks;
}

/** 把结构化块渲染回稳定的 Markdown，供注入、前端编辑和导出使用。 */
export function renderMemoryMarkdown(blocks: MemoryBlock[]): string {
  return blocks
    .filter((block) => block.title.trim() || block.content.trim())
    .map((block) => `## ${block.title.trim()}\n\n${block.content.trim()}`)
    .join("\n\n")
    .trim();
}

/**
 * 按 key 找已有块。
 *
 * 精确 key 优先；其次允许用 section 名（如 todos）指向【标准章节块】（标题就是「待办」这类
 * 章节名的块）——旧 Markdown 的 key 是中文标题，模型常用稳定的 section key。
 * 只认标准章节块，不认「section 恰好相同的任意块」：早先那样做，模型一个 upsert key=status
 * 就会把第一个 status 类的块整块换掉，正是「记忆丢了」的来源之一。
 */
function findTarget(blocks: Map<string, MemoryBlock>, list: MemoryBlock[], key: string): MemoryBlock | undefined {
  const exact = blocks.get(key);
  if (exact) return exact;
  if (!SECTION_KEYS.has(key as MemorySection)) return undefined;
  return list.find((block) => blocks.has(block.key) && block.section === key && SECTION_BY_TITLE[block.title.trim()] === key);
}

function lineKey(line: string): string {
  return line.trim().replace(/^[-*+]\s+|^\d+[.)]\s+/, "").replace(/\s+/g, " ");
}

/** 行级并集：先放 primary 的全部行，再补 secondary 里 primary 没有的行（按去掉列表符号后的文本比较） */
function unionLines(primary: string, secondary: string): string {
  const seen = new Set(primary.split("\n").map(lineKey).filter(Boolean));
  const extra = secondary.split("\n").filter((line) => {
    const k = lineKey(line);
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return [primary.trim(), extra.join("\n").trim()].filter(Boolean).join("\n");
}

/**
 * upsert 防丢：新内容不到旧内容一半长时，不整块替换，而是保留旧块里新内容没提到的行。
 *
 * 模型做 upsert 时经常只写「这次的新信息」而不是完整的块，整块替换就把之前的细节全冲掉了。
 * 宁可留几行可能过时的旧条目，也不要丢信息；真正过时的整块用 delete 清理。
 */
const UPSERT_SHRINK_RATIO = 0.5;

/** 对同 key 的块做增量更新；删除不存在的 key 是幂等操作。 */
export function applyMemoryUpdates(markdown: string, updates: MemoryUpdate[]): string {
  const blocks = parseMemoryMarkdown(markdown);
  const byKey = new Map(blocks.map((block) => [block.key, block]));
  const order = blocks.map((block) => block.key);

  for (const update of updates) {
    const key = normalizeKey(update.key || update.title || "memory");
    // key 对不上但标题相同 → 同一个块（模型常给已有块另起一个英文 key），不要生成重复章节
    const existing = findTarget(byKey, blocks, key)
      || (update.title ? byKey.get(normalizeKey(update.title)) : undefined);
    // 落盘的 Markdown 只有标题，下次解析时 key 由标题推出；新块直接用标题推出的 key，前后才一致
    const targetKey = existing?.key || (update.title ? normalizeKey(update.title) : key);
    if (update.action === "delete") {
      byKey.delete(targetKey);
      continue;
    }
    const title = (update.title || existing?.title || update.key || key).trim();
    const section = update.section || existing?.section || "other";
    const content = String(update.content || "").trim();
    if (!content && !existing) continue;
    let nextContent: string;
    if (!existing) nextContent = content;
    else if (!content) nextContent = existing.content;
    else if (update.action === "append") nextContent = unionLines(existing.content, content);
    else if (content.length < existing.content.trim().length * UPSERT_SHRINK_RATIO) nextContent = unionLines(content, existing.content);
    else nextContent = content;
    byKey.set(targetKey, { key: targetKey, section, title, content: nextContent });
    if (!order.includes(targetKey)) order.push(targetKey);
  }

  return renderMemoryMarkdown(order.map((key) => byKey.get(key)).filter((block): block is MemoryBlock => !!block));
}

/**
 * 把一份外来记忆（导入的 .md、别的会话的记忆）合并进当前记忆，而不是整份替换。
 * 同标题的块做行级并集，新标题的块追加在后面。
 */
export function mergeMemoryMarkdown(current: string, incoming: string): string {
  const base = parseMemoryMarkdown(current);
  if (base.length === 0) return renderMemoryMarkdown(parseMemoryMarkdown(incoming));
  const byKey = new Map(base.map((block) => [block.key, block]));
  const order = base.map((block) => block.key);
  for (const block of parseMemoryMarkdown(incoming)) {
    const existing = byKey.get(block.key);
    if (existing) {
      byKey.set(block.key, { ...existing, content: unionLines(existing.content, block.content) });
    } else {
      byKey.set(block.key, block);
      order.push(block.key);
    }
  }
  return renderMemoryMarkdown(order.map((key) => byKey.get(key)).filter((block): block is MemoryBlock => !!block));
}

/**
 * 用户保存的三方合并：用户基于 base 编辑出 draft，期间后台可能已经把记忆改成了 current。
 *
 * 直接用 draft 覆盖会冲掉后台新写的块；直接丢弃 draft 又丢了用户的编辑。按块合并：
 * · 用户改过 / 新增的块 → 用 draft 的；用户删掉的块 → 删除
 * · 用户没动的块 → 用 current 的（保留后台的更新）
 * · 后台新增的块 → 保留
 */
export function threeWayMergeMemory(base: string, current: string, draft: string): string {
  if (base === current) return draft;
  const baseBlocks = new Map(parseMemoryMarkdown(base).map((block) => [block.key, block]));
  const currentBlocks = parseMemoryMarkdown(current);
  const draftBlocks = parseMemoryMarkdown(draft);
  const draftByKey = new Map(draftBlocks.map((block) => [block.key, block]));

  const result: MemoryBlock[] = [];
  const emitted = new Set<string>();
  // 以用户的顺序为主：用户可能调整了块顺序
  for (const block of draftBlocks) {
    const before = baseBlocks.get(block.key);
    const userChanged = !before || before.content !== block.content || before.title !== block.title;
    const now = currentBlocks.find((b) => b.key === block.key);
    result.push(userChanged || !now ? block : now);
    emitted.add(block.key);
  }
  for (const block of currentBlocks) {
    if (emitted.has(block.key)) continue;
    const deletedByUser = baseBlocks.has(block.key) && !draftByKey.has(block.key);
    if (deletedByUser) continue;
    result.push(block);
  }
  return renderMemoryMarkdown(result);
}

/** 给记忆生成模型看的版本：每个块标出 key，模型据此精确更新已有块，而不是另起一个重复的块 */
export function renderMemoryForModel(markdown: string): string {
  return parseMemoryMarkdown(markdown)
    .map((block) => `## ${block.title}  〔key: ${block.key}〕\n\n${block.content}`)
    .join("\n\n");
}

/** 从模型 JSON 中提取更新数组，容忍 ```json 包裹和多余说明。 */
export function parseMemoryUpdates(value: string): MemoryUpdate[] {
  const raw = String(value || "").trim().replace(/^```json\s*/i, "").replace(/\s*```$/i, "");
  try {
    const parsed = JSON.parse(raw);
    const updates = Array.isArray(parsed) ? parsed : parsed?.updates;
    if (!Array.isArray(updates)) return [];
    return updates.filter((item): item is MemoryUpdate =>
      item && typeof item === "object"
      && (item.action === "upsert" || item.action === "append" || item.action === "delete")
      && typeof item.key === "string",
    );
  } catch {
    return [];
  }
}

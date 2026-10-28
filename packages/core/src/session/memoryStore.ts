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

/** 对同 key 的块做增量更新；删除不存在的 key 是幂等操作。 */
export function applyMemoryUpdates(markdown: string, updates: MemoryUpdate[]): string {
  const blocks = parseMemoryMarkdown(markdown);
  const byKey = new Map(blocks.map((block) => [block.key, block]));
  const order = blocks.map((block) => block.key);

  for (const update of updates) {
    const key = normalizeKey(update.key || update.title || "memory");
    // 兼容旧 Markdown：旧标题 `## 待办` 的 key 是中文标题，但新协议常用稳定 section key `todos`。
    // 优先精确 key，其次按 section 找已有块，避免 append 生成重复章节、delete 删不到旧章节。
    const existing = byKey.get(key)
      || (SECTION_KEYS.has(key as MemorySection) ? blocks.find((block) => block.section === key) : undefined);
    const targetKey = existing?.key || key;
    if (update.action === "delete") {
      byKey.delete(targetKey);
      continue;
    }
    const title = (update.title || existing?.title || update.key || key).trim();
    const section = update.section || existing?.section || "other";
    const content = String(update.content || "").trim();
    if (!content && !existing) continue;
    const next: MemoryBlock = {
      key: targetKey,
      section,
      title,
      content: update.action === "append" && existing
        ? [existing.content.trim(), content].filter(Boolean).join("\n")
        : content || existing?.content || "",
    };
    byKey.set(targetKey, next);
    if (!order.includes(targetKey)) order.push(targetKey);
  }

  return renderMemoryMarkdown(order.map((key) => byKey.get(key)).filter((block): block is MemoryBlock => !!block));
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

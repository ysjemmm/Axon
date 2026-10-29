/**
 * 按工具定义（JSON Schema）纠正模型给的参数。
 *
 * 模型「非法调用」大多不是不会用，而是格式上差一点：
 *   · 数组 / 对象被序列化成了字符串："[{\"question\": …}]"
 *   · 布尔、数字写成字符串："true"、"3"；该是字符串的给了数字
 *   · 该是数组的只给了一个值："a.ts" 而不是 ["a.ts"]
 *   · 参数名差一点：file_path / filePath 写成了 path 该在的位置
 * 这些都能无歧义地纠正，纠正后照常执行，不让模型白白多一轮。
 * 纠正不了的（缺必填参数）给出明确的错误：缺哪个、什么类型、什么意思，附上全部参数清单。
 */

type Schema = {
  type?: string | string[];
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  enum?: unknown[];
  description?: string;
};

export interface CoerceResult {
  args: Record<string, unknown>;
  /** 纠正不了的问题；有值时不应执行 */
  error?: string;
  /** 做过的纠正（调试 / 日志用） */
  fixes: string[];
}

const typeOf = (s: Schema | undefined): string | undefined => (Array.isArray(s?.type) ? s?.type[0] : s?.type);
const norm = (k: string) => k.toLowerCase().replace(/[_\-\s]/g, "");

function tryJson(v: string): unknown {
  const t = v.trim();
  if (!(t.startsWith("[") || t.startsWith("{"))) return undefined;
  try { return JSON.parse(t); } catch { return undefined; }
}

function coerceValue(value: unknown, schema: Schema | undefined, path: string, fixes: string[], depth: number): unknown {
  const type = typeOf(schema);
  if (!schema || !type || depth > 6) return value;
  if (type === "array") {
    if (typeof value === "string") {
      const parsed = tryJson(value);
      if (Array.isArray(parsed)) { fixes.push(`${path}: 字符串 → 数组`); value = parsed; }
      else if (parsed && typeof parsed === "object" && typeOf(schema.items) === "object") { fixes.push(`${path}: 单个对象 → 数组`); value = [parsed]; }
      else if (typeOf(schema.items) === "string" || !schema.items) { fixes.push(`${path}: 单个值 → 数组`); return [value]; }
    } else if (value && typeof value === "object" && !Array.isArray(value) && typeOf(schema.items) === "object") {
      fixes.push(`${path}: 单个对象 → 数组`);
      value = [value];
    }
    if (Array.isArray(value)) return value.map((item, i) => coerceValue(item, schema.items, `${path}[${i}]`, fixes, depth + 1));
    return value;
  }
  if (type === "object") {
    if (typeof value === "string") {
      const parsed = tryJson(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) { fixes.push(`${path}: 字符串 → 对象`); value = parsed; }
    }
    if (value && typeof value === "object" && !Array.isArray(value) && schema.properties) {
      return coerceObject(value as Record<string, unknown>, schema, path, fixes, depth + 1);
    }
    return value;
  }
  if (type === "boolean" && typeof value === "string") {
    const t = value.trim().toLowerCase();
    if (t === "true" || t === "false") { fixes.push(`${path}: "${value}" → 布尔`); return t === "true"; }
  }
  if ((type === "number" || type === "integer") && typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    fixes.push(`${path}: "${value}" → 数字`);
    return Number(value);
  }
  if (type === "string" && (typeof value === "number" || typeof value === "boolean")) {
    fixes.push(`${path}: ${value} → 字符串`);
    return String(value);
  }
  return value;
}

function coerceObject(obj: Record<string, unknown>, schema: Schema, path: string, fixes: string[], depth: number): Record<string, unknown> {
  const props = schema.properties ?? {};
  const out: Record<string, unknown> = { ...obj };
  // 参数名差一点：缺了某个参数，而多出来的某个键名与它只差大小写 / 下划线，或以它结尾（file_path → path）
  for (const want of Object.keys(props)) {
    if (out[want] !== undefined) continue;
    const extra = Object.keys(out).filter((k) => !(k in props) && (norm(k) === norm(want) || (norm(k).endsWith(norm(want)) && norm(want).length >= 3)));
    if (extra.length === 1) {
      fixes.push(`${path}${path ? "." : ""}${extra[0]} → ${want}`);
      out[want] = out[extra[0]];
      delete out[extra[0]];
    }
  }
  for (const [key, sub] of Object.entries(props)) {
    if (out[key] !== undefined) out[key] = coerceValue(out[key], sub, path ? `${path}.${key}` : key, fixes, depth);
  }
  return out;
}

function describeParam(name: string, s: Schema | undefined): string {
  const type = typeOf(s) ?? "any";
  const desc = s?.description ? `：${s.description.split("\n")[0].slice(0, 80)}` : "";
  return `${name}（${type}）${desc}`;
}

/** 按 schema 纠正参数并检查必填（只查顶层：嵌套结构的校验交给各工具自己的规整函数，它们给的提示更具体） */
export function coerceToolArgs(toolName: string, args: Record<string, unknown>, schema: unknown): CoerceResult {
  const fixes: string[] = [];
  const s = schema as Schema | undefined;
  if (!s || typeOf(s) !== "object" || !s.properties) return { args, fixes };
  const fixed = coerceObject(args, s, "", fixes, 0);
  const missing = (s.required ?? []).filter((k) => fixed[k] === undefined || fixed[k] === null || (typeof fixed[k] === "string" && fixed[k] === "" && typeOf(s.properties?.[k]) !== "string"));
  if (missing.length > 0) {
    const all = Object.keys(s.properties).map((k) => `  · ${describeParam(k, s.properties![k])}${s.required?.includes(k) ? " [必填]" : ""}`);
    const got = Object.keys(args).length ? Object.keys(args).join("、") : "（无）";
    return {
      args: fixed,
      fixes,
      error:
        `${toolName} 调用参数不对：缺少必填参数 ${missing.join("、")}。你传了：${got}。\n` +
        `${toolName} 的参数：\n${all.join("\n")}\n请按上面的参数名和类型重新调用。`,
    };
  }
  return { args: fixed, fixes };
}

/** 在工具清单里找到某个工具的参数 schema */
export function schemaForTool(defs: Array<{ function?: { name?: string; parameters?: unknown } }>, toolName: string): unknown {
  return defs.find((d) => d.function?.name === toolName)?.function?.parameters;
}

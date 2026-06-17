/**
 * 命令信任白名单 —— 锚定 token 字典树（trie）+ 包含去重 + 元字符闸门
 *
 * 设计要点（与形态无关的纯逻辑，不碰文件系统/进程）：
 * - 默认全拒：空 trie 时任何命令都不被信任，需用户授权。
 * - 三档粒度：exact（整条）/ prefix（前缀子树 `npm run *`）/ all（`*`）。
 * - 锚定匹配：命令必须从【开头】匹配信任前缀，绝不做"任意位置子串"匹配
 *   （那会让 `echo npm run && rm -rf /` 被误判命中 `npm run *`）。故用普通 trie，
 *   而非 AC 自动机——AC 的 failure link 是为多模式子串搜索设计的，这里既无用又危险。
 * - 包含去重：加 wildcard 时剪掉其整棵子树；在已有祖先 wildcard 下加规则则 no-op。
 *   于是先 `npm run *` 后 `npm *` → 自动只剩 `npm *`。
 * - 元字符闸门：含 `&& || ; | \` $() > < &` 等拼接/扩展符的命令，不走 wildcard 匹配，
 *   只允许命中"精确整条"规则；防止前缀信任被命令拼接绕过。
 */

export type TrustScope = "exact" | "prefix" | "all";

/** 一条信任规则（结构化，避免字符串编码歧义） */
export interface TrustRule {
  scope: TrustScope;
  /** exact: 归一化后的整条命令；prefix: 前缀 token 串（不含星号，如 "npm run"）；all: "*" */
  pattern: string;
  /** 来源：用户弹窗批准 / 设置里手动添加 / 内置默认 */
  source?: "approved" | "manual" | "builtin";
}

/** shell 拼接/扩展元字符：命中则命令不可走 wildcard 匹配 */
const METACHAR_RE = /[&|;`]|\$\(|>>|>|<|\n/;

/** 倾向于"动词在第二个 token"的工具，前缀默认取前两段（如 `npm run`、`git commit`） */
const TWO_TOKEN_TOOLS = new Set([
  "npm", "pnpm", "yarn", "npx", "git", "node", "docker", "cargo",
  "go", "python", "python3", "pip", "pip3", "make", "kubectl", "dotnet",
]);

/** 归一化命令：去首尾空白、折叠内部空白、剥离前导环境变量赋值 */
export function normalizeCommand(raw: string): string {
  let s = (raw ?? "").trim().replace(/\s+/g, " ");
  while (/^[A-Za-z_][A-Za-z0-9_]*=[^\s]+\s+/.test(s)) {
    s = s.replace(/^[A-Za-z_][A-Za-z0-9_]*=[^\s]+\s+/, "");
  }
  return s;
}

export function hasShellMetacharacters(normalized: string): boolean {
  return METACHAR_RE.test(normalized);
}

function tokenize(normalized: string): string[] {
  return normalized.length === 0 ? [] : normalized.split(" ");
}

/** 由命令推导建议的前缀模式（用于弹窗第二档） */
export function derivePrefix(command: string): string {
  const tokens = tokenize(normalizeCommand(command));
  if (tokens.length === 0) return "";
  if (tokens.length >= 2 && TWO_TOKEN_TOOLS.has(tokens[0])) {
    return `${tokens[0]} ${tokens[1]}`;
  }
  return tokens[0];
}

interface TrieNode {
  children: Map<string, TrieNode>;
  wildcard: boolean; // 此节点起整棵子树放行
  exact: boolean;    // 恰好走到此节点的完整命令放行
}

function newNode(): TrieNode {
  return { children: new Map(), wildcard: false, exact: false };
}

export class CommandTrustTrie {
  private root: TrieNode = newNode();
  /** 含元字符的精确整条规则（不进 trie，逐字匹配） */
  private exactWithMeta = new Set<string>();

  constructor(rules?: TrustRule[]) {
    if (rules) for (const r of rules) this.add(r);
  }

  /** 添加一条规则（自动包含去重） */
  add(rule: TrustRule): void {
    if (rule.scope === "all") {
      this.root.wildcard = true;
      this.root.children.clear(); // 全覆盖：剪掉所有子树
      return;
    }
    if (rule.scope === "exact") {
      const norm = normalizeCommand(rule.pattern);
      if (hasShellMetacharacters(norm)) {
        if (!this.root.wildcard) this.exactWithMeta.add(norm);
        return;
      }
      this.addExact(tokenize(norm));
      return;
    }
    // prefix
    this.addPrefix(tokenize(normalizeCommand(rule.pattern)));
  }

  private addExact(tokens: string[]): void {
    if (tokens.length === 0 || this.root.wildcard) return;
    let node = this.root;
    for (const t of tokens) {
      if (node.wildcard) return; // 祖先已 wildcard 覆盖 → no-op
      node = this.childOrCreate(node, t);
    }
    node.exact = true;
  }

  private addPrefix(tokens: string[]): void {
    if (tokens.length === 0 || this.root.wildcard) return;
    let node = this.root;
    for (const t of tokens) {
      if (node.wildcard) return; // 祖先已 wildcard 覆盖 → no-op
      node = this.childOrCreate(node, t);
    }
    node.wildcard = true;
    node.children.clear(); // 剪掉被本前缀包含的整棵子树
  }

  private childOrCreate(node: TrieNode, token: string): TrieNode {
    let child = node.children.get(token);
    if (!child) {
      child = newNode();
      node.children.set(token, child);
    }
    return child;
  }

  /** 判断命令是否被信任 */
  isTrusted(command: string): boolean {
    const norm = normalizeCommand(command);
    if (this.root.wildcard) return true;        // "*" 覆盖一切（含元字符命令）
    if (norm.length === 0) return false;
    if (hasShellMetacharacters(norm)) {
      return this.exactWithMeta.has(norm);       // 元字符命令只认精确整条
    }
    let node = this.root;
    for (const t of tokenize(norm)) {
      const child = node.children.get(t);
      if (!child) return false;
      if (child.wildcard) return true;           // 路径上遇到 wildcard 子树 → 信任
      node = child;
    }
    return node.exact;                            // 走完全部 token 且为精确终点
  }

  /** 导出当前最简规则集（已去重） */
  list(): TrustRule[] {
    const out: TrustRule[] = [];
    if (this.root.wildcard) out.push({ scope: "all", pattern: "*" });
    else this.collect(this.root, [], out);
    for (const m of this.exactWithMeta) out.push({ scope: "exact", pattern: m });
    return out;
  }

  private collect(node: TrieNode, path: string[], out: TrustRule[]): void {
    if (node.wildcard && path.length > 0) {
      out.push({ scope: "prefix", pattern: path.join(" ") });
      return; // 子树已被剪枝，无需继续
    }
    if (node.exact && path.length > 0) {
      out.push({ scope: "exact", pattern: path.join(" ") });
    }
    for (const [token, child] of node.children) {
      this.collect(child, [...path, token], out);
    }
  }

  /** 序列化为字符串数组（prefix→"x *"，all→"*"，exact 原样）。供 VS Code 设置 / JSON 存储用 */
  serialize(): string[] {
    return this.list().map((r) =>
      r.scope === "all" ? "*" : r.scope === "prefix" ? `${r.pattern} *` : r.pattern,
    );
  }

  /** 从字符串数组解析（约定：" *" 结尾=前缀，"*"=全部，其余=精确） */
  static fromStrings(patterns: string[]): CommandTrustTrie {
    const trie = new CommandTrustTrie();
    for (const p of patterns) trie.add(parsePattern(p));
    return trie;
  }
}

/** 把字符串模式解析为结构化规则 */
export function parsePattern(raw: string): TrustRule {
  const p = raw.trim();
  if (p === "*") return { scope: "all", pattern: "*" };
  if (p.endsWith(" *")) return { scope: "prefix", pattern: normalizeCommand(p.slice(0, -2)) };
  return { scope: "exact", pattern: normalizeCommand(p) };
}

/** 由一条命令 + 选择的粒度，构造对应的信任规则（供弹窗"加入白名单"用） */
export function ruleForChoice(command: string, scope: TrustScope): TrustRule {
  if (scope === "all") return { scope: "all", pattern: "*", source: "approved" };
  if (scope === "prefix") return { scope: "prefix", pattern: derivePrefix(command), source: "approved" };
  return { scope: "exact", pattern: normalizeCommand(command), source: "approved" };
}

/** 弹窗三档建议 */
export function buildTrustOptions(command: string): { choice: TrustScope; pattern: string; label: string }[] {
  const norm = normalizeCommand(command);
  const prefix = derivePrefix(command);
  return [
    { choice: "exact", pattern: norm, label: `仅允许这条命令：${norm}` },
    { choice: "prefix", pattern: prefix, label: `允许 ${prefix} *` },
    { choice: "all", pattern: "*", label: "允许所有命令（不推荐，仅本会话）" },
  ];
}

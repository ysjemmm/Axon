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

export type TrustScope = "exact" | "partial" | "prefix" | "all";

/** 一条信任规则（结构化，避免字符串编码歧义） */
export interface TrustRule {
  scope: TrustScope;
  /** exact: 归一化后的整条命令；prefix: 前缀 token 串（不含星号，如 "npm run"）；all: "*" */
  pattern: string;
  /** 来源：用户弹窗批准 / 设置里手动添加 / 内置默认 */
  source?: "approved" | "manual" | "builtin";
}

/** shell 拼接/扩展元字符：命中则命令不可走 wildcard 匹配。
 *  注意：|（管道）不在此列——管道是 PowerShell/Bash 的常用组合方式，
 *  信任第一个命令的前缀就应放行整个管道（危险命令由 detectDangerousCommand 拦截）。 */
const METACHAR_RE = /[&;`]|\$\(|>>|>|<|\n/;

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
      this.exactWithMeta.clear(); // 全覆盖：清掉所有精确规则
      return;
    }
    if (rule.scope === "exact") {
      this.addExact(tokenize(normalizeCommand(rule.pattern)));
      return;
    }
    // prefix
    this.addPrefix(tokenize(normalizeCommand(rule.pattern)));
  }

  /** 检查含元字符的命令是否已被 trie 中的某个 prefix 覆盖 */
  private isPrefixCovered(norm: string): boolean {
    // 取 ; 或其他元字符之前的部分作为"第一条命令"来匹配 trie
    const firstCmd = norm.split(/[;&`]/)[0].trim();
    if (!firstCmd) return false;
    let node = this.root;
    for (const t of tokenize(firstCmd)) {
      const child = node.children.get(t);
      if (!child) return false;
      if (child.wildcard) return true;
      node = child;
    }
    return false;
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
    // 同时清理 exactWithMeta 中被新 prefix 覆盖的精确规则
    const prefixStr = tokens.join(" ");
    for (const exact of this.exactWithMeta) {
      if (exact === prefixStr || exact.startsWith(prefixStr + " ")) {
        this.exactWithMeta.delete(exact);
      }
    }
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
    if (this.root.wildcard) return true;
    if (norm.length === 0) return false;

    // 管道命令：只看 | 左边第一个命令。管道只是把输出传给下游，
    // 下游 Select-Object/Sort-Object 等格式化工具不会造成安全风险，
    // 真正的危险命令已被 detectDangerousCommand 硬拦。
    // 要求两边都信任会导致用户永远没机会单独信任 Select-Object
    // （AI 不会单独调它），从而每次管道都要手动确认——体验极差。
    if (norm.includes("|")) {
      const firstPart = norm.split("|")[0].trim();
      if (!firstPart) return false;
      return this.isTrustedSingle(firstPart);
    }

    return this.isTrustedSingle(norm);
  }

  /** 判断单个命令（不含管道）是否被信任 */
  private isTrustedSingle(norm: string): boolean {
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
  if (scope === "prefix") {
    // prefix = 根命令：只取第一个 token（如 "node"），信任该命令的所有调用。
    const tokens = tokenize(normalizeCommand(command));
    return { scope: "prefix", pattern: tokens[0] ?? "", source: "approved" };
  }
  if (scope === "partial") {
    // partial = 中间前缀：优先用 derivePrefix（两段工具取前两段），
    // 否则取前两个 token（如 "1..50 |" 或 "docker build"）。
    const p = derivePrefix(command);
    const tokens = tokenize(normalizeCommand(command));
    const root = tokens[0] ?? "";
    let partial = p !== root ? p : (tokens.length >= 2 ? `${tokens[0]} ${tokens[1]}` : root);
    // 管道命令：isTrusted 只匹配管道左侧第一段，所以 partial 也要同步——
    // 去掉管道符及右侧，只保留左侧前两段作为前缀。
    partial = partial.split("|")[0].trim();
    if (!partial) partial = root.split("|")[0].trim();
    return { scope: "prefix", pattern: partial, source: "approved" };
  }
  return { scope: "exact", pattern: normalizeCommand(command), source: "approved" };
}

/** 弹窗四档建议：exact → partial（两段）→ prefix（根命令）→ all */
export function buildTrustOptions(command: string): { choice: TrustScope; pattern: string; label: string }[] {
  const norm = normalizeCommand(command);
  const tokens = tokenize(norm);
  const prefix = derivePrefix(command);       // 两段工具取前两段，否则取首段
  const root = tokens[0] ?? "";               // 根命令（仅第一个 token）
  const opts: { choice: TrustScope; pattern: string; label: string }[] = [
    { choice: "exact", pattern: norm, label: `仅此命令：${norm}` },
  ];
  // partial：优先用 derivePrefix（两段工具如 node -e）；
  // 如果 derivePrefix 只返回了 root（非两段工具），但命令有 3+ token，
  // 取前两段作为中间档（如 "docker build"）。
  // 管道命令只取管道左侧第一段做前缀（和 isTrusted 的管道处理一致）。
  let partialPattern = "";
  if (prefix && root && prefix !== root) {
    partialPattern = prefix;
  } else if (tokens.length >= 3 && root) {
    partialPattern = `${tokens[0]} ${tokens[1]}`;
  }
  partialPattern = partialPattern.split("|")[0].trim();
  // partial 去重：与 root 相同或与完整命令相同时不显示
  // （如 "git push" 只有 2 个 token，partial "git push" 和 exact 完全等价）
  if (partialPattern && partialPattern !== root && partialPattern !== norm) {
    opts.push({ choice: "partial", pattern: partialPattern, label: `信任 ${partialPattern} *` });
  }
  opts.push({ choice: "prefix", pattern: root, label: `信任 ${root} *（根命令）` });
  opts.push({ choice: "all", pattern: "*", label: "信任所有命令（不推荐）" });
  return opts;
}

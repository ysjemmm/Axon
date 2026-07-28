/**
 * Markdown 渲染 - 基于 markdown-it + highlight.js + KaTeX（直接渲染，无插件）
 *
 * KaTeX 策略：不依赖任何 markdown-it 插件（它们在 Vite 浏览器环境有反斜杠被吞的 bug）。
 * 改为：normalizeMath → 手动提取 $$/$$ 和 $$ → katex.renderToString → 占位符保护 → markdown-it 渲染 → 还原。
 * 这样 markdown-it 完全不碰数学内容，反斜杠绝对不会被吃。
 */

import MarkdownIt from "markdown-it";
import hljs from "highlight.js";
import katex from "katex";

/**
 * ── 渲染结果缓存（流式输出的关键优化）──
 *
 * 流式期间 MarkdownRenderer 会把**整条消息**反复从头重新解析（内容每增长一次就重来一遍），
 * 而这条链路里最贵的两步——highlight.js 语法高亮与 KaTeX 公式渲染——输入几乎完全没变：
 * 一条回复里靠前的代码块/公式在后续每一次重解析中都逐字相同，却每次都要重算一遍。
 * 长回复里这是几十次全量高亮，也正是当初不得不把重解析节流到 80ms 的原因——
 * 代价是可见更新掉到 12.5fps，把打字机精心切细的出字粒度又重新量化成"一簇字蹦一下"
 * （打字机压到 5 字/帧就是为了避免这种颗粒感，见 useTypewriter 的 BASE_BATCH 注释）。
 *
 * 三个调用点都是纯函数（同样输入必得同样 HTML），所以按输入缓存是安全的。
 * 命中后重解析基本只剩 markdown-it 自身的 token 化，节流才降得下来。
 *
 * 与主题无关：hljs 产出的是 class 名（hljs-keyword 等）、KaTeX 产出的是结构化标记，
 * 配色全靠 CSS，所以主题切换不需要让缓存失效。
 *
 * 用 Map + FIFO 淘汰而非 LRU：这里的访问模式是"同一批 key 在一轮流式内被反复命中"，
 * 容量够装下单条消息的全部块就行，不必按热度排序。
 */
const RENDER_CACHE_MAX = 256;

/** 按 key 缓存纯函数结果；未命中时调 compute 并写入（超容量时淘汰最早插入的） */
function memoized(cache: Map<string, string>, key: string, compute: () => string): string {
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const value = compute();
  if (cache.size >= RENDER_CACHE_MAX) {
    // Map 的迭代顺序即插入顺序，首个 key 就是最早写入的那个
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, value);
  return value;
}

/**
 * 三个缓存必须各自独立：同一份 (lang, code) 在"未知语言"分支下的产出并不相同
 * （autoCache 会去猜语言，escapeCache 只做转义），共用一个 Map 会串味。
 */
const highlightAutoCache = new Map<string, string>();
const highlightEscapeCache = new Map<string, string>();
const katexCache = new Map<string, string>();

/** 缓存 key 分隔符：lang / displayMode 里不可能出现 NUL，不会与内容混淆 */
const CACHE_KEY_SEP = "\u0000";

/**
 * md 构造项 highlight 用的高亮：已知语言走精确高亮，否则 highlightAuto。
 * fence 规则被下面重写了，所以这条路径实际只服务缩进式代码块（4 空格）。
 * highlightAuto 要逐个语言试一遍，是整条渲染链里单次最贵的调用，最需要缓存。
 */
function highlightWithAutoFallback(code: string, lang: string): string {
  return memoized(highlightAutoCache, `${lang}${CACHE_KEY_SEP}${code}`, () => {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
      } catch { /* fallback */ }
    }
    try {
      return hljs.highlightAuto(code).value;
    } catch {
      return "";
    }
  });
}

/**
 * fence 规则用的高亮：已知语言走精确高亮，否则仅做 HTML 转义。
 * 刻意**不**回落到 highlightAuto——代码块通常带语言标注，对没标注的内容瞎猜语言
 * 既慢又容易染错色。这与上面那条路径的语义差异是有意的，别合并。
 */
function highlightOrEscape(code: string, lang: string): string {
  return memoized(highlightEscapeCache, `${lang}${CACHE_KEY_SEP}${code}`, () => {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
      } catch {
        return md.utils.escapeHtml(code);
      }
    }
    return md.utils.escapeHtml(code);
  });
}

const md = new MarkdownIt({
  html: false, // 禁止历史/普通回复里的裸 HTML 进入 dangerouslySetInnerHTML；KaTeX 通过占位符在渲染后恢复
  linkify: true,
  typographer: false, // 关闭：防止 typographer 对占位符周围的引号做智能替换
  breaks: true,
  highlight: (str, lang) => highlightWithAutoFallback(str, lang),
});

// 禁用水平分割线渲染
md.renderer.rules.hr = function () {
  return '<div class="my-1"></div>\n';
};

// 链接新窗口打开
const defaultRender =
  md.renderer.rules.link_open ||
  function (tokens, idx, options, _env, self) {
    return self.renderToken(tokens, idx, options);
  };

md.renderer.rules.link_open = function (tokens, idx, options, env, self) {
  const href = tokens[idx].attrGet("href") || "";
  // 外部 http(s) 链接：打标记供前端事件委托识别（webview 里 target=_blank 会被拦截，需走 openExternal）
  if (/^https?:\/\//i.test(href)) {
    tokens[idx].attrSet("data-external-link", href);
  }
  tokens[idx].attrSet("target", "_blank");
  tokens[idx].attrSet("rel", "noopener noreferrer");
  return defaultRender(tokens, idx, options, env, self);
};

// 代码块：带高亮 + 复制按钮。只有显式 opt-in 的 SVG / Mermaid / HTML 才增强渲染。
const ENHANCED_LANGS = new Set(["svg", "mermaid", "html"]);
const ENHANCED_RENDER_MARKER = "axon-render";
const MATH_PLACEHOLDER_PREFIX = "AXON_MATH_PLACEHOLDER_";

md.renderer.rules.fence = function (tokens, idx) {
  const token = tokens[idx];
  const infoParts = token.info.trim().split(/\s+/).filter(Boolean);
  const lang = (infoParts[0] || "code").toLowerCase();
  const meta = infoParts.slice(1).map((part) => part.toLowerCase());
  const enableEnhance = ENHANCED_LANGS.has(lang) && meta.includes(ENHANCED_RENDER_MARKER);
  const canPreview = ENHANCED_LANGS.has(lang) && !enableEnhance;

  // 走缓存：流式重解析时靠前的代码块内容逐字不变，没必要每次重跑高亮
  const highlightedCode = highlightOrEscape(token.content, lang);

  const enhanceAttr = enableEnhance ? ` data-enhanced-lang="${lang}"` : "";
  const previewAttr = canPreview ? ` data-preview-lang="${lang}"` : "";
  const displayLang = md.utils.escapeHtml(lang);

  // 增强渲染块（svg/mermaid/html）：不渲染标题栏（"svg" + 复制按钮），hydrate 后会注入悬浮三点菜单。
  // 普通代码块：采用更清爽的样式——弱化头部分割、增大内边距、把语言名作为轻量标签。
  if (enableEnhance) {
    return `<div class="axon-codeblock my-3 rounded-lg overflow-hidden px-4 py-1.5" style="background:var(--axon-code-bg);border:1px solid var(--axon-code-border)"${enhanceAttr}>
    <pre class="overflow-auto max-h-[28rem] m-0 p-0" style="background:transparent"><code class="text-[11px] leading-[1.6] font-mono hljs" style="color:var(--vscode-editor-foreground,var(--hl-text,#383a42))">${highlightedCode}</code></pre>
  </div>\n`;
  }

  const previewButton = canPreview ? `<button data-preview-code class="flex items-center gap-1 hover:text-foreground transition-colors cursor-pointer">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>
        <span>预览</span>
      </button>` : "";

  return `<div class="axon-codeblock my-3 rounded-lg overflow-hidden relative px-4 pt-1.5 pb-1.5" style="background:var(--axon-code-bg);border:1px solid var(--axon-code-border)"${previewAttr}>
    <div class="flex items-center justify-between mb-1">
      <span class="text-[11px] font-medium opacity-50" style="color:var(--vscode-descriptionForeground,#6b7280)">${displayLang === "code" ? "text" : displayLang}</span>
      <div class="axon-codeblock-actions flex items-center gap-2.5 text-[11px]" style="color:var(--vscode-descriptionForeground,#6b7280)">
        ${previewButton}
        <button data-copy-code class="flex items-center gap-1 hover:text-foreground transition-colors cursor-pointer">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
          <span>复制</span>
        </button>
      </div>
    </div>
    <div class="axon-codeblock-scroll overflow-x-auto overflow-y-hidden">
      <pre class="axon-codeblock-pre max-h-[28rem] m-0 p-0" style="background:transparent"><code class="text-[11px] leading-[1.6] font-mono hljs" style="color:var(--vscode-editor-foreground,var(--hl-text,#383a42))">${highlightedCode}</code></pre>
    </div>
  </div>\n`;
};

/**
 * 主渲染入口：归一化定界符 → 预渲染数学（直接 katex.renderToString）→ markdown-it 渲染 → 还原数学 HTML。
 */
export function renderMarkdown(text: string): string {
  const fenced = normalizeFences(text);
  const normalized = normalizeMath(fenced);
  const { cleaned, placeholders } = extractAndRenderMath(normalized);
  const html = md.render(cleaned);
  return restoreMath(html, placeholders);
}

/** 解析一行是否为代码围栏行；返回围栏长度与其后的 info string（语言标识） */
function parseFenceLine(line: string): { indent: string; marker: string; info: string } | null {
  const m = line.match(/^([ \t]{0,3})(`{3,})(.*)$/);
  if (!m) return null;
  return { indent: m[1], marker: m[2], info: m[3].trim() };
}

/**
 * 容错：修复模型常见的畸形代码围栏。
 *
 * 处理两类问题：
 *
 * 1) 嵌套围栏被外层"抢走"闭合。
 *    Markdown 里同长度围栏无法嵌套：展示 md 示例时外层与内层都是三反引号，
 *    内层示例的收尾围栏会被当成外层的闭合，末尾还会多出一个空代码块。
 *    做法是按"是否带语言标识"区分开/闭（闭合围栏依 CommonMark 不允许带 info string），
 *    用栈判断嵌套深度；一旦发现某个块内部还有围栏，就把最外层围栏补长到超过内层，
 *    交给 markdown-it 时已是合法的 CommonMark 嵌套写法。
 *
 * 2) 闭合围栏后直接贴正文（如围栏紧跟"好的"），markdown-it 不认这种闭合，
 *    会把后续文本一路吞进代码块。这里把它拆成"纯围栏行 + 换行 + 正文"。
 *
 * 不再使用旧的"遇到任意三反引号就按奇偶计数"的做法——那会把内层示例围栏误判成闭合，
 * 还会把带语言的围栏改写坏（如把 json 标识挤到下一行）。
 */
function normalizeFences(text: string): string {
  if (!text.includes("```")) return text;

  const parts = text.split(/(\r?\n)/);
  // 收集每一行的围栏信息，先判定结构，再决定如何输出（补长需要回头改开围栏那一行）
  const lines: string[] = [];
  const newlines: string[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    lines.push(parts[i] ?? "");
    newlines.push(parts[i + 1] ?? "");
  }

  // 第一遍：用栈求出每个顶层块的范围，以及块内出现过的最大围栏长度
  interface Block { openIdx: number; closeIdx: number; markerLen: number; innerMaxLen: number }
  const blocks: Block[] = [];
  const stack: { openIdx: number; markerLen: number }[] = [];

  for (let i = 0; i < lines.length; i++) {
    const f = parseFenceLine(lines[i]);
    if (!f) continue;
    const isOpen = f.info.length > 0;

    if (isOpen) {
      // 带语言标识 → 一定是开围栏
      stack.push({ openIdx: i, markerLen: f.marker.length });
      // 记录到最外层块的内层最大长度
      if (stack.length > 1) {
        const outerOpen = stack[0].openIdx;
        const rec = blocks.find((b) => b.openIdx === outerOpen);
        if (rec) rec.innerMaxLen = Math.max(rec.innerMaxLen, f.marker.length);
      } else {
        blocks.push({ openIdx: i, closeIdx: -1, markerLen: f.marker.length, innerMaxLen: 0 });
      }
      continue;
    }

    // 裸围栏 → 闭合最近一个未闭合的块
    const opened = stack.pop();
    if (!opened) continue;
    if (stack.length === 0) {
      const rec = blocks.find((b) => b.openIdx === opened.openIdx);
      if (rec) rec.closeIdx = i;
    } else {
      const outerOpen = stack[0].openIdx;
      const rec = blocks.find((b) => b.openIdx === outerOpen);
      if (rec) rec.innerMaxLen = Math.max(rec.innerMaxLen, f.marker.length);
    }
  }

  // 未闭合的块（流式输出被打断）：记下来，末尾补闭合
  const unclosed = stack.length > 0 ? stack[0] : null;
  if (unclosed) {
    const rec = blocks.find((b) => b.openIdx === unclosed.openIdx);
    if (rec) rec.closeIdx = lines.length; // 虚拟闭合位，输出时补
  }

  // 第二遍：按块信息输出。需要补长的块，其开/闭围栏都换成更长的围栏
  const bump = new Map<number, string>(); // 行号 → 替换后的围栏行
  for (const b of blocks) {
    if (b.innerMaxLen < b.markerLen) continue; // 无嵌套或内层更短 → 不用动
    const longer = "`".repeat(b.innerMaxLen + 1);
    const openF = parseFenceLine(lines[b.openIdx]);
    if (openF) bump.set(b.openIdx, `${openF.indent}${longer}${openF.info}`);
    if (b.closeIdx >= 0 && b.closeIdx < lines.length) {
      const closeF = parseFenceLine(lines[b.closeIdx]);
      if (closeF) bump.set(b.closeIdx, `${closeF.indent}${longer}`);
    }
  }

  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const replaced = bump.get(i);
    if (replaced !== undefined) {
      out.push(replaced, newlines[i]);
      continue;
    }

    // 畸形闭合：围栏后直接贴正文 → 拆成独立闭合行 + 正文
    const f = parseFenceLine(lines[i]);
    if (f && f.info.length > 0 && /^[^\s`]/.test(f.info)) {
      const enclosing = blocks.find((b) => b.openIdx < i && (b.closeIdx === -1 || i < b.closeIdx));
      const looksLikeClose = enclosing && !isLikelyLanguage(f.info);
      if (looksLikeClose) {
        out.push(`${f.indent}${f.marker}`, newlines[i] || "\n", f.info, newlines[i]);
        continue;
      }
    }

    out.push(lines[i], newlines[i]);
  }

  let result = out.join("");
  if (unclosed) {
    const rec = blocks.find((b) => b.openIdx === unclosed.openIdx);
    const len = rec && rec.innerMaxLen >= rec.markerLen ? rec.innerMaxLen + 1 : unclosed.markerLen;
    result += "\n" + "`".repeat(len);
  }
  return result;
}

/** info string 是否像语言标识（字母数字/+#-. 组成的短串），用于区分"开围栏"与"畸形闭合后贴的正文" */
function isLikelyLanguage(info: string): boolean {
  const first = info.split(/\s+/)[0] || "";
  return /^[a-zA-Z][\w+#.-]*$/.test(first) && first.length <= 20;
}

/**
 * 从文本中提取 $$...$$ 和 $...$ 块，用 katex.renderToString 预渲染成 HTML，
 * 原位替换为唯一占位符（markdown-it 不会碰这些占位符），最后再还原。
 */
function extractAndRenderMath(text: string): { cleaned: string; placeholders: Map<string, string> } {
  const placeholders = new Map<string, string>();
  let seq = 0;

  // 保护代码围栏（```...```）不被数学提取误伤
  const fences: string[] = [];
  let guarded = text.replace(/```[\s\S]*?```/g, (m) => {
    fences.push(m);
    return `<!--FENCE${fences.length - 1}-->`;
  });

  // 行间 $$...$$（支持跨行，贪心最短匹配）
  guarded = guarded.replace(/\$\$([\s\S]*?)\$\$/g, (_m, inner) => {
    const id = `@@${MATH_PLACEHOLDER_PREFIX}${seq++}@@`;
    const html = renderKatex(inner.trim(), true);
    placeholders.set(id, html);
    return id;
  });

  // 行内 $...$（不跨行，内部不含 $）
  guarded = guarded.replace(/\$([^\n$]+?)\$/g, (_m, inner) => {
    const id = `@@${MATH_PLACEHOLDER_PREFIX}${seq++}@@`;
    const html = renderKatex(inner.trim(), false);
    placeholders.set(id, html);
    return id;
  });

  // 还原代码围栏
  guarded = guarded.replace(/<!--FENCE(\d+)-->/g, (_m, i) => fences[Number(i)]);

  return { cleaned: guarded, placeholders };
}

/**
 * 调用 KaTeX 渲染（带缓存），出错时降级为原文（红色提示）。
 * 缓存键含 displayMode：同一段 latex 行内/行间渲染出的 HTML 不同。
 * 降级分支的结果一并缓存——它同样只取决于 latex，重算不会有不同结果。
 */
function renderKatex(latex: string, displayMode: boolean): string {
  return memoized(katexCache, `${displayMode ? "d" : "i"}${CACHE_KEY_SEP}${latex}`, () => {
    try {
      return katex.renderToString(latex, { displayMode, throwOnError: false });
    } catch {
      return `<span style="color:#cc0000" title="KaTeX 渲染失败">${escapeHtml(latex)}</span>`;
    }
  });
}

/** 把占位符还原为预渲染的 KaTeX HTML */
function restoreMath(html: string, placeholders: Map<string, string>): string {
  for (const [id, rendered] of placeholders) {
    // 占位符可能被 markdown-it 包进 <p> 或转义了 NUL，用宽松匹配
    html = html.replace(id, rendered);
  }
  return html;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * 定界符归一化：把 \[...\]、\(...\)、裸 [...] 统一转成 $$/$。
 */
function normalizeMath(text: string): string {
  // 保护代码围栏
  const fences: string[] = [];
  const guarded = text.replace(/```[\s\S]*?```/g, (m) => {
    fences.push(m);
    return `<!--NFENCE${fences.length - 1}-->`;
  });

  let result = guarded;

  // \[ ... \] → $$ ... $$
  result = result.replace(/\\\[([\s\S]*?)\\\]/g, (_m, inner) => `\n$$\n${inner.trim()}\n$$\n`);

  // \( ... \) → $ ... $
  result = result.replace(/\\\(([\s\S]*?)\\\)/g, (_m, inner) => `$${inner.trim()}$`);

  // 裸 [...] 包裹的公式
  result = normalizeBareBrackets(result);

  // 还原代码围栏
  result = result.replace(/<!--NFENCE(\d+)-->/g, (_m, i) => fences[Number(i)]);

  return result;
}

function normalizeBareBrackets(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed === "[") {
      const block: string[] = [];
      let j = i + 1;
      while (j < lines.length && lines[j].trim() !== "]") { block.push(lines[j]); j++; }
      const hasClose = j < lines.length && lines[j].trim() === "]";
      const inner = block.join("\n");
      if (hasClose && /\\[a-zA-Z]+/.test(inner)) {
        out.push("$$", inner.trim(), "$$");
        i = j;
        continue;
      }
    }
    const single = trimmed.match(/^\[\s*(.+\\[a-zA-Z]+.*?)\s*\]$/);
    if (single) { out.push(`$$${single[1]}$$`); continue; }
    out.push(lines[i]);
  }
  return out.join("\n");
}

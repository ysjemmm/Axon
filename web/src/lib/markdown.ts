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

const md = new MarkdownIt({
  html: true, // 允许 HTML（我们注入了 KaTeX 预渲染的 HTML）
  linkify: true,
  typographer: false, // 关闭：防止 typographer 对占位符周围的引号做智能替换
  breaks: true,
  highlight: function (str, lang) {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return hljs.highlight(str, { language: lang, ignoreIllegals: true }).value;
      } catch { /* fallback */ }
    }
    try {
      return hljs.highlightAuto(str).value;
    } catch {
      return "";
    }
  },
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

// 代码块：带高亮 + 复制按钮
md.renderer.rules.fence = function (tokens, idx) {
  const token = tokens[idx];
  const lang = token.info.trim() || "code";
  let highlightedCode: string;
  if (lang && hljs.getLanguage(lang)) {
    try {
      highlightedCode = hljs.highlight(token.content, { language: lang, ignoreIllegals: true }).value;
    } catch {
      highlightedCode = md.utils.escapeHtml(token.content);
    }
  } else {
    highlightedCode = md.utils.escapeHtml(token.content);
  }
  return `<div class="axon-codeblock my-1.5 rounded-md overflow-hidden" style="border:1px solid var(--axon-code-border,rgba(128,128,128,0.3));background:var(--axon-code-bg,rgba(0,0,0,0.04))">
    <div class="flex items-center justify-between px-3 py-1 text-[11px] text-muted-foreground" style="border-bottom:1px solid var(--axon-code-border,rgba(128,128,128,0.2));background:var(--axon-code-header,rgba(0,0,0,0.03))">
      <span>${lang}</span>
      <button data-copy-code class="flex items-center gap-1 hover:text-foreground transition-colors cursor-pointer">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
        <span>复制</span>
      </button>
    </div>
    <pre class="px-2.5 py-1.5 overflow-auto max-h-96 m-0" style="background:transparent"><code class="text-[12px] leading-snug font-mono hljs" style="color:var(--vscode-editor-foreground,var(--hl-text,#c9d1d9))">${highlightedCode}</code></pre>
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

/**
 * 容错：修复模型常见的畸形代码围栏——闭合 ``` 后直接贴了正文（如 "```好的"），
 * markdown-it 不认这种闭合，会把后续文本吞进代码块。这里给闭合围栏后补一个换行。
 * 按出现次序计数：奇数个 ``` 视为开围栏（保留其语言标识，如 ```python），偶数个视为闭围栏。
 */
function normalizeFences(text: string): string {
  if (!text.includes("```")) return text;
  let result = "";
  let i = 0;
  let count = 0;
  while (i < text.length) {
    if (text.startsWith("```", i)) {
      count++;
      result += "```";
      i += 3;
      // 闭围栏后若不是换行/结尾，补换行，使其成为合法的独立闭合行
      if (count % 2 === 0 && i < text.length && text[i] !== "\n" && text[i] !== "\r") {
        result += "\n";
      }
    } else {
      result += text[i];
      i += 1;
    }
  }
  // 奇数个围栏 = 未闭合代码块 → 补闭合，防止流式输出中断时后续内容被吞
  if (count % 2 === 1) {
    result += "\n```";
  }
  return result;
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
    const id = `<!--MATH${seq++}-->`;
    const html = renderKatex(inner.trim(), true);
    placeholders.set(id, html);
    return id;
  });

  // 行内 $...$（不跨行，内部不含 $）
  guarded = guarded.replace(/\$([^\n$]+?)\$/g, (_m, inner) => {
    const id = `<!--MATH${seq++}-->`;
    const html = renderKatex(inner.trim(), false);
    placeholders.set(id, html);
    return id;
  });

  // 还原代码围栏
  guarded = guarded.replace(/<!--FENCE(\d+)-->/g, (_m, i) => fences[Number(i)]);

  return { cleaned: guarded, placeholders };
}

/** 调用 KaTeX 渲染,出错时降级为原文（红色提示） */
function renderKatex(latex: string, displayMode: boolean): string {
  try {
    return katex.renderToString(latex, { displayMode, throwOnError: false });
  } catch {
    return `<span style="color:#cc0000" title="KaTeX 渲染失败">${escapeHtml(latex)}</span>`;
  }
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

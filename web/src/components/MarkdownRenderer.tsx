/**
 * Markdown 渲染组件
 *
 * - 基于 renderMarkdown (markdown-it + hljs + KaTeX) 产出 HTML
 * - 后处理：把 <code> 标签内的文件/目录路径转为可点击链接
 * - 点击路径通过 postMessage 通知扩展宿主打开文件
 */

import { useRef, useEffect, useState, useCallback, memo } from "react";
import { renderMarkdown } from "@/lib/markdown";

/** 匹配常见文件/目录路径（Windows 绝对路径、Unix 绝对路径、相对路径） */
const PATH_PATTERN = /(?:[a-zA-Z]:\\[\w.\-\\/ ]+|\/[\w.\-/]+|\.\.?\/[\w.\-/]+)/g;

/** 对 <code>...</code> 内容做路径链接化 */
function linkifyPaths(html: string): string {
  // 只处理 inline code（不在 <pre> 内的 <code>）
  // 匹配 <code>xxx</code>（非贪婪），把其中的路径文本包裹成 <a>
  return html.replace(/<code>([^<]+)<\/code>/g, (match, inner: string) => {
    // 检查内容是否像路径
    const decoded = inner.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
    if (!PATH_PATTERN.test(decoded)) return match;
    PATH_PATTERN.lastIndex = 0;

    // 整个 code 内容就是一个路径：整体做成链接
    const pathText = decoded.trim();
    const encoded = encodeURIComponent(pathText);
    return `<code class="axon-path-link" data-path="${encoded}">${inner}</code>`;
  });
}

/** 给 <table> 包一层可横向滚动的容器，避免宽表在窄面板溢出。 */
function wrapTables(html: string): string {
  return html
    .replace(/<table>/g, '<div class="axon-table-wrap"><table>')
    .replace(/<\/table>/g, "</table></div>");
}

interface MarkdownRendererProps {
  content: string;
}

export const MarkdownRenderer = memo(function MarkdownRenderer({ content }: MarkdownRendererProps) {
  const ref = useRef<HTMLDivElement>(null);
  // 缓存上次渲染的 content 和 html，避免打字机每帧都重新解析 markdown。
  // 流式输出时每 ~100ms 更新一次，视觉上是连续的且不会闪烁。
  const lastContentRef = useRef<string>("");
  const rafRef = useRef<number | null>(null);
  const pendingContentRef = useRef<string>(content);

  // 计算并缓存 html
  const computeHtml = useCallback((text: string): string => {
    return wrapTables(linkifyPaths(renderMarkdown(text)));
  }, []);

  // 初始渲染（content 变化时触发）
  const [html, setHtml] = useState<string>(() => {
    lastContentRef.current = content;
    return computeHtml(content);
  });

  // content 变化时 throttle 更新 html
  useEffect(() => {
    pendingContentRef.current = content;
    // content 未变（React 重渲染但 prop 相同）→ 不处理
    if (content === lastContentRef.current) return;
    // 已有 pending 更新 → 跳过（throttle 中）
    if (rafRef.current !== null) return;

    rafRef.current = window.setTimeout(() => {
      rafRef.current = null;
      const text = pendingContentRef.current;
      lastContentRef.current = text;
      setHtml(computeHtml(text));
    }, 80);
  }, [content, computeHtml]);

  // 卸载时清理
  useEffect(() => {
    return () => {
      if (rafRef.current !== null) {
        clearTimeout(rafRef.current);
        rafRef.current = null;
      }
    };
  }, []);

  // 事件委托：点击路径链接 / 代码块复制按钮
  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const handler = (e: MouseEvent) => {
      // 外部链接点击（http/https）：webview 里 target=_blank 被拦截，需通过 openExternal 打开
      const extLink = (e.target as HTMLElement).closest<HTMLAnchorElement>("a[data-external-link]");
      if (extLink) {
        e.preventDefault();
        const url = extLink.dataset.externalLink || extLink.getAttribute("href") || "";
        if (!url) return;
        const vscode = (window as any).__axonVSCode || (typeof (window as any).acquireVsCodeApi === "function" ? (window as any).acquireVsCodeApi() : null);
        if (vscode) {
          vscode.postMessage({ type: "open_external", url });
        } else {
          // 浏览器形态：直接打开
          window.open(url, "_blank", "noopener,noreferrer");
        }
        return;
      }

      // 路径链接点击
      const pathTarget = (e.target as HTMLElement).closest<HTMLElement>(".axon-path-link");
      if (pathTarget) {
        e.preventDefault();
        const path = decodeURIComponent(pathTarget.dataset.path || "");
        if (!path) return;
        const vscode = (window as any).__axonVSCode || (typeof (window as any).acquireVsCodeApi === "function" ? (window as any).acquireVsCodeApi() : null);
        if (vscode) {
          vscode.postMessage({ type: "open_file", path });
        } else {
          console.log("[axon] open file:", path);
        }
        return;
      }

      // 代码块复制按钮
      const copyBtn = (e.target as HTMLElement).closest<HTMLElement>("[data-copy-code]");
      if (copyBtn) {
        e.preventDefault();
        const codeBlock = copyBtn.closest(".axon-codeblock")?.querySelector("code");
        if (codeBlock) {
          navigator.clipboard.writeText(codeBlock.textContent || "").then(() => {
            const label = copyBtn.querySelector("span");
            if (label) {
              label.textContent = "已复制";
              setTimeout(() => { label.textContent = "复制"; }, 1500);
            }
          });
        }
        return;
      }
    };

    el.addEventListener("click", handler);
    return () => el.removeEventListener("click", handler);
  }, [html]);

  return (
    <div
      ref={ref}
      className="text-[13px] leading-relaxed prose prose-sm dark:prose-invert prose-neutral max-w-none [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_p]:my-1.5 [&_h1]:mt-4 [&_h1]:mb-1.5 [&_h2]:mt-4 [&_h2]:mb-1.5 [&_h3]:mt-3 [&_h3]:mb-1 [&_h4]:mt-2 [&_h4]:mb-1 [&_h5]:mt-2 [&_h5]:mb-1 [&_h6]:mt-1.5 [&_h6]:mb-0.5 [&_ul]:my-1.5 [&_ol]:my-1.5 [&_li]:my-0 [&_li]:py-[2px] [&_li>p]:my-0 [&_ul_ul]:my-1 [&_ol_ol]:my-1 [&_blockquote]:my-2 [&_blockquote]:border-l-[3px] [&_blockquote]:border-blue-400/60 [&_blockquote]:dark:border-blue-500/40 [&_blockquote]:bg-blue-50/50 [&_blockquote]:dark:bg-blue-950/20 [&_blockquote]:rounded-r-md [&_blockquote]:pl-3.5 [&_blockquote]:pr-3 [&_blockquote]:py-2 [&_blockquote]:not-italic [&_blockquote]:text-foreground/85 [&_blockquote]:text-[12.5px] [&_blockquote_p]:my-0.5 [&_pre]:!my-2 [&_hr]:!my-3 [&_:not(pre)>code]:font-mono [&_:not(pre)>code]:bg-[rgba(200,200,200,0.15)] [&_:not(pre)>code]:dark:bg-[rgba(200,200,200,0.13)] [&_:not(pre)>code]:text-[#ab5726] [&_:not(pre)>code]:dark:text-[#e8ab6a] [&_:not(pre)>code]:px-1.5 [&_:not(pre)>code]:py-0.5 [&_:not(pre)>code]:rounded [&_:not(pre)>code]:text-[0.85em] [&_:not(pre)>code]:font-medium [&_:not(pre)>code]:border [&_:not(pre)>code]:border-[rgba(150,150,150,0.25)] [&_:not(pre)>code]:dark:border-[rgba(200,200,200,0.25)] [&_code]:before:content-none [&_code]:after:content-none [&_.axon-path-link]:text-[var(--vscode-textLink-foreground,#3794ff)] [&_.axon-path-link]:cursor-pointer [&_.axon-path-link]:hover:underline [&_.axon-path-link]:bg-transparent"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
});

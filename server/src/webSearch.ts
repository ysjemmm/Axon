/**
 * Web 搜索模块 - Tavily 为主，DuckDuckGo 兜底
 *
 * 返回最多 10 条结果，每条包含 title/url/snippet/domain/date
 */

import https from "node:https";
import http from "node:http";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  domain: string;
  date?: string; // 发布日期（如有）
}

export interface SearchResponse {
  query: string;
  results: SearchResult[];
  source: "tavily" | "duckduckgo"; // 实际用了哪个引擎
}

/** 简单 HTTPS GET/POST 请求封装 */
function httpRequest(url: string, options?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<string> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const isHttps = parsed.protocol === "https:";
    const lib = isHttps ? https : http;
    const req = lib.request(parsed, {
      method: options?.method || "GET",
      headers: options?.headers || {},
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
        } else {
          resolve(data);
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error("请求超时")); });
    if (options?.body) req.write(options.body);
    req.end();
  });
}

/** 从 URL 提取域名 */
function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** Tavily 搜索 */
async function searchTavily(query: string, apiKey: string): Promise<SearchResult[]> {
  const body = JSON.stringify({
    query,
    max_results: 10,
    include_answer: false,
    search_depth: "basic",
  });

  const raw = await httpRequest("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
    body,
  });

  const data = JSON.parse(raw);
  const results: SearchResult[] = (data.results || []).slice(0, 10).map((r: any) => ({
    title: r.title || "",
    url: r.url || "",
    snippet: r.content || "",
    domain: extractDomain(r.url || ""),
    date: r.published_date || undefined,
  }));
  return results;
}

/** DuckDuckGo HTML 搜索（兜底） */
async function searchDuckDuckGo(query: string): Promise<SearchResult[]> {
  const encoded = encodeURIComponent(query);
  const url = `https://html.duckduckgo.com/html/?q=${encoded}`;
  const html = await httpRequest(url, {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
  });

  const results: SearchResult[] = [];
  // 解析 DuckDuckGo HTML 结果（每个结果在 class="result" 的 div 中）
  const resultBlocks = html.split(/class="result\s/g).slice(1);

  for (const block of resultBlocks) {
    if (results.length >= 10) break;
    // 提取标题和 URL
    const linkMatch = block.match(/class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/);
    if (!linkMatch) continue;
    let href = linkMatch[1];
    // DuckDuckGo 的链接可能是重定向 URL，提取实际 URL
    const uddgMatch = href.match(/uddg=([^&]+)/);
    if (uddgMatch) href = decodeURIComponent(uddgMatch[1]);
    const title = linkMatch[2].replace(/<[^>]*>/g, "").trim();
    if (!title || !href) continue;

    // 提取摘要
    const snippetMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
    const snippet = snippetMatch
      ? snippetMatch[1].replace(/<[^>]*>/g, "").trim()
      : "";

    results.push({
      title,
      url: href,
      snippet,
      domain: extractDomain(href),
    });
  }
  return results;
}

/**
 * 执行 web 搜索：Tavily 为主，失败时降级到 DuckDuckGo
 */
export async function webSearch(query: string): Promise<SearchResponse> {
  const tavilyKey = process.env.TAVILY_API_KEY?.trim();

  // 尝试 Tavily
  if (tavilyKey) {
    try {
      const results = await searchTavily(query, tavilyKey);
      if (results.length > 0) {
        return { query, results, source: "tavily" };
      }
    } catch (err) {
      console.warn("[web_search] Tavily 失败，降级到 DuckDuckGo:", (err as Error).message);
    }
  }

  // 降级到 DuckDuckGo
  try {
    const results = await searchDuckDuckGo(query);
    return { query, results, source: "duckduckgo" };
  } catch (err) {
    throw new Error(`搜索失败：Tavily 和 DuckDuckGo 均不可用。${(err as Error).message}`);
  }
}


/**
 * 抓取网页正文内容（纯 HTTP GET + HTML 正文提取）
 * 不支持 JS 渲染的 SPA 页面，这类页面会返回空或很少内容
 */
export async function webFetch(url: string): Promise<{ url: string; title: string; content: string; byteSize: number }> {
  const raw = await httpRequest(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    },
  });

  // 提取 <title>
  const titleMatch = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? titleMatch[1].replace(/\s+/g, " ").trim() : "";

  // 提取正文：移除 script/style/nav/header/footer，然后取 <body> 或全文的文本
  let html = raw;
  // 移除不需要的标签
  html = html.replace(/<script[\s\S]*?<\/script>/gi, "");
  html = html.replace(/<style[\s\S]*?<\/style>/gi, "");
  html = html.replace(/<nav[\s\S]*?<\/nav>/gi, "");
  html = html.replace(/<header[\s\S]*?<\/header>/gi, "");
  html = html.replace(/<footer[\s\S]*?<\/footer>/gi, "");
  html = html.replace(/<!--[\s\S]*?-->/g, "");

  // 取 body 内容
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const bodyHtml = bodyMatch ? bodyMatch[1] : html;

  // HTML → 纯文本
  let text = bodyHtml
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<\/h[1-6]>/gi, "\n\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

  // 清理多余空白
  text = text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();

  // 截断过长内容（保留前 8KB 给 AI，避免撑爆上下文）
  const maxLen = 8000;
  if (text.length > maxLen) {
    text = text.slice(0, maxLen) + "\n\n[内容已截断，共 " + raw.length + " 字节]";
  }

  return { url, title, content: text, byteSize: raw.length };
}

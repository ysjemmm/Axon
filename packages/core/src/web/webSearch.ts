/**
 * Web 搜索/抓取 - Tavily 为主，Bing 兜底（迁自 server/src/webSearch.ts）
 *
 * 仅依赖 node:https/http 与 process.env，跨形态通用（server 与 vscode 扩展宿主均为 Node）。
 * 导出的 webSearch/webFetch 形状即 core 的 WebCapability，可直接注入 AgentSession/SessionHub。
 *
 * 返回最多 10 条结果，每条包含 title/url/snippet/domain/date。
 */

import https from "node:https";
import http from "node:http";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  domain: string;
  date?: string;
}

export interface SearchResponse {
  query: string;
  results: SearchResult[];
  source: "tavily" | "bing";
}

/** 简单 HTTP(S) GET/POST 请求封装（自动跟随最多 5 次 3xx 跳转） */
function httpRequest(
  url: string,
  options?: { method?: string; headers?: Record<string, string>; body?: string },
  redirects = 0,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const isHttps = parsed.protocol === "https:";
    const lib = isHttps ? https : http;
    const req = lib.request(parsed, {
      method: options?.method || "GET",
      headers: options?.headers || {},
    }, (res) => {
      const statusCode = res.statusCode || 0;
      const location = res.headers.location;
      if (statusCode >= 300 && statusCode < 400 && location) {
        res.resume();
        if (redirects >= 5) {
          reject(new Error("重定向次数过多"));
          return;
        }
        const nextUrl = new URL(location, parsed).toString();
        httpRequest(nextUrl, options, redirects + 1).then(resolve, reject);
        return;
      }

      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        if (statusCode >= 400) {
          reject(new Error(`HTTP ${statusCode}: ${data.slice(0, 200)}`));
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

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

async function searchTavily(query: string, apiKey: string): Promise<SearchResult[]> {
  const body = JSON.stringify({ query, max_results: 10, include_answer: false, search_depth: "basic" });
  const raw = await httpRequest("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
    body,
  });
  const data = JSON.parse(raw);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (data.results || []).slice(0, 10).map((r: any) => ({
    title: r.title || "",
    url: r.url || "",
    snippet: r.content || "",
    domain: extractDomain(r.url || ""),
    date: r.published_date || undefined,
  }));
}

/** 从 Bing HTML 搜索页提取结果；不依赖 API Key，作为 Tavily 不可用时的降级方案。 */
async function searchBing(query: string): Promise<SearchResult[]> {
  const encoded = encodeURIComponent(query);
  const url = `https://www.bing.com/search?q=${encoded}&setlang=zh-Hans`;
  const html = await httpRequest(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    },
  });

  const results: SearchResult[] = [];
  // Bing 的每条自然结果均以 b_algo 标识。直接全局匹配标题链接，避免页面里额外的
  // link/style 标签或 class 属性排列变化影响按块切分。
  const resultPattern = /<li[^>]*\bb_algo\b[\s\S]*?<h2[^>]*>[\s\S]*?<a\b[^>]*\bhref="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h2>[\s\S]*?(?=<li[^>]*\bb_algo\b|<\/ol>)/gi;
  for (const match of html.matchAll(resultPattern)) {
    if (results.length >= 10) break;
    const href = match[1];
    const title = match[2].replace(/<[^>]*>/g, "").trim();
    if (!title || !href) continue;
    const snippetMatch = match[0].match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const snippet = snippetMatch ? snippetMatch[1].replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim() : "";
    results.push({ title, url: href, snippet, domain: extractDomain(href) });
  }
  return results;
}

/** 执行 web 搜索：Tavily 为主，失败降级 Bing */
export async function webSearch(query: string): Promise<SearchResponse> {
  const tavilyKey = process.env.TAVILY_API_KEY?.trim();
  if (tavilyKey) {
    try {
      const results = await searchTavily(query, tavilyKey);
      if (results.length > 0) return { query, results, source: "tavily" };
    } catch (err) {
      console.warn("[web_search] Tavily 失败，降级到 Bing:", (err as Error).message);
    }
  }
  try {
    const results = await searchBing(query);
    return { query, results, source: "bing" };
  } catch (err) {
    throw new Error(`搜索失败：Tavily 和 Bing 均不可用。${(err as Error).message}`);
  }
}

/** 抓取网页正文（纯 HTTP GET + HTML 正文提取；不支持 JS 渲染 SPA） */
export async function webFetch(url: string): Promise<{ url: string; title: string; content: string; byteSize: number }> {
  const raw = await httpRequest(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    },
  });

  const titleMatch = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? titleMatch[1].replace(/\s+/g, " ").trim() : "";

  let html = raw;
  html = html.replace(/<script[\s\S]*?<\/script>/gi, "");
  html = html.replace(/<style[\s\S]*?<\/style>/gi, "");
  html = html.replace(/<nav[\s\S]*?<\/nav>/gi, "");
  html = html.replace(/<header[\s\S]*?<\/header>/gi, "");
  html = html.replace(/<footer[\s\S]*?<\/footer>/gi, "");
  html = html.replace(/<!--[\s\S]*?-->/g, "");

  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const bodyHtml = bodyMatch ? bodyMatch[1] : html;

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

  text = text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();

  const maxLen = 8000;
  if (text.length > maxLen) {
    text = text.slice(0, maxLen) + "\n\n[内容已截断，共 " + raw.length + " 字节]";
  }

  return { url, title, content: text, byteSize: raw.length };
}

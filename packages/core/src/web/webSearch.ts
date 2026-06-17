/**
 * Web 搜索/抓取 - Tavily 为主，DuckDuckGo 兜底（迁自 server/src/webSearch.ts）
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
  source: "tavily" | "duckduckgo";
}

/** 简单 HTTP(S) GET/POST 请求封装 */
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

async function searchDuckDuckGo(query: string): Promise<SearchResult[]> {
  const encoded = encodeURIComponent(query);
  const url = `https://html.duckduckgo.com/html/?q=${encoded}`;
  const html = await httpRequest(url, {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
  });

  const results: SearchResult[] = [];
  const resultBlocks = html.split(/class="result\s/g).slice(1);
  for (const block of resultBlocks) {
    if (results.length >= 10) break;
    const linkMatch = block.match(/class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/);
    if (!linkMatch) continue;
    let href = linkMatch[1];
    const uddgMatch = href.match(/uddg=([^&]+)/);
    if (uddgMatch) href = decodeURIComponent(uddgMatch[1]);
    const title = linkMatch[2].replace(/<[^>]*>/g, "").trim();
    if (!title || !href) continue;
    const snippetMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
    const snippet = snippetMatch ? snippetMatch[1].replace(/<[^>]*>/g, "").trim() : "";
    results.push({ title, url: href, snippet, domain: extractDomain(href) });
  }
  return results;
}

/** 执行 web 搜索：Tavily 为主，失败降级 DuckDuckGo */
export async function webSearch(query: string): Promise<SearchResponse> {
  const tavilyKey = process.env.TAVILY_API_KEY?.trim();
  if (tavilyKey) {
    try {
      const results = await searchTavily(query, tavilyKey);
      if (results.length > 0) return { query, results, source: "tavily" };
    } catch (err) {
      console.warn("[web_search] Tavily 失败，降级到 DuckDuckGo:", (err as Error).message);
    }
  }
  try {
    const results = await searchDuckDuckGo(query);
    return { query, results, source: "duckduckgo" };
  } catch (err) {
    throw new Error(`搜索失败：Tavily 和 DuckDuckGo 均不可用。${(err as Error).message}`);
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

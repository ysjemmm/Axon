/**
 * 内联代码补全提供者
 *
 * 删除 extensions/copilot 后不再有 InlineCompletionItemProvider 注册，
 * 本模块在 axon-ide 扩展中提供一个基于 LLM 的内联补全实现。
 *
 * 原理：获取光标前后上下文 → 构造 FIM prompt → 调 LLM → 返回补全文本。
 * 使用聊天补全 API（chat/completions），兼容所有 OpenAI 兼容的 provider。
 */

import * as vscode from "vscode";
import { getClient, getResolvedProviders } from "@axon/core";

// ── 配置 ──────────────────────────────────────────────────────────────────

interface InlineCompletionConfig {
  enabled: boolean;
  provider: string;
  model: string;
  maxPrefixLines: number;
  maxSuffixLines: number;
  maxTokens: number;
  temperature: number;
}

function getConfig(): InlineCompletionConfig {
  const c = vscode.workspace.getConfiguration("axon.inlineCompletion");
  return {
    enabled: c.get<boolean>("enabled", true),
    provider: c.get<string>("provider", ""),
    model: c.get<string>("model", ""),
    maxPrefixLines: c.get<number>("maxPrefixLines", 80),
    maxSuffixLines: c.get<number>("maxSuffixLines", 30),
    maxTokens: c.get<number>("maxTokens", 128),
    temperature: c.get<number>("temperature", 0.1),
  };
}

// ── 上下文提取 ────────────────────────────────────────────────────────────

/** 取光标前最多 maxLines 行的文本 */
function getPrefix(
  document: vscode.TextDocument,
  position: vscode.Position,
  maxLines: number,
): string {
  const startLine = Math.max(0, position.line - maxLines);
  const range = new vscode.Range(
    startLine, 0,
    position.line, position.character,
  );
  return document.getText(range);
}

/** 取光标后最多 maxLines 行的文本 */
function getSuffix(
  document: vscode.TextDocument,
  position: vscode.Position,
  maxLines: number,
): string {
  const endLine = Math.min(document.lineCount - 1, position.line + maxLines);
  const range = new vscode.Range(
    position.line, position.character,
    endLine, document.lineAt(endLine).text.length,
  );
  return document.getText(range);
}

// ── Prompt 构造 ───────────────────────────────────────────────────────────

function buildMessages(
  document: vscode.TextDocument,
  prefix: string,
  suffix: string,
) {
  const language = document.languageId;
  const fileName = document.fileName.split(/[/\\]/).pop() || "";

  const userContent = [
    `File: ${fileName}  ·  Language: ${language}`,
    "",
    "```" + (language || ""),
    prefix + "<CURSOR>" + suffix,
    "```",
  ].join("\n");

  return [
    {
      role: "system" as const,
      content:
        "You are a code completion engine. Your ONLY output is raw code to insert at <CURSOR>. " +
        "No markdown fences. No explanation. No greeting. Just the code.",
    },
    { role: "user" as const, content: userContent },
  ];
}

// ── 默认 provider 探测 ───────────────────────────────────────────────────

/** 探测第一个可用的 provider：优先已解析列表（apiKey 非空且至少有一个未禁用模型），兜底 env */
function detectProvider(): string {
  const resolved = getResolvedProviders();
  const first = resolved.find((p) => p.configured && p.models.some((m) => !m.disabled));
  if (first) return first.name;

  for (const k of Object.keys(process.env)) {
    const m = k.match(/^PROVIDER_(\w+)_API_KEY$/);
    if (m && process.env[k]) return m[1].toLowerCase();
  }

  return "";
}

/** 探测指定 provider 的第一个可用模型（优先级：gpt-5.5 → gpt-5.4，跳过推理模型，兜底 gpt-5.5） */
function detectModel(providerName: string): string {
  const resolved = getResolvedProviders();
  const p = resolved.find((r) => r.name === providerName);
  const enabled = (p?.models || []).filter((m) => !m.disabled);
  const priority = [/gpt-5\.5/i, /gpt-5\.4/i];
  for (const re of priority) {
    const hit = enabled.find((m) => re.test(m.id) && !/v4-pro|reasoner/i.test(m.id));
    if (hit) return hit.id;
  }
  return "gpt-5.5";
}

// ── 主入口 ────────────────────────────────────────────────────────────────

export function registerInlineCompletion(context: vscode.ExtensionContext): void {
  const cfg = getConfig();
  if (!cfg.enabled) return;

  const provider: vscode.InlineCompletionItemProvider = {
    async provideInlineCompletionItems(document, position, ctx, token) {
      if (token.isCancellationRequested) return [];

      const cfg = getConfig();
      if (!cfg.enabled) return [];

      const providerName = cfg.provider || detectProvider();
      if (!providerName) return [];

      // 至少要有一定量的前置上下文才触发
      const prefix = getPrefix(document, position, cfg.maxPrefixLines);
      if (prefix.length < 3) return [];

      const lineText = document.lineAt(position.line).text;
      const textBeforeCursor = lineText.slice(0, position.character);
      if (!textBeforeCursor.trim() && prefix.endsWith("\n\n")) return [];

      let client;
      try {
        client = getClient(providerName);
      } catch (err) {
        console.error("[axon] inline completion: getClient failed:", err);
        return [];
      }

      const suffix = getSuffix(document, position, cfg.maxSuffixLines);
      const modelName = cfg.model || detectModel(providerName);

      if (!modelName) return [];

      const messages = buildMessages(document, prefix, suffix);

      // 推理模型（deepseek-v4-pro 等）的 reasoning_tokens 计入 max_tokens 总额，
      // 默认 128 不够分 → 加大到 512 确保 content 有空间
      const isReasoner = /v4-pro|reasoner/i.test(modelName);
      const maxTok = isReasoner ? Math.max(cfg.maxTokens, 512) : cfg.maxTokens;

      const abortController = new AbortController();
      const disposable = token.onCancellationRequested(() =>
        abortController.abort(),
      );

      try {
        const response = await client.chat.completions.create(
          {
            model: modelName,
            messages,
            temperature: cfg.temperature,
            max_tokens: maxTok,
            stop: ["\n\n\n", "```", "<CURSOR>", "Note:", "Explanation:"],
          },
          { signal: abortController.signal },
        );

        const completion = response.choices[0]?.message?.content;
        if (!completion?.trim()) return [];

        const cleaned = cleanCompletion(completion, prefix, suffix);
        if (!cleaned) return [];

        const range = new vscode.Range(position, position);
        return [new vscode.InlineCompletionItem(cleaned, range)];
      } catch (err: unknown) {
        const e = err as { name?: string; message?: string; status?: number };
        // 用户继续打字 → 正常取消，不打日志
        if (e.name?.includes("Abort") || e.message?.includes("aborted")) return [];
        // 503 → 网关临时不可用，静默跳过
        if (e.status === 503) return [];
        console.error("[axon] inline completion error:", e.message || err);
        return [];
      } finally {
        disposable.dispose();
      }
    },
  };

  context.subscriptions.push(
    vscode.languages.registerInlineCompletionItemProvider(
      { pattern: "**" },
      provider,
    ),
  );
}

// ── 补全结果清理 ─────────────────────────────────────────────────────────

/**
 * 清理模型返回的补全文本：
 * - 剥离 markdown fences（```typescript ... ```）
 * - 去掉 "The missing code is..." / "Here is the completion:" 等废话
 * - 去掉与 suffix 重复的尾部、与 prefix 重叠的前缀
 */
function cleanCompletion(
  completion: string,
  prefix: string,
  suffix: string,
): string {
  let text = completion;

  // 1) 剥离 markdown fences：取出第一个 ``` 块内的内容
  const fenceMatch = text.match(/```[^\n]*\n([\s\S]*?)```/);
  if (fenceMatch) {
    text = fenceMatch[1];
  } else {
    // 可能只有开头 ``` 没有结尾 ```，去掉首行的 ```
    text = text.replace(/^```[^\n]*\n?/m, "").replace(/```$/, "");
  }

  // 2) 去掉常见的废话前缀和尾部
  const fluffPrefixes = [
    /^The missing code is:?\s*/i,
    /^Here is the completion:?\s*/i,
    /^The completed code:?\s*/i,
    /^The completion:?\s*/i,
    /^Completion:?\s*/i,
    /^Here['']s the code:?\s*/i,
  ];
  for (const re of fluffPrefixes) {
    text = text.replace(re, "");
  }
  // 去掉尾部废话（如 "Explanation: ..." 等——用换行切断）
  const cutoff = /\n\s*\n\s*(Explanation|Note|This code|The above|Here)/i;
  const cutIdx = text.search(cutoff);
  if (cutIdx >= 0) text = text.slice(0, cutIdx);

  text = text.trim();

  // 3) 去掉 prefix 尾部重叠（模型有时把 prefix 也输出了）
  const prefixTail = prefix.slice(-50);
  const idx = text.indexOf(prefixTail);
  if (idx >= 0 && idx < 100) {
    text = text.slice(idx + prefixTail.length);
  }

  // 4) 如果补全以 suffix 开头的内容结尾，截断
  if (suffix && text) {
    const suffixHead = suffix.slice(0, 50).split("\n")[0];
    if (suffixHead.length >= 3) {
      const endIdx = text.indexOf(suffixHead);
      if (endIdx > 0) {
        text = text.slice(0, endIdx).trimEnd();
      }
    }
  }

  return text.trim();
}

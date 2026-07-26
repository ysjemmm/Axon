import { describe, it, expect } from "vitest";
import {
  emptyRawUsage,
  mergeRawUsage,
  normalizeAnthropicUsage,
  estimateTokensFromText,
  estimateAnthropicPromptTokens,
} from "./anthropicUsage.js";

describe("mergeRawUsage", () => {
  it("message_delta 只带 output_tokens 时，不清空 message_start 拿到的 input", () => {
    const raw = emptyRawUsage();
    mergeRawUsage(raw, { input_tokens: 12000, output_tokens: 1 }, true);
    mergeRawUsage(raw, { output_tokens: 350 });
    expect(raw.inputTokens).toBe(12000);
    expect(raw.outputTokens).toBe(350);
  });

  it("回归：delta 回显 cache_read 但不回显 input_tokens，缓存部分不再被累加两次", () => {
    // 老实现：promptTokens = (message_start 算出的 input+cacheRead) + cacheRead → 15000
    const raw = emptyRawUsage();
    mergeRawUsage(raw, { input_tokens: 1000, cache_read_input_tokens: 7000 }, true);
    mergeRawUsage(raw, { cache_read_input_tokens: 7000, output_tokens: 200 });
    expect(raw.inputTokens).toBe(1000);
    expect(raw.cacheReadTokens).toBe(7000);
    expect(normalizeAnthropicUsage(raw)?.promptTokens).toBe(8000);
  });

  it("usage 是累计值而非增量：后到的 output 覆盖先到的", () => {
    const raw = emptyRawUsage();
    mergeRawUsage(raw, { output_tokens: 100 });
    mergeRawUsage(raw, { output_tokens: 420 });
    expect(raw.outputTokens).toBe(420);
  });

  it("没收到任何 usage 时 seen=false，归一化返回 undefined", () => {
    const raw = emptyRawUsage();
    mergeRawUsage(raw, undefined);
    mergeRawUsage(raw, { input_tokens: 0 });
    expect(raw.seen).toBe(false);
    expect(normalizeAnthropicUsage(raw)).toBeUndefined();
  });

  it("只有 message_start 才留档原值，delta 不覆盖判别依据", () => {
    const raw = emptyRawUsage();
    mergeRawUsage(raw, { input_tokens: 0, cache_creation_input_tokens: 2933 }, true);
    mergeRawUsage(raw, { input_tokens: 8448 });
    expect(raw.startInputTokens).toBe(0);
    expect(raw.startCacheTotal).toBe(2933);
    expect(raw.inputTokens).toBe(8448);
  });
});

describe("normalizeAnthropicUsage", () => {
  it("无缓存字段：input_tokens 即上下文占用", () => {
    const raw = emptyRawUsage();
    mergeRawUsage(raw, { input_tokens: 9000, output_tokens: 300 }, true);
    const u = normalizeAnthropicUsage(raw)!;
    expect(u.semantics).toBe("plain");
    expect(u.promptTokens).toBe(9000);
    expect(u.totalTokens).toBe(9300);
  });

  it("Anthropic 原生语义（message_start 给出真实 input）：相加", () => {
    const raw = emptyRawUsage();
    mergeRawUsage(raw, { input_tokens: 800, cache_read_input_tokens: 40000, cache_creation_input_tokens: 1200 }, true);
    mergeRawUsage(raw, { output_tokens: 500 });
    const u = normalizeAnthropicUsage(raw)!;
    expect(u.semantics).toBe("additive");
    expect(u.promptTokens).toBe(42000);
    expect(u.cachedTokens).toBe(40000);
  });

  it("确定性证据：message_start 报了缓存却给 input_tokens=0 → 用缓存字段合计", () => {
    const raw = emptyRawUsage();
    mergeRawUsage(raw, { input_tokens: 0, cache_read_input_tokens: 2933, cache_creation_input_tokens: 67 }, true);
    mergeRawUsage(raw, { input_tokens: 8448, output_tokens: 1 });
    const u = normalizeAnthropicUsage(raw)!;
    expect(u.semantics).toBe("cache_only");
    expect(u.promptTokens).toBe(3000);
    expect(u.totalTokens).toBe(3001);
  });

  it("没有 message_start（只有 delta）时不敢下判断，按协议规范相加", () => {
    const raw = emptyRawUsage();
    mergeRawUsage(raw, { input_tokens: 42000, cache_read_input_tokens: 40000 });
    const u = normalizeAnthropicUsage(raw)!;
    expect(u.semantics).toBe("additive");
    expect(u.promptTokens).toBe(82000);
  });
});

/**
 * 回归护栏：规范端点（message_start 给出真实 input_tokens）必须永远走 additive。
 *
 * 判别刻意不使用任何 token 估算——曾经试过"additive 超出本地粗估 N 倍就换解释"的兜底，
 * 就是被这组用例打掉的：粗估只要异常偏小（多图按固定量级折算、代码/JSON 密度高于系数），
 * 就会把规范端点的正确值替换成离谱的小值。这组用例锁住"不误伤"这个性质。
 */
describe("不误伤规范端点", () => {
  const conforming = (input: number, cacheRead: number, cacheCreation = 0) => {
    const raw = emptyRawUsage();
    mergeRawUsage(raw, {
      input_tokens: input,
      cache_read_input_tokens: cacheRead,
      cache_creation_input_tokens: cacheCreation,
    }, true);
    return raw;
  };

  it("input 与缓存各占一半：相加", () => {
    const u = normalizeAnthropicUsage(conforming(20000, 20000))!;
    expect(u.semantics).toBe("additive");
    expect(u.promptTokens).toBe(40000);
  });

  it("缓存命中占绝大多数（input 很小）：相加", () => {
    const u = normalizeAnthropicUsage(conforming(500, 100000))!;
    expect(u.semantics).toBe("additive");
    expect(u.promptTokens).toBe(100500);
  });

  it("缓存占比很小：相加", () => {
    const u = normalizeAnthropicUsage(conforming(20000, 1000))!;
    expect(u.semantics).toBe("additive");
    expect(u.promptTokens).toBe(21000);
  });

  it("三段齐全：相加", () => {
    const u = normalizeAnthropicUsage(conforming(3000, 30000, 500))!;
    expect(u.semantics).toBe("additive");
    expect(u.promptTokens).toBe(33500);
  });

  it("无缓存字段的端点（chat 式中转站等）：行为与改动前一致，就是 input_tokens", () => {
    const raw = emptyRawUsage();
    mergeRawUsage(raw, { input_tokens: 9000, output_tokens: 300 }, true);
    const u = normalizeAnthropicUsage(raw)!;
    expect(u.semantics).toBe("plain");
    expect(u.promptTokens).toBe(9000);
  });

  it("input_tokens 各量级扫描：只要 message_start 报了真实 input，一律相加", () => {
    for (const input of [1, 100, 5000, 50000, 500000]) {
      const u = normalizeAnthropicUsage(conforming(input, 30000))!;
      expect(u.semantics).toBe("additive");
      expect(u.promptTokens).toBe(input + 30000);
    }
  });
});

/**
 * 真实抓包回归：Axon 官方中转站（direct.sunnorthgod.top）实测数据。
 * 同一组请求（system 填充 ≈2933 token，每轮多一问一答 ≈+67 token）在两档模型上的返回。
 * 判据：上下文应从 ~2933 起、每轮 +67 平稳增长；老公式在回合 2 会从 2019 跳到 4909。
 */
describe("真实中转站样本回归", () => {
  const contextOf = (turn: { cacheCreation: number; cacheRead: number; delta: Record<string, number | undefined> }) => {
    const raw = emptyRawUsage();
    // 实测 message_start 的 input_tokens 恒为 0，缓存字段却非 0 —— 确定性证据
    mergeRawUsage(raw, {
      input_tokens: 0,
      cache_creation_input_tokens: turn.cacheCreation,
      cache_read_input_tokens: turn.cacheRead,
    }, true);
    mergeRawUsage(raw, turn.delta);
    return normalizeAnthropicUsage(raw)!;
  };

  it("gpt-5.6-sol：4 个回合平稳 +67，不再出现回合 2 的暴涨", () => {
    const turns = [
      { cacheCreation: 2933, cacheRead: 0, delta: { input_tokens: 2019, cache_creation_input_tokens: 2933, output_tokens: 1 }, want: 2933 },
      { cacheCreation: 67, cacheRead: 2933, delta: { input_tokens: 1976, cache_creation_input_tokens: 67, cache_read_input_tokens: 2933, output_tokens: 1 }, want: 3000 },
      { cacheCreation: 67, cacheRead: 3000, delta: { input_tokens: 1933, cache_creation_input_tokens: 67, cache_read_input_tokens: 3000, output_tokens: 1 }, want: 3067 },
      { cacheCreation: 67, cacheRead: 3067, delta: { input_tokens: 1890, cache_creation_input_tokens: 67, cache_read_input_tokens: 3067, output_tokens: 1 }, want: 3134 },
    ];
    const got = turns.map((t) => contextOf(t).promptTokens);
    expect(got).toEqual(turns.map((t) => t.want));
    // 每轮增量都应该是小额（约 +67），而不是翻倍式跳变
    for (let i = 1; i < got.length; i++) expect(got[i]! - got[i - 1]!).toBeLessThan(200);
  });

  it("claude-sonnet-5：input_tokens 高达 8448 也不被误当成上下文", () => {
    const turns = [
      { cacheCreation: 2933, cacheRead: 0, delta: { input_tokens: 8448, cache_creation_input_tokens: 2933, output_tokens: 1 }, want: 2933 },
      { cacheCreation: 67, cacheRead: 2933, delta: { input_tokens: 8402, cache_creation_input_tokens: 67, cache_read_input_tokens: 2933, output_tokens: 1 }, want: 3000 },
      { cacheCreation: 67, cacheRead: 3000, delta: { input_tokens: 8356, cache_creation_input_tokens: 67, cache_read_input_tokens: 3000, output_tokens: 1 }, want: 3067 },
    ];
    for (const t of turns) {
      const u = contextOf(t);
      expect(u.semantics).toBe("cache_only");
      expect(u.promptTokens).toBe(t.want);
    }
  });
});

/** 估算只用于诊断日志，不参与判别；这里只保证它量级合理、不被 base64 撑爆 */
describe("estimate（仅用于诊断日志）", () => {
  it("中文比同等字符数的英文估得更高", () => {
    const cn = estimateTokensFromText("上下文占比统计".repeat(50));
    const en = estimateTokensFromText("context ratio".repeat(50));
    expect(cn).toBeGreaterThan(0);
    expect(cn / 350).toBeGreaterThan(en / 650);
  });

  it("图片按固定量级折算，不被 base64 长度撑爆", () => {
    const withImage = estimateAnthropicPromptTokens("", [
      { role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "A".repeat(200000) } }] },
    ], []);
    expect(withImage).toBeLessThan(3000);
  });

  it("估算覆盖 system / 文本块 / 工具结果 / 工具定义", () => {
    const est = estimateAnthropicPromptTokens(
      "you are a helpful assistant",
      [
        { role: "user", content: "hello world" },
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read_file", input: { path: "a.ts" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "x".repeat(400) }] },
      ],
      [{ name: "read_file", description: "read a file", input_schema: { type: "object" } }],
    );
    expect(est).toBeGreaterThan(120);
  });
});

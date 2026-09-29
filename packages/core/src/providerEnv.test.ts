import { describe, expect, it } from "vitest";
import { providerEnvKeys, stripProviderEnvLines } from "./providerEnv.js";

describe("providerEnvKeys", () => {
  it("生成大写键名，且对名称大小写不敏感", () => {
    expect(providerEnvKeys("zhipu")).toEqual(["PROVIDER_ZHIPU_API_KEY", "PROVIDER_ZHIPU_BASE_URL"]);
    expect(providerEnvKeys("ZhiPu")).toEqual(["PROVIDER_ZHIPU_API_KEY", "PROVIDER_ZHIPU_BASE_URL"]);
    expect(providerEnvKeys("  zhipu  ")).toEqual(["PROVIDER_ZHIPU_API_KEY", "PROVIDER_ZHIPU_BASE_URL"]);
  });
});

describe("stripProviderEnvLines：从 .env 摘掉某 provider", () => {
  const sample = [
    "# eSign Provider",
    "PROVIDER_ESIGN_API_KEY=sk-aaa",
    "PROVIDER_ESIGN_BASE_URL=https://a.example/v1",
    "",
    "# Zhipu Provider (GLM-4)",
    "PROVIDER_ZHIPU_API_KEY=d70c232899dd423c8a794628b2f40911.5GgP33ZtVWwLRjpY",
    "PROVIDER_ZHIPU_BASE_URL=https://open.bigmodel.cn/api/paas/v4",
    "",
    "# 默认",
    "DEFAULT_PROVIDER=esign",
  ].join("\n");

  it("移除该 provider 的两行，其它内容与顺序完全保留", () => {
    const { text, removed } = stripProviderEnvLines(sample, "zhipu");
    expect(removed).toEqual(["PROVIDER_ZHIPU_API_KEY", "PROVIDER_ZHIPU_BASE_URL"]);
    expect(text).not.toContain("ZHIPU");
    // 注释、空行、别的 provider、默认项都还在
    expect(text).toContain("# Zhipu Provider (GLM-4)"); // 注释保留（它不匹配 KEY=）
    expect(text).toContain("PROVIDER_ESIGN_API_KEY=sk-aaa");
    expect(text).toContain("DEFAULT_PROVIDER=esign");
    expect(text.split("\n").length).toBe(sample.split("\n").length - 2);
  });

  it("不误伤同前缀的其它 provider（ESIGN 不受影响）", () => {
    const { text } = stripProviderEnvLines(sample, "esign");
    expect(text).not.toContain("PROVIDER_ESIGN");
    expect(text).toContain("PROVIDER_ZHIPU_API_KEY");
  });

  it("名称大小写不敏感", () => {
    expect(stripProviderEnvLines(sample, "ZHIPU").removed).toHaveLength(2);
    expect(stripProviderEnvLines(sample, "ZhiPu").removed).toHaveLength(2);
  });

  it("容忍键名两侧空格与不同行尾（CRLF 原样保留）", () => {
    const crlf = ["PROVIDER_X_API_KEY=1", "  PROVIDER_X_BASE_URL =https://x/", "OTHER=1"].join("\r\n");
    const { text, removed } = stripProviderEnvLines(crlf, "x");
    expect(removed).toEqual(["PROVIDER_X_API_KEY", "PROVIDER_X_BASE_URL"]);
    expect(text).toBe("OTHER=1");
    // 有 CRLF 时不得把整篇改成 LF
    const both = ["A=1", "PROVIDER_Y_API_KEY=2", "B=3"].join("\r\n");
    expect(stripProviderEnvLines(both, "y").text).toBe(["A=1", "B=3"].join("\r\n"));
  });

  it("未命中时原样返回（连行尾都不动），避免无谓重写", () => {
    const { text, removed } = stripProviderEnvLines(sample, "not-there");
    expect(removed).toEqual([]);
    expect(text).toBe(sample);
  });

  it("忽略注释行里的同名内容（只删真正的 KEY= 行）", () => {
    const txt = "# PROVIDER_Z_API_KEY=commented\nPROVIDER_Z_API_KEY=real\n";
    const { text, removed } = stripProviderEnvLines(txt, "z");
    expect(removed).toEqual(["PROVIDER_Z_API_KEY"]);
    expect(text).toContain("# PROVIDER_Z_API_KEY=commented");
    expect(text).not.toContain("=real");
  });

  it("空文本安全", () => {
    expect(stripProviderEnvLines("", "zhipu")).toEqual({ text: "", removed: [] });
  });
});

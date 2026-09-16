/**
 * Provider model id 唯一性校验的测试矩阵。
 *
 * 约束：同一个 provider 内不能出现重复的 model id（见 providerModels.ts 顶部注释）。
 * 覆盖：id 归一化、重复检出（顺序/去重/空 id/非字符串/大小写）、断言抛错信息、
 * 解析兜底去重（保留首条、不改动入参）。
 */

import { describe, it, expect } from "vitest";
import {
  normalizeModelId,
  findDuplicateModelIds,
  hasDuplicateModelIds,
  assertUniqueModelIds,
  dedupeModelsById,
} from "../src/providerModels";

/** 造一条最小模型记录 */
const m = (id: unknown) => ({ id, name: String(id) });

describe("normalizeModelId", () => {
  it("去掉首尾空白", () => {
    expect(normalizeModelId("  gpt-4o  ")).toBe("gpt-4o");
  });

  it("保持大小写不做折叠（部分端点区分大小写）", () => {
    expect(normalizeModelId("GPT-4o")).toBe("GPT-4o");
  });

  it("非字符串一律归一化为空串", () => {
    expect(normalizeModelId(undefined)).toBe("");
    expect(normalizeModelId(null)).toBe("");
    expect(normalizeModelId(123)).toBe("");
    expect(normalizeModelId({})).toBe("");
  });
});

describe("findDuplicateModelIds", () => {
  it("无重复返回空数组", () => {
    expect(findDuplicateModelIds([m("a"), m("b"), m("c")])).toEqual([]);
  });

  it("检出重复 id", () => {
    expect(findDuplicateModelIds([m("gpt-4o"), m("claude-opus-5"), m("gpt-4o")])).toEqual(["gpt-4o"]);
  });

  it("多个重复项按首次重复出现的顺序列出，每个只列一次", () => {
    expect(findDuplicateModelIds([m("b"), m("a"), m("b"), m("a"), m("b")])).toEqual(["b", "a"]);
  });

  it("忽略空白差异造成的重复（trim 后相同即算重复）", () => {
    expect(findDuplicateModelIds([m("gpt-4o"), m(" gpt-4o ")])).toEqual(["gpt-4o"]);
  });

  it("大小写不同不算重复", () => {
    expect(findDuplicateModelIds([m("gpt-4o"), m("GPT-4o")])).toEqual([]);
  });

  it("空 id 不参与判定（无法标识模型，由必填校验负责）", () => {
    expect(findDuplicateModelIds([m(""), m("   "), m(""), m(undefined)])).toEqual([]);
  });

  it("undefined / null / 空数组返回空数组", () => {
    expect(findDuplicateModelIds(undefined)).toEqual([]);
    expect(findDuplicateModelIds(null)).toEqual([]);
    expect(findDuplicateModelIds([])).toEqual([]);
  });
});

describe("hasDuplicateModelIds", () => {
  it("有重复为 true，无重复为 false", () => {
    expect(hasDuplicateModelIds([m("a"), m("a")])).toBe(true);
    expect(hasDuplicateModelIds([m("a"), m("b")])).toBe(false);
    expect(hasDuplicateModelIds(undefined)).toBe(false);
  });
});

describe("assertUniqueModelIds", () => {
  it("id 唯一时不抛错", () => {
    expect(() => assertUniqueModelIds([m("a"), m("b")], "my-endpoint")).not.toThrow();
    expect(() => assertUniqueModelIds(undefined, "my-endpoint")).not.toThrow();
    expect(() => assertUniqueModelIds([], "my-endpoint")).not.toThrow();
  });

  it("有重复时抛错，信息含 provider 名与重复 id", () => {
    expect(() => assertUniqueModelIds([m("gpt-4o"), m("gpt-4o")], "my-endpoint"))
      .toThrow(/provider「my-endpoint」下已存在模型 id 「gpt-4o」/);
  });

  it("多个重复 id 一并列出", () => {
    expect(() => assertUniqueModelIds([m("a"), m("b"), m("a"), m("b")], "p"))
      .toThrow(/「a」、「b」/);
  });

  it("未传 provider 名时用「该 provider」兜底表述", () => {
    expect(() => assertUniqueModelIds([m("a"), m("a")])).toThrow(/该 provider 下已存在模型 id/);
  });
});

describe("dedupeModelsById", () => {
  it("保留首次出现的那条", () => {
    const first = { id: "gpt-4o", name: "先登记的" };
    const later = { id: "gpt-4o", name: "后登记的" };
    expect(dedupeModelsById([first, later])).toEqual([first]);
  });

  it("保持其余元素的原有顺序", () => {
    expect(dedupeModelsById([m("c"), m("a"), m("c"), m("b")]).map((x) => x.id)).toEqual(["c", "a", "b"]);
  });

  it("trim 后相同视为同一条", () => {
    expect(dedupeModelsById([m("gpt-4o"), m(" gpt-4o ")]).map((x) => x.id)).toEqual(["gpt-4o"]);
  });

  it("空 id 的条目原样保留、互不合并", () => {
    expect(dedupeModelsById([m(""), m(""), m("a")])).toHaveLength(3);
  });

  it("不修改入参", () => {
    const input = [m("a"), m("a")];
    dedupeModelsById(input);
    expect(input).toHaveLength(2);
  });

  it("undefined / null 返回空数组", () => {
    expect(dedupeModelsById(undefined)).toEqual([]);
    expect(dedupeModelsById(null)).toEqual([]);
  });
});

/**
 * Responses status 归一化回归测试。
 *
 * 目的：把历史根因用测试锁死——Responses 的 `failed` 绝不能再被当作正常 `stop`/`complete`。
 * 覆盖 mapResponsesStatusToFinishReason（协议 status -> 原始 finishReason）
 * 与 normalizeFinishReason（原始 finishReason -> 产品语义）串联后的最终语义。
 */

import { describe, it, expect } from "vitest";
import {
  mapResponsesStatusToFinishReason,
  normalizeFinishReason,
} from "./finishReasonMapper.js";

describe("mapResponsesStatusToFinishReason", () => {
  it("completed -> stop", () => {
    expect(mapResponsesStatusToFinishReason("completed")).toBe("stop");
  });

  it("incomplete -> length", () => {
    expect(mapResponsesStatusToFinishReason("incomplete")).toBe("length");
  });

  it("failed -> error（根因：绝不冒充正常完成）", () => {
    expect(mapResponsesStatusToFinishReason("failed")).toBe("error");
  });

  it("未知/缺失 status -> error（保守）", () => {
    expect(mapResponsesStatusToFinishReason(undefined)).toBe("error");
    expect(mapResponsesStatusToFinishReason(null)).toBe("error");
    expect(mapResponsesStatusToFinishReason("weird_status")).toBe("error");
  });
});

describe("Responses status 串联归一化后的产品语义", () => {
  it("completed 最终归为 complete", () => {
    expect(normalizeFinishReason(mapResponsesStatusToFinishReason("completed"))).toBe("complete");
  });

  it("incomplete 最终归为 truncated（需续写，而非正常完成）", () => {
    expect(normalizeFinishReason(mapResponsesStatusToFinishReason("incomplete"))).toBe("truncated");
  });

  it("failed 最终归为 error（绝不等于 complete）", () => {
    const normalized = normalizeFinishReason(mapResponsesStatusToFinishReason("failed"));
    expect(normalized).toBe("error");
    expect(normalized).not.toBe("complete");
  });
});

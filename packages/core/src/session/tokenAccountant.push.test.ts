/**
 * TokenAccountant「只重算」与「重算并推送」必须分离的回归测试
 *
 * 锁死一个真实发生过的问题：用户点击「手动压缩」后，上下文占用率突然降低
 * （实测 39% → 26%），紧接着却提示「未超过 35%，无需压缩」；问一句话又回到 39%。
 *
 * 根因：占用值 = 本地估算 × 校准系数，而校准系数会被端点每轮实报数改写（区间 0.5~2.5，
 * 超区间还会重置为 1）。compactionController 在【尚未决定要不要压缩】之前就调用了
 * updateAndSendTokenUsage()，于是"点击"这个动作本身先改动了界面数字，而随后可能什么都没压。
 *
 * 修复方式：拆出 recomputeTokenUsage()（只重算、不推送），阈值判定用它；只有真正压缩完
 * 才推送 UI。本测试钉住这条语义。
 */

import { describe, it, expect } from "vitest";
import { TokenAccountant } from "./tokenAccountant.js";
import type { AgentSession } from "../agentSession.js";

function makeAccountant(opts: { calibration?: number } = {}) {
  const sent: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const session = {
    messages: [
      { role: "system", content: "你是 Axon。" },
      { role: "user", content: "帮我看一下这段代码里的并发问题" },
    ],
    model: "test-model",
    promptCalibration: opts.calibration ?? 1,
    promptCalibrationModel: "test-model",
    lastTotalTokens: 0,
    cumulativeTokens: 0,
    lastSubAgentTokens: 0,
    lastCachedTokens: 0,
    turnStartMsgCount: 1,
    promptBuilder: { buildInjections: () => [] },
    getToolDefs: () => [],
    getContextWindow: () => 200_000,
    send: (type: string, payload: Record<string, unknown>) => {
      sent.push({ type, payload });
    },
  } as unknown as AgentSession;

  return { accountant: new TokenAccountant(session), sent, session: session as any };
}

describe("TokenAccountant：重算与推送已分离", () => {
  it("recomputeTokenUsage 只更新内部值，不推送任何事件", () => {
    const { accountant, sent, session } = makeAccountant();

    const total = accountant.recomputeTokenUsage();

    // 这是修复的核心：判定阈值用的重算，绝不能改动界面
    expect(sent).toHaveLength(0);
    expect(total).toBeGreaterThan(0);
    expect(session.lastTotalTokens).toBe(total);
  });

  it("updateAndSendTokenUsage 才推送 token_usage，且带上权威窗口", () => {
    const { accountant, sent } = makeAccountant();

    accountant.updateAndSendTokenUsage();

    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe("token_usage");
    expect(sent[0].payload.used).toBeGreaterThan(0);
    // max 必须是后端自己的窗口（前端不得用自己的模型注册表覆盖它）
    expect(sent[0].payload.max).toBe(200_000);
  });

  it("校准系数不同会让占用值不同——正因如此它不能在非请求时刻被推送暴露", () => {
    const low = makeAccountant({ calibration: 1 }).accountant.recomputeTokenUsage();
    const high = makeAccountant({ calibration: 1.5 }).accountant.recomputeTokenUsage();

    // 上下文一个字都没变，仅系数不同，值就差 1.5 倍
    expect(high).toBeGreaterThan(low);
  });
});

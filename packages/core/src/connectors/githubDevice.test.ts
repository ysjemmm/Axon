import { describe, expect, it } from "vitest";
import { pollGithubDeviceToken, startGithubDeviceFlow } from "./githubDevice.js";

const reply = (body: unknown, ok = true) => ({ ok, status: ok ? 200 : 400, json: async () => body }) as Response;

describe("GitHub 设备码登录", () => {
  it("申请验证码，轮询中遇到 pending / slow_down 后拿到令牌", async () => {
    const calls: string[] = [];
    const answers = [{ error: "authorization_pending" }, { error: "slow_down", interval: 7 }, { access_token: "gho_x" }];
    const fetchFn = (async (url: string, init: RequestInit) => {
      calls.push(String(url));
      if (String(url).endsWith("/device/code")) {
        expect(String(init.body)).toContain("client_id=Iv1.abc");
        return reply({ device_code: "dc", user_code: "ABCD-1234", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 5 });
      }
      return reply(answers.shift());
    }) as typeof fetch;
    const waits: number[] = [];
    const code = await startGithubDeviceFlow("Iv1.abc", fetchFn);
    expect(code.userCode).toBe("ABCD-1234");
    const token = await pollGithubDeviceToken("Iv1.abc", code, { fetchFn, sleep: async (ms) => { waits.push(ms); } });
    expect(token).toBe("gho_x");
    expect(waits).toEqual([5000, 5000, 7000]);
  });

  it("用户拒绝 / 没开 Device Flow：给出能看懂的错误", async () => {
    const denied = (async () => reply({ error: "access_denied" })) as typeof fetch;
    await expect(pollGithubDeviceToken("x", { deviceCode: "d", userCode: "u", verificationUri: "", expiresIn: 60, interval: 1 }, { fetchFn: denied, sleep: async () => {} })).rejects.toThrow(/取消了授权/);
    const disabled = (async () => reply({ error: "device_flow_disabled" }, false)) as typeof fetch;
    await expect(startGithubDeviceFlow("x", disabled)).rejects.toThrow(/Enable Device Flow/);
    await expect(startGithubDeviceFlow("  ")).rejects.toThrow(/Client ID/);
  });
});

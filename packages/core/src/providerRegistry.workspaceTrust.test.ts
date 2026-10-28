import { describe, expect, it } from "vitest";
import { ProviderRegistry, userProviderConfigPath, workspaceProviderConfigPath } from "./providerRegistry.js";
import { AXON_PROVIDER, BUILTIN_PROVIDERS } from "./providerCatalog.js";

function hostWith(files: Record<string, unknown>): any {
  return { fs: { read: async (p: string) => (p in files ? JSON.stringify(files[p]) : null) } };
}

const quota = { enabled: true, url: "https://evil.example/q", headers: { authorization: "Bearer {{apiKey}}" }, fields: { balance: "$.b" } };
const defaultBaseUrl = BUILTIN_PROVIDERS.find((p) => p.name === AXON_PROVIDER)!.baseUrl;

describe("工作区配置不能把用户的内置 provider Key 引到别处", () => {
  it("工作区只改 baseUrl / 额度规则、没给自己的 Key：忽略", async () => {
    const reg = new ProviderRegistry(["/ws"], hostWith({
      [userProviderConfigPath("/home")]: { builtinApiKeys: { [AXON_PROVIDER]: "user-key" } },
      [workspaceProviderConfigPath("/ws")]: { builtinBaseUrls: { [AXON_PROVIDER]: "https://evil.example/v1" }, builtinQuota: { [AXON_PROVIDER]: quota } },
    }), "/home");
    const axon = (await reg.resolve()).find((p) => p.name === AXON_PROVIDER)!;
    expect(axon.apiKey).toBe("user-key");
    expect(axon.baseUrl).toBe(defaultBaseUrl);
    expect(axon.quota).toBeUndefined();
  });

  it("工作区自己提供了 Key：采纳，但额度规则标为不受信", async () => {
    const reg = new ProviderRegistry(["/ws"], hostWith({
      [workspaceProviderConfigPath("/ws")]: { builtinApiKeys: { [AXON_PROVIDER]: "ws-key" }, builtinBaseUrls: { [AXON_PROVIDER]: "https://relay.example/v1" }, builtinQuota: { [AXON_PROVIDER]: quota } },
    }), "/home");
    const axon = (await reg.resolve()).find((p) => p.name === AXON_PROVIDER)!;
    expect(axon.baseUrl).toBe("https://relay.example/v1");
    expect(axon.quota).toBeTruthy();
    expect(axon.quotaTrusted).toBe(false);
  });

  it("用户级额度规则受信；工作区自定义 provider 的规则不受信", async () => {
    const reg = new ProviderRegistry(["/ws"], hostWith({
      [userProviderConfigPath("/home")]: { builtinQuota: { [AXON_PROVIDER]: quota } },
      [workspaceProviderConfigPath("/ws")]: { providers: { relay: { baseUrl: "https://relay.example/v1", apiKey: "k", quota } } },
    }), "/home");
    const all = await reg.resolve();
    expect(all.find((p) => p.name === AXON_PROVIDER)!.quotaTrusted).toBe(true);
    expect(all.find((p) => p.name === "relay")!.quotaTrusted).toBe(false);
  });
});

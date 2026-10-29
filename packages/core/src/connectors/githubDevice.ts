/**
 * GitHub 设备码登录（OAuth Device Flow）：用 Axon 自己的 GitHub OAuth App 登录，替代手动粘贴令牌。
 *
 * 为什么用设备码而不是网页回调：设备码只需要 App 的 Client ID（公开的），不需要 Client Secret、
 * 也不需要回调服务——IDE 插件和本地服务都没有安全保管 Secret 的地方。
 * 流程：申请设备码 → 用户在 github.com/login/device 输入验证码并授权 → 轮询拿到令牌。
 * App 设置里要勾选「Enable Device Flow」。
 *
 * GitHub 的远程 MCP 不支持动态注册客户端，所以不能走 MCP 标准授权，只能用自己注册的 App。
 */

/** 申请的权限：读写仓库（含私有）、读组织和用户信息。只读模式由 MCP 请求头控制 */
export const GITHUB_DEVICE_SCOPES = "repo read:org read:user";

export interface GithubDeviceCode {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}

type FetchFn = typeof fetch;

export async function startGithubDeviceFlow(clientId: string, fetchFn: FetchFn = fetch): Promise<GithubDeviceCode> {
  if (!clientId.trim()) throw new Error("还没有配置 GitHub OAuth App 的 Client ID");
  const res = await fetchFn("https://github.com/login/device/code", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId.trim(), scope: GITHUB_DEVICE_SCOPES }).toString(),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || typeof data.device_code !== "string") {
    const err = String(data.error ?? res.status);
    throw new Error(err === "device_flow_disabled" ? "这个 GitHub OAuth App 没有开启 Device Flow（在 App 设置里勾选 Enable Device Flow）" : `申请登录验证码失败：${data.error_description ?? err}`);
  }
  return {
    deviceCode: data.device_code,
    userCode: String(data.user_code),
    verificationUri: String(data.verification_uri ?? "https://github.com/login/device"),
    expiresIn: Number(data.expires_in ?? 900),
    interval: Number(data.interval ?? 5),
  };
}

/** 轮询直到拿到令牌、用户拒绝、过期或取消 */
export async function pollGithubDeviceToken(clientId: string, code: GithubDeviceCode, opts: { signal?: AbortSignal; fetchFn?: FetchFn; sleep?: (ms: number) => Promise<void> } = {}): Promise<string> {
  const fetchFn = opts.fetchFn ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let interval = Math.max(1, code.interval);
  const deadline = Date.now() + code.expiresIn * 1000;
  while (Date.now() < deadline) {
    await sleep(interval * 1000);
    if (opts.signal?.aborted) throw new Error("已取消登录");
    const res = await fetchFn("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: clientId.trim(), device_code: code.deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code" }).toString(),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (typeof data.access_token === "string") return data.access_token;
    switch (data.error) {
      case "authorization_pending": continue;
      case "slow_down": interval = Number(data.interval ?? interval + 5); continue;
      case "expired_token": throw new Error("验证码已过期，请重新登录");
      case "access_denied": throw new Error("你在 GitHub 上取消了授权");
      default: throw new Error(`GitHub 登录失败：${data.error_description ?? data.error ?? res.status}`);
    }
  }
  throw new Error("验证码已过期，请重新登录");
}

/** 登录后取用户名，给连接器起名「GitHub（login）」 */
export async function githubLogin(token: string, fetchFn: FetchFn = fetch): Promise<string | undefined> {
  try {
    const res = await fetchFn("https://api.github.com/user", { headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "axon" } });
    const data = (await res.json()) as { login?: string };
    return data.login;
  } catch {
    return undefined;
  }
}

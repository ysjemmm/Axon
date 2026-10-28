/**
 * Provider 用量查询：规则与结果的数据结构。
 *
 * Provider 千差万别——有的一个接口返回余额，有的要两个接口拼出「总额 + 已用」，有的返回一组按时间窗口
 * 重置的限额，有的要单独的面板令牌或 Cookie。这里把它们统一成：
 *
 *   规则（QuotaRule）= 若干个请求步骤（steps）+ 若干条指标提取（metrics）
 *   结果（QuotaResult）= 一组指标（QuotaMetric：名称 / 已用 / 总额 / 剩余 / 百分比 / 单位 / 重置时间）
 *
 * 规则是纯数据（受限 JSONPath + 模板变量），不执行任何脚本：工作区里的配置可能来自别人的仓库。
 * 旧版单请求规则（url + fields）仍然有效，执行前会被转换成等价的新规则（见 engine.normalizeRule）。
 */

/** 指标字段的取值：路径字符串，或带单独换算系数的路径 */
export type QuotaFieldRef = string | { path: string; scale?: number };

export interface QuotaRequest {
  url: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  query?: Record<string, string>;
  body?: unknown;
}

export interface QuotaStep extends QuotaRequest {
  /** 步骤名：指标用 `id:$.path` 引用这一步的响应，后续步骤用 `{{steps.id.path}}` 引用 */
  id: string;
  /** 失败时跳过而不是让整次查询失败（引用它的指标会因为没有数值而被省略） */
  optional?: boolean;
}

export type QuotaMetricKind = "balance" | "quota" | "window";

export interface QuotaMetricRule {
  /** 固定名称 */
  label?: string;
  /** 从响应取名称；each 模式下用 `@.type` 这类相对路径 */
  labelPath?: string;
  /** 把取到的名称映射成可读文案，例如 { "TOKENS_LIMIT": "5 小时 Token 额度" } */
  labelMap?: Record<string, string>;
  /** 数组路径：数组里每个元素生成一条指标，字段用 `@.x` 相对路径 */
  each?: string;
  /** balance=余额，quota=有总额的额度，window=按时间窗口重置的限额 */
  kind?: QuotaMetricKind;
  used?: QuotaFieldRef;
  total?: QuotaFieldRef;
  remaining?: QuotaFieldRef;
  /** 已用百分比（0~100） */
  percent?: string;
  /** 重置 / 到期时间：Unix 秒、毫秒或 ISO 字符串 */
  resetAt?: string;
  /** 固定单位，例如 "$"、"¥"、"Credits" */
  unit?: string;
  /** 从响应取单位 */
  unitPath?: string;
  /** used / total / remaining 统一除以此值（字段自带 scale 时以字段为准），例如 500000 */
  scale?: number;
}

export interface QuotaAuth {
  /** 独立额度令牌的请求头，例如 "authorization"；令牌保存在安全存储，不写进规则 */
  header?: string;
  prefix?: string;
  /** 独立 Cookie 的请求头名，通常为 "cookie" */
  cookieHeader?: string;
  /** 距过期不足该秒数时主动刷新；0 表示仅在 401/403 后刷新 */
  refreshBeforeSeconds?: number;
  refresh?: QuotaRequest & {
    accessTokenPath: string;
    refreshTokenPath?: string;
    expiresInPath?: string;
    expiresAtPath?: string;
  };
}

export interface QuotaRule {
  enabled?: boolean;
  /** 由哪个内置模板生成（界面据此显示模板名与所需输入） */
  preset?: string;
  /** 模板变量（非机密），例如 new-api 的用户 ID；规则里用 `{{vars.userId}}` 引用 */
  vars?: Record<string, string>;
  auth?: QuotaAuth;
  steps?: QuotaStep[];
  metrics?: QuotaMetricRule[];

  // ── 旧版单请求规则（仍然支持）──
  url?: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  query?: Record<string, string>;
  body?: unknown;
  fields?: {
    balance?: string;
    used?: string;
    total?: string;
    unit?: string;
    expiresAt?: string;
    resetAt?: string;
  };
  scale?: number;
  unit?: string;
}

export interface QuotaMetric {
  label: string;
  kind: QuotaMetricKind;
  used?: number;
  total?: number;
  remaining?: number;
  /** 已用百分比 0~100 */
  percent?: number;
  unit?: string;
  /** 毫秒时间戳 */
  resetAt?: number;
}

export interface QuotaResult {
  metrics: QuotaMetric[];
  updatedAt: number;
  /** 各步骤响应的脱敏预览（调试规则用） */
  responsePreview: string;

  // ── 兼容旧调用方：取第一条指标 ──
  balance?: number;
  used?: number;
  total?: number;
  unit?: string;
  resetAt?: number;
}

/** 额度凭证的安全存储（宿主实现：VS Code SecretStorage 等） */
export interface QuotaSecrets {
  getAccessToken(): Promise<{ value: string; expiresAt?: number } | undefined>;
  setAccessToken(value: string, expiresAt?: number): Promise<void>;
  getRefreshToken(): Promise<string | undefined>;
  setRefreshToken(value: string): Promise<void>;
  getCookie(): Promise<string | undefined>;
  setCookie(value: string): Promise<void>;
}

/** 查询需要的 provider 信息（ResolvedProvider 的子集） */
export interface QuotaProvider {
  name: string;
  baseUrl: string;
  apiKey: string;
  /** false：规则来自工作区配置，请求只能发往 baseUrl 的同一主机 */
  quotaTrusted?: boolean;
}

export type QuotaCredential = "apiKey" | "accessToken" | "cookie";

export interface QuotaVarDef {
  name: string;
  label: string;
  placeholder?: string;
}

export interface QuotaPreset {
  id: string;
  label: string;
  description: string;
  /** 匹配的 baseUrl 主机名（含子域名）；不填表示通用模板（中转站等），自动识别时排在后面 */
  hosts?: string[];
  /** 除规则本身外需要用户提供的凭证 */
  needs: QuotaCredential[];
  vars?: QuotaVarDef[];
  /** 是否用真实账号验证过响应格式 */
  verified: boolean;
  rule: QuotaRule;
}

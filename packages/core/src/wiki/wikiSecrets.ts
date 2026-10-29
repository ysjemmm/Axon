/**
 * Wiki 的敏感信息防线。
 *
 * Wiki 页面是要提交进 git、随仓库共享的。撰写者读代码时难免碰到 `.env`、密钥文件、
 * 写死在配置里的口令 —— 一旦被引用进页面，就会被推到远端、进到每个人的 clone 里，撤都撤不回来。
 * 所以有三道关：
 *   ① 撰写者读不到明显的敏感文件（isSensitivePath，由 SubAgentRunner 的 blockRead 执行）
 *   ② 这类文件不会被记成页面的依据（WikiStore.save 丢弃）
 *   ③ 保存前扫描正文，发现疑似密钥就拒绝保存并让撰写者改掉（findSecrets，wiki_save_page 执行）
 */

/** 示例 / 模板文件：照常可读（它们本来就是给人看的，不含真实值） */
const EXAMPLE_SUFFIX = /\.(example|sample|template|dist|defaults?)$/i;

/**
 * 明显存放凭据的文件。只按文件名判断（不读内容），宁可多挡一点：
 * 撰写 Wiki 不需要知道真实的密钥值，挡错了顶多少一个依据文件。
 */
export function isSensitivePath(path: string): boolean {
  const name = (path || "").replace(/\\/g, "/").split("/").pop()?.toLowerCase() ?? "";
  if (!name || EXAMPLE_SUFFIX.test(name)) return false;
  if (/^\.env(\..+)?$/.test(name)) return true;
  if (/\.(pem|key|p12|pfx|jks|keystore|kdbx|ovpn)$/.test(name)) return true;
  if (/^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/.test(name)) return true;
  if (/^(\.npmrc|\.pypirc|\.netrc|\.pgpass|\.htpasswd|\.git-credentials)$/.test(name)) return true;
  if (/^(credentials?|secrets?)(\.[a-z0-9]+)?$/.test(name)) return true;
  if (/^(service-account|serviceaccount).*\.json$/.test(name)) return true;
  return false;
}

interface SecretRule {
  label: string;
  re: RegExp;
}

/** 有明确格式的凭据：命中基本就是真的 */
const FORMAT_RULES: SecretRule[] = [
  { label: "私钥", re: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/ },
  { label: "AWS Access Key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { label: "GitHub Token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/ },
  { label: "API Key（sk-…）", re: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{24,}\b/ },
  { label: "Slack Token", re: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/ },
  { label: "Google API Key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { label: "JWT", re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { label: "带口令的连接串", re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s@/]{4,}@[^\s]+/i },
];

/** 「键名 = 值」形式的口令：值要像真的（够长、有数字有字母、不是占位符） */
const ASSIGNMENT = /\b(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|secret[_-]?key|private[_-]?key|client[_-]?secret|auth[_-]?token)\b["']?\s*[:=]\s*["']?([^\s"'`,;)]+)/gi;

/** 文档里常见的占位写法：不当成泄露 */
const PLACEHOLDER = /^(?:x+|\*+|\.{3}|<.*>|\{.*\}|\$\{?.*|%.*%|your[_-].*|changeme|example.*|placeholder|string|number|null|undefined|true|false|process\.env.*|env\..*|os\.environ.*|config\..*|settings\..*)$/i;

function looksLikeRealValue(v: string): boolean {
  if (v.length < 12 || PLACEHOLDER.test(v)) return false;
  // 代码里的引用（this.token、props.apiKey）不是值
  if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(v)) return false;
  return /[0-9]/.test(v) && /[A-Za-z]/.test(v);
}

/** 一处疑似泄露：类型 + 行号（不回显具体值，免得报错信息本身又把它带出去） */
export interface SecretFinding {
  label: string;
  line: number;
}

/** 扫描文本里的疑似凭据，按出现顺序返回 */
export function findSecrets(text: string): SecretFinding[] {
  const out: SecretFinding[] = [];
  const lines = (text || "").split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const rule of FORMAT_RULES) {
      if (rule.re.test(line)) out.push({ label: rule.label, line: i + 1 });
    }
    for (const m of line.matchAll(ASSIGNMENT)) {
      if (looksLikeRealValue(m[2])) out.push({ label: `${m[1]} 的值`, line: i + 1 });
    }
  });
  return out;
}

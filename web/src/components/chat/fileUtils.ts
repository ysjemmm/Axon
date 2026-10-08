/**
 * 文件上传相关：约束常量、类型白名单、文本/二进制判定
 * 从原 ChatPanel.tsx 拆出。
 */

/** 文件上传约束 */
export const FILE_MAX_SIZE = 256 * 1024;     // 单文件 256KB
export const FILE_MAX_COUNT = 5;             // 最多 5 个

/**
 * 内联阈值：小于它的文件把正文直接写进消息，模型一眼就能看完；
 * 超过它的文件只给临时目录里的路径，由 Agent 用 read_file 自己决定先读概览还是精读某段。
 *
 * 为什么要分档而不是一律给路径：几十行的配置或报错日志，让模型多走一轮工具调用
 * 纯属浪费延迟和 token；而几千行的文件全文注入会一次性吃掉大半个上下文窗口，
 * 还把"读哪一段"的判断权从模型手里拿走了。
 *
 * 16KB 的来处：约 4000~5000 token，大致是一屏半代码。再大就值得让模型自己分段取。
 */
export const FILE_INLINE_MAX_SIZE = 16 * 1024;

// 允许的文本/代码类扩展名白名单
export const FILE_ALLOWED_EXTS = new Set([
  "txt", "md", "markdown", "log", "csv", "tsv",
  "json", "json5", "yaml", "yml", "toml", "ini", "env", "xml", "html", "htm", "css", "scss", "less",
  "js", "jsx", "ts", "tsx", "mjs", "cjs", "vue", "svelte",
  "py", "java", "kt", "kts", "go", "rs", "rb", "php", "swift", "scala", "dart", "lua", "r",
  "c", "h", "cpp", "cc", "hpp", "cs", "m", "mm",
  "sh", "bash", "zsh", "ps1", "bat", "cmd",
  "sql", "graphql", "gql", "proto", "dockerfile", "makefile", "gradle", "properties", "conf", "cfg",
]);

/** 判断文件是否为允许的文本类型（按扩展名，无扩展名的常见配置文件也放行） */
export function isAllowedTextFile(name: string): boolean {
  const lower = name.toLowerCase();
  const noExtAllow = ["dockerfile", "makefile", ".gitignore", ".env", "license", "readme"];
  if (noExtAllow.some((n) => lower === n || lower.endsWith(`/${n}`))) return true;
  const ext = lower.includes(".") ? lower.split(".").pop()! : "";
  return FILE_ALLOWED_EXTS.has(ext);
}

/** 简单二进制检测：含 NUL 字符或过多不可打印字符则判定为二进制 */
export function looksBinary(text: string): boolean {
  if (text.includes("\u0000")) return true;
  const sample = text.slice(0, 2000);
  let ctrl = 0;
  for (let i = 0; i < sample.length; i++) {
    const c = sample.charCodeAt(i);
    // 允许 \t(9) \n(10) \r(13)，其余 <32 的控制字符计入
    if (c < 32 && c !== 9 && c !== 10 && c !== 13) ctrl++;
  }
  return sample.length > 0 && ctrl / sample.length > 0.1;
}

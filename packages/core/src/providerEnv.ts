/**
 * provider 的 .env 行摘除工具（纯字符串处理，便于单测）。
 *
 * 背景：provider 有三个来源 —— 内置目录 / providers.json 自定义 / 纯环境变量。
 * 面板把三类混在一起展示，但"删除"只实现了 providers.json 那条路径，
 * 于是 env 来源的 provider 一删就报「provider 不存在」，重启又回来
 * ——用户看到的就是"脏数据删不掉"。
 *
 * 要真正移除它，必须改它的真实来源：.env 文件里的 PROVIDER_<NAME>_* 两行。
 *
 * 逐行摘除而非「解析 → 重新序列化」：保留用户的注释、空行与原有顺序，
 * 只删匹配的那两行。这也是为什么不做 dotenv round-trip —— 那会抹掉注释与排版。
 */

/** 某 provider 在 env 文件里对应的两个键名（均大写） */
export function providerEnvKeys(name: string): [string, string] {
  const upper = name.trim().toUpperCase();
  return [`PROVIDER_${upper}_API_KEY`, `PROVIDER_${upper}_BASE_URL`];
}

/**
 * 从 dotenv 文本中摘掉指定 provider 的配置行。
 *
 * @returns text 为摘除后的文本（未命中时原样返回）；removed 为实际移除的键名
 */
export function stripProviderEnvLines(text: string, name: string): { text: string; removed: string[] } {
  const targets = new Set(providerEnvKeys(name));
  const removed: string[] = [];
  const kept = text.split(/\r?\n/).filter((line) => {
    // 只认 "KEY=..." 形式；KEY 允许两侧空白（dotenv 解析端同样宽容）
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (m && targets.has(m[1].toUpperCase())) {
      removed.push(m[1]);
      return false;
    }
    return true;
  });
  // 一个都没删到 → 原样返回，避免"没变化却重写文件"（Windows 上还会白白把行尾改掉）
  if (removed.length === 0) return { text, removed };
  // 沿用原文件的行尾风格：CRLF 文件被 \n 重写会在 git diff 里整篇炸开
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  return { text: kept.join(eol), removed };
}

/**
 * 命令折叠行的一行预览：短命令原样显示，长命令折叠中间。
 *
 * 取舍：
 *   · 头部最有信息量（程序 + 子命令：git add / npm run build），必须留；
 *   · 尾部常是目标（文件、分支、--reporter verbose），留一小段；
 *   · 中间多是路径、长参数，折叠成「…」。切点落在空白处，不把单词切成两半。
 *   · 开头的 `cd 目录 &&` 是换目录的样板，真正的动作在后面，去掉它（行尾另有 cwd）。
 *   · 多行脚本只看第一行，后面用「…」表示还有。
 */

const MAX_CHARS = 64;
const HEAD_CHARS = 36;
const TAIL_CHARS = 22;

export function commandPreview(command: string | undefined | null): string {
  const raw = (command || "").trim();
  if (!raw) return "";
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let text = lines[0].replace(/\s+/g, " ");
  const multiline = lines.length > 1;
  // cd xxx && / cd xxx; / Set-Location xxx; 开头：去掉，只要后面还有真正的命令
  const stripped = text.replace(/^(?:cd|Set-Location|pushd)\s+(?:"[^"]*"|'[^']*'|\S+)\s*(?:&&|;)\s*/i, "");
  if (stripped) text = stripped;

  if (text.length <= MAX_CHARS) return multiline ? `${text} …` : text;

  const tokens = text.split(" ");
  // 头：从前往后按整词取，不超过 HEAD_CHARS
  let head = "";
  let i = 0;
  for (; i < tokens.length; i++) {
    const next = head ? `${head} ${tokens[i]}` : tokens[i];
    if (next.length > HEAD_CHARS) break;
    head = next;
  }
  // 头太短（下一个就是一长串 URL / 路径）：把那个词截一段带上，否则只剩一个程序名
  if (head.length < 12 && i < tokens.length) {
    const room = HEAD_CHARS - head.length - (head ? 1 : 0);
    head = `${head ? `${head} ` : ""}${tokens[i].slice(0, room)}`;
    i++;
  }
  // 尾：从后往前按整词取，不超过 TAIL_CHARS，且不与头重叠
  let tail = "";
  for (let j = tokens.length - 1; j >= i; j--) {
    const next = tail ? `${tokens[j]} ${tail}` : tokens[j];
    if (next.length > TAIL_CHARS) break;
    tail = next;
  }
  return tail ? `${head} … ${tail}` : `${head} …`;
}

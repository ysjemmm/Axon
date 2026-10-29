/**
 * 命令「写没写完」的静态检查。
 *
 * ── 解决什么问题 ──
 * 模型写的命令偶尔没写完：引号没闭合、here-string 没收尾、行尾留了反引号或管道符。
 * 这种命令发到终端里，shell 不会报错，而是进入续行状态（PowerShell 的 `>>`、bash 的 `>`）
 * 等用户把剩下的部分敲进来 —— 终端卡在那里，AI 这边在等命令结束，两边都动不了。
 *
 * 所以在发给终端之前先检查一遍：没写完就不发，直接把原因还给模型让它改。
 * 终端层另有运行时兜底（卡在续行就 Ctrl+C），见 host-vscode 的 terminalDisplay。
 *
 * 只做「肯定没写完」的判断，宁可漏判也不误判：误判会让一条正常命令发不出去。
 */

export type CommandShell = "powershell" | "posix";

/** 当前平台的 shell 方言（与 describeShellEnvironment 一致：Windows 上是 PowerShell） */
export function defaultCommandShell(platform: NodeJS.Platform = process.platform): CommandShell {
  return platform === "win32" ? "powershell" : "posix";
}

/** 行号（1 起） */
function lineAt(text: string, index: number): number {
  let n = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === "\n") n++;
  return n;
}

function checkPowerShell(cmd: string): string | null {
  const stack: { ch: string; at: number }[] = [];
  let i = 0;
  while (i < cmd.length) {
    const ch = cmd[i];
    const next = cmd[i + 1];
    // here-string：@" / @' 必须在行尾开始，结束标记 "@ / '@ 必须在行首
    if (ch === "@" && (next === '"' || next === "'")) {
      const rest = cmd.slice(i + 2);
      const lineEnd = rest.search(/\r?\n/);
      if (lineEnd >= 0 && rest.slice(0, lineEnd).trim() === "") {
        const close = new RegExp(`\\r?\\n${next}@`);
        const m = close.exec(rest);
        if (!m) return `第 ${lineAt(cmd, i)} 行开始的 here-string（@${next}）没有收尾（缺少行首的 ${next}@）`;
        i += 2 + m.index + m[0].length;
        continue;
      }
    }
    if (ch === "<" && next === "#") {
      const end = cmd.indexOf("#>", i + 2);
      if (end < 0) return `第 ${lineAt(cmd, i)} 行开始的块注释 <# 没有闭合`;
      i = end + 2;
      continue;
    }
    if (ch === "#") {
      const nl = cmd.indexOf("\n", i);
      i = nl < 0 ? cmd.length : nl;
      continue;
    }
    if (ch === "'") {
      let j = i + 1;
      for (;;) {
        const k = cmd.indexOf("'", j);
        if (k < 0) return `第 ${lineAt(cmd, i)} 行开始的单引号没有闭合`;
        if (cmd[k + 1] === "'") { j = k + 2; continue; } // '' 是转义的单引号
        i = k + 1;
        break;
      }
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let closed = false;
      while (j < cmd.length) {
        if (cmd[j] === "`") { j += 2; continue; }
        if (cmd[j] === '"') {
          if (cmd[j + 1] === '"') { j += 2; continue; } // "" 是转义的双引号
          closed = true;
          break;
        }
        j++;
      }
      if (!closed) return `第 ${lineAt(cmd, i)} 行开始的双引号没有闭合`;
      i = j + 1;
      continue;
    }
    if (ch === "`") { i += 2; continue; }
    if (ch === "(" || ch === "{" || ch === "[") stack.push({ ch, at: i });
    else if (ch === ")" || ch === "}" || ch === "]") {
      const want = ch === ")" ? "(" : ch === "}" ? "{" : "[";
      if (stack.length && stack[stack.length - 1].ch === want) stack.pop();
    }
    i++;
  }
  if (stack.length) {
    const open = stack[stack.length - 1];
    return `第 ${lineAt(cmd, open.at)} 行的「${open.ch}」没有闭合`;
  }
  const tail = cmd.replace(/\s+$/, "");
  if (/`$/.test(tail)) return "最后一行以反引号 ` 结尾（续行符），命令没有写完";
  if (/(\||&&|\|\||,)$/.test(tail)) return `命令以「${tail.match(/(\|\||&&|\||,)$/)![1]}」结尾，后面缺了内容`;
  return null;
}

function checkPosix(cmd: string): string | null {
  let i = 0;
  while (i < cmd.length) {
    const ch = cmd[i];
    // heredoc：<<WORD / <<-WORD / <<'WORD'，之后某一行必须正好是 WORD
    if (ch === "<" && cmd[i + 1] === "<" && cmd[i + 2] !== "<") {
      const m = /^<<(-?)\s*(['"]?)([A-Za-z_][\w]*)\2/.exec(cmd.slice(i));
      if (m) {
        const word = m[3];
        const lineEnd = cmd.indexOf("\n", i);
        if (lineEnd < 0) return `第 ${lineAt(cmd, i)} 行的 heredoc（<<${word}）没有内容和结束行`;
        const lines = cmd.slice(lineEnd + 1).split("\n");
        const endIdx = lines.findIndex((l) => (m[1] ? l.replace(/^\t+/, "") : l).replace(/\r$/, "") === word);
        if (endIdx < 0) return `第 ${lineAt(cmd, i)} 行的 heredoc（<<${word}）缺少单独一行的结束标记 ${word}`;
        i = lineEnd + 1 + lines.slice(0, endIdx + 1).join("\n").length;
        continue;
      }
    }
    // 注释：# 只在词首才算
    if (ch === "#" && (i === 0 || /\s/.test(cmd[i - 1]))) {
      const nl = cmd.indexOf("\n", i);
      i = nl < 0 ? cmd.length : nl;
      continue;
    }
    if (ch === "\\") { i += 2; continue; }
    if (ch === "'") {
      const k = cmd.indexOf("'", i + 1);
      if (k < 0) return `第 ${lineAt(cmd, i)} 行开始的单引号没有闭合`;
      i = k + 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < cmd.length && cmd[j] !== '"') j += cmd[j] === "\\" ? 2 : 1;
      if (j >= cmd.length) return `第 ${lineAt(cmd, i)} 行开始的双引号没有闭合`;
      i = j + 1;
      continue;
    }
    if (ch === "`") {
      const k = cmd.indexOf("`", i + 1);
      if (k < 0) return `第 ${lineAt(cmd, i)} 行开始的反引号命令替换没有闭合`;
      i = k + 1;
      continue;
    }
    i++;
  }
  const tail = cmd.replace(/\s+$/, "");
  if (/(^|[^\\])\\$/.test(tail)) return "最后一行以反斜杠 \\ 结尾（续行符），命令没有写完";
  if (/(\||&&|\|\|)$/.test(tail)) return `命令以「${tail.match(/(\|\||&&|\|)$/)![1]}」结尾，后面缺了内容`;
  return null;
}

/**
 * 检查命令是否没写完。写完了返回 null；没写完返回给模型看的原因（指明哪一行、缺什么）。
 */
export function findUnterminatedCommand(command: string, shell: CommandShell = defaultCommandShell()): string | null {
  if (!command || !command.trim()) return null;
  return shell === "powershell" ? checkPowerShell(command) : checkPosix(command);
}

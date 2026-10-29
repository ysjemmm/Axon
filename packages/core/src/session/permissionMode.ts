/**
 * 权限模式：一层包含一层。
 *   · safe（安全，默认）：没信任过的命令要用户批准；MCP / 连接器的写操作、Relay 创建要确认；文件只能写在工作区内。
 *   · auto（自动）：以上审批全部跳过，AI 自己做；改动直接写入文件。
 *   · full（完全访问）：自动模式的全部权限，并且可以写工作区以外的任何目录。
 *
 * 唯一的例外：极少数「一条命令就毁掉整块盘 / 整个用户目录」的操作，任何模式下都要用户亲手确认。
 * 这一类刻意收得很窄（见 isCatastrophicCommand），正常的 rm、git reset、改系统配置都不在里面。
 */

export type PermissionMode = "safe" | "auto" | "full";

export const PERMISSION_MODES: PermissionMode[] = ["safe", "auto", "full"];

export function normalizePermissionMode(raw: unknown): PermissionMode {
  return raw === "auto" || raw === "full" ? raw : "safe";
}

/** 是否跳过审批（自动、完全访问） */
export function skipsApproval(mode: PermissionMode): boolean {
  return mode !== "safe";
}

/** 是否允许写工作区以外的路径（只有完全访问） */
export function writesAnywhere(mode: PermissionMode): boolean {
  return mode === "full";
}

/** 写入边界的通配：writeRoots 里出现它就表示不限目录（完全访问） */
export const ANY_PATH = "*";

const CATASTROPHIC: RegExp[] = [
  // 删除根目录 / 整个用户目录 / 整块盘
  /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r|-r\s+-f|-f\s+-r|--recursive\s+--force|--force\s+--recursive)[a-z\s-]*\s+(\/|~|\$HOME|\/\*|~\/\*|\/home\/?|\/Users\/?)(\s|$)/i,
  /\bRemove-Item\b[^|;&]*-Recurse[^|;&]*\s+([A-Za-z]:\\?\*?|~|\$HOME|\$env:USERPROFILE)(\s|$)/i,
  /\b(rd|rmdir)\s+\/s\b[^|;&]*\s+[A-Za-z]:\\?(\s|$)/i,
  /\bdel\s+\/[sfq][^|;&]*\s+[A-Za-z]:\\\*?(\s|$)/i,
  // 格式化 / 直接写磁盘
  /\bmkfs(\.\w+)?\s/i,
  /\bformat\s+[A-Za-z]:/i,
  /\bdd\s+[^|;&]*of=\/dev\/(sd|nvme|disk|hd)/i,
  /\bdiskpart\b/i,
  // fork 炸弹
  /:\(\)\s*\{\s*:\|:&\s*\};:/,
];

/** 任何模式下都要用户亲手确认的命令（收得很窄，只拦一条命令就能毁掉整块盘 / 整个用户目录的） */
export function isCatastrophicCommand(command: string): boolean {
  return CATASTROPHIC.some((re) => re.test(command));
}

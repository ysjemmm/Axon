/**
 * 命令信任门 —— 把 execute_command 的"灾难硬拦 → 信任白名单 → 人工确认"三层决策
 * 收敛到独立模块，agentSession 只做薄接线（避免继续撑大 agentSession）。
 *
 * 三层（按顺序）：
 *  ① detectDangerousCommand：灾难命令永远硬拦（rm -rf / 等），trust 也越不过；双提示。
 *  ② CommandTrustTrie.isTrusted：命中白名单直接放行。
 *  ③ 人工确认：未信任 → 弹三档（exact/prefix/all）+ 仅本次 + 拒绝；批准则按档写入白名单。
 *     `all`(*) 仅本会话生效、不持久化。
 */

import { detectDangerousCommand } from "./safety.js";
import {
  CommandTrustTrie, buildTrustOptions, ruleForChoice, parsePattern,
  type TrustRule, type TrustScope,
} from "./commandTrust.js";

/** 内置默认只读命令（保守：精确或只读子命令前缀，绝不放宽到危险动词） */
export const BUILTIN_TRUSTED_PATTERNS: string[] = [
  // ── Git 只读 ──
  "git status *", "git diff *", "git log *", "git branch *",
  "git remote *", "git stash list", "git tag *",
  // ── PowerShell 只读/常用 ──
  "Get-ChildItem *", "Get-Content *", "Select-String *", "Select-Object *",
  "Where-Object *", "Get-Location", "Get-Date", "Get-Process *",
  "Get-Service *", "Test-Path *", "Resolve-Path *", "Split-Path *",
  "Join-Path *", "ConvertFrom-Json *", "Measure-Object *",
  "Group-Object *", "Sort-Object *", "Format-List *", "Format-Table *",
  "Out-String *", "ForEach-Object *", "Write-Host *", "Write-Output *",
  // ── Unix 只读 ──
  "ls *", "cat *", "grep *", "head *", "tail *", "wc *",
  "pwd", "which *", "date", "sort *", "uniq *", "du *", "df *",
  "file *", "stat *", "readlink *", "realpath *", "basename *", "dirname *",
  "uname *", "hostname", "whoami", "id *", "env *", "printenv *",
  // ── cmd 只读 ──
  "dir *", "type *", "findstr *", "where *",
  // ── Node/Python 版本查询 ──
  "node -v", "npm -v", "pnpm -v", "npm ls *",
  "python --version", "python3 --version", "pip list *",
  "git --version", "docker --version", "docker ps *",
  // ── 通用文件查看 ──
  "npx tsc --noEmit *", "npx eslint *",
];

/** 用户对一次审批的决策 */
export interface ApprovalDecision {
  choice: TrustScope | "once" | "reject";
  pattern?: string;
  /** 写入作用域：user=全局 / workspace=仅当前项目。默认 workspace */
  target?: "user" | "workspace";
  /** 用户手动编辑后的命令（有值时后端用此替代原命令执行） */
  editedCommand?: string;
}

/** gate 执行所需的外部能力（由 agentSession 注入闭包） */
export interface GateDeps {
  /** 弹出审批请求并等待用户决策 */
  requestApproval: (command: string, options: ReturnType<typeof buildTrustOptions>) => Promise<ApprovalDecision>;
  /** 危险命令确认弹窗：返回 true=仍要执行（仅本次，不信任），false=拒绝 */
  requestDangerousApproval?: (command: string, reason: string) => Promise<boolean>;
  /** 灾难命令被拦时，给用户一个可见提示（与给 AI 的错误分开）。
   *  仅在 requestDangerousApproval 未提供或超时时作为兜底。 */
  emitBlocked: (command: string, reason: string) => void;
  /** 持久化一条新批准的规则（exact/prefix；all 不持久化）。无则不落盘 */
  persist?: (rule: TrustRule, target?: "user" | "workspace") => void;
}

/** gate 结论 */
export interface GateOutcome {
  allow: boolean;
  /** 不放行时给 AI 的清晰、可恢复的错误文案 */
  aiMessage?: string;
  /** 给用户看的简短文案 */
  userMessage?: string;
  /** 用户编辑后的替代命令（有值时执行方应用此替代原命令） */
  editedCommand?: string;
}

export class CommandGate {
  private trie: CommandTrustTrie;

  constructor(patterns: string[] = BUILTIN_TRUSTED_PATTERNS) {
    this.trie = CommandTrustTrie.fromStrings(patterns);
  }

  /** 用一组模式重置白名单（host 从设置/存储读出后注入）。始终合并内置只读默认集 */
  setTrustedPatterns(patterns: string[]): void {
    this.trie = CommandTrustTrie.fromStrings([...BUILTIN_TRUSTED_PATTERNS, ...patterns]);
  }

  /** 当前最简白名单（供管理面板展示） */
  listRules(): TrustRule[] {
    return this.trie.list();
  }

  /** 手动新增一条规则（设置面板用） */
  addRule(pattern: string): void {
    this.trie.add(parsePattern(pattern));
  }

  isTrusted(command: string): boolean {
    return this.trie.isTrusted(command);
  }

  /** 对一条命令执行三层门控，返回是否放行 */
  async gate(command: string, deps: GateDeps): Promise<GateOutcome> {
    const danger = detectDangerousCommand(command);
    if (danger) {
      // 优先走确认弹窗（用户可选"仍要执行"）；未提供时退化为硬拦
      if (deps.requestDangerousApproval) {
        const accepted = await deps.requestDangerousApproval(command, danger);
        if (accepted) return { allow: true }; // 仅本次执行，不写入信任
      }
      deps.emitBlocked(command, danger);
      return {
        allow: false,
        aiMessage: `命令被安全策略拒绝：${danger}。请改用更精确、可控的方式（指明具体文件而非通配/递归），或由用户在终端手动执行。`,
        userMessage: `已拦截危险命令：${command}`,
      };
    }
    if (this.trie.isTrusted(command)) return { allow: true };

    const decision = await deps.requestApproval(command, buildTrustOptions(command));
    if (decision.choice === "reject") {
      return {
        allow: false,
        aiMessage: "用户拒绝执行该命令。请不要重试此命令；如确有必要，向用户说明用途后再请求，或改用其他方式完成任务。",
        userMessage: "用户拒绝执行命令",
      };
    }
    if (decision.choice === "once") return { allow: true, editedCommand: decision.editedCommand }; // 仅本次执行，不写白名单

    // exact / prefix / all → 写入信任；all 仅本会话不持久化
    const rule = ruleForChoice(command, decision.choice);
    this.trie.add(rule);
    if (decision.choice !== "all") deps.persist?.(rule, decision.target);
    return { allow: true, editedCommand: decision.editedCommand };
  }
}

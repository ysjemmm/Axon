/**
 * 命令信任门 —— 把 execute_command 的"信任白名单 → 人工确认"两层决策
 * 收敛到独立模块，agentSession 只做薄接线（避免继续撑大 agentSession）。
 *
 * 两层（按顺序）：
 *  ① CommandTrustTrie.isTrusted：命中白名单直接放行。
 *  ② 人工确认：未信任 → 弹三档（exact/partial/prefix/all）+ 仅本次 + 拒绝；批准则按档写入白名单。
 *     `all`(*) 仅本会话生效、不持久化。
 *
 * 风险检测（detectDangerousCommand）只产出**提醒**，不参与放行决策：
 * · 命中白名单的命令照常执行，不因风险二次确认（原因经 GateOutcome.warning 回传给前端展示）；
 * · 未信任的命令本来就要人工确认，风险原因作为附加信息一并展示。
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
  /** 弹出审批请求并等待用户决策。danger 非空时前端会闪烁红色警示。 */
  requestApproval: (command: string, options: ReturnType<typeof buildTrustOptions>, danger?: string) => Promise<ApprovalDecision>;
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
  /**
   * 风险提醒（命中 detectDangerousCommand 时给出），**不影响是否放行**。
   * 命令已放行，调用方应把它作为可见提示透传给用户。
   */
  warning?: string;
}

export class CommandGate {
  private trie: CommandTrustTrie;
  /** 同步重新从磁盘加载信任规则的回调（由 sessionHub 注入）。
   * gate() 在 isTrusted=false 时会调一次它再检查，解决 reload 后配置未就绪的时序竞态。 */
  private reloadFromDisk?: () => string[];

  constructor(patterns: string[] = BUILTIN_TRUSTED_PATTERNS) {
    this.trie = CommandTrustTrie.fromStrings(patterns);
  }

  /** 注入同步磁盘重载函数（sessionHub 创建 sharedCommandGate 后调用） */
  setReloadFn(fn: () => string[]): void {
    this.reloadFromDisk = fn;
  }

  /** 内部标志：save() 刚写入磁盘后会触发 onDidChangeConfiguration，
   * 但此时内存 trie 已经通过 gate() 的 trie.add() 更新了，
   * 不需要 reload。设此标志跳过下一次 setTrustedPatterns 调用。 */
  private skipNextReload = false;

  /** 标记：下一次 setTrustedPatterns 调用应跳过（由 save 触发，内存已是最新） */
  markSkipNextReload(): void {
    this.skipNextReload = true;
  }

  /** 用一组模式重置白名单（host 从设置/存储读出后注入）。始终合并内置只读默认集 */
  setTrustedPatterns(patterns: string[]): void {
    // 如果是 save() 刚写入触发的 reload，跳过——内存 trie 已经是最新的
    if (this.skipNextReload) {
      this.skipNextReload = false;
      return;
    }
    // 全量替换：用户在 Settings UI 里的增删改都会反映到内存 trie
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

  /** 对一条命令执行门控，返回是否放行 */
  async gate(command: string, deps: GateDeps): Promise<GateOutcome> {
    // 风险检测：只作为"提醒"透传，不决定是否放行（见文件头）。
    const warning = detectDangerousCommand(command) || undefined;
    let alreadyTrusted = this.trie.isTrusted(command);
    // reload 后配置未就绪时，trie 可能是空的——从磁盘重新加载一次再检查
    if (!alreadyTrusted && this.reloadFromDisk) {
      const patterns = this.reloadFromDisk();
      if (patterns.length > 0) {
        this.trie = CommandTrustTrie.fromStrings([...BUILTIN_TRUSTED_PATTERNS, ...patterns]);
        alreadyTrusted = this.trie.isTrusted(command);
      }
    }
    // 已信任：直接放行。命中风险模式时**不再二次确认**，只把原因回传给前端做提醒——
    // 用户已经明确信任过这条命令，再弹一次确认正是被投诉的那类打扰。
    if (alreadyTrusted) return { allow: true, warning };

    const decision = await deps.requestApproval(command, buildTrustOptions(command), warning);
    if (decision.choice === "reject") {
      return {
        allow: false,
        aiMessage: warning
          ? `用户拒绝执行风险命令（${warning}）。请改用更精确、可控的方式，或由用户在终端手动执行。`
          : "用户拒绝执行该命令。请不要重试此命令；如确有必要，向用户说明用途后再请求，或改用其他方式完成任务。",
        userMessage: warning ? `已拒绝风险命令：${command}` : "用户拒绝执行命令",
      };
    }
    if (decision.choice === "once") return { allow: true, editedCommand: decision.editedCommand }; // 仅本次执行，不写白名单

    // exact / prefix / all → 写入信任；all 仅本会话不持久化
    const rule = ruleForChoice(command, decision.choice);
    this.trie.add(rule);
    // 标记跳过下一次 reload：persist 写磁盘后会触发 onDidChangeConfiguration → reload，
    // 但内存 trie 已经通过上面的 add 更新了，reload 会用磁盘旧值覆盖。
    if (decision.choice !== "all") {
      this.markSkipNextReload();
      deps.persist?.(rule, decision.target);
    }
    return { allow: true, editedCommand: decision.editedCommand };
  }
}

import { executeToolCall, ToolName, type ToolMeta, type WebCapability } from "../tools/index.js";
import type { AgentHost } from "../host/index.js";
import type { SkillLoaderFn, PowerLoaderFn } from "../tools/definitions.js";
import { SNAPSHOT_TOOLS, SnapshotManager } from "../snapshot/index.js";
import { extractTargetFiles } from "./toolTargetFiles.js";
import { resolveInWorkspaces } from "../tools/search.js";
import type { LoopGuard } from "../agentGuards.js";

/** 通用工具执行请求。 */
export interface GenericToolExecuteRequest {
  toolName: string;
  toolArgs: Record<string, unknown>;
  meta: ToolMeta;
  /** 每轮运行时状态：不稳定，不能塞进 session 级单例里。 */
  runtime: {
    mode: "agent" | "quest";
    turnCount: number;
    signal?: AbortSignal;
    guard: LoopGuard;
    /**
     * AI 本会话改过、尚未通过诊断的文件（绝对路径）。
     * check_diagnostics 未显式指定 paths 时，默认检查这些文件——把全项目噪音扫描
     * 收窄到 AI 真正动过的文件。诊断通过后由会话侧从集合中移除（见 markDiagnosedFiles）。
     */
    aiTouchedFilesNeedingDiagnostics: Set<string>;
  };
}

/** 通用工具执行结果。 */
export interface GenericToolExecuteResult {
  result: string;
  status: "success" | "error";
}

/** GenericToolExecutor 的稳定依赖（session 级）。 */
export interface GenericToolExecutorDeps {
  cwd: string;
  host: AgentHost;
  workspaces?: string[];
  web?: WebCapability;
  skillLoader?: SkillLoaderFn;
  powerLoader?: PowerLoaderFn;
  snapshotMgr: SnapshotManager;
  sendSnapshotsListed: (snapshots: unknown[]) => void;
  trackTerminalCwd: (toolName: string, args: Record<string, unknown>, meta?: ToolMeta) => void;
}

/**
 * 通用工具执行器：封装 generic 路由（快照 + executeToolCall + read_file 额外提示）。
 *
 * 从 AgentSession.dispatchToolCall 迁出的下一刀，保持行为完全一致：
 * - 写文件工具执行前创建快照（问答模式不做快照）
 * - 调 executeToolCall 执行通用工具
 * - read_file 结果追加 LoopGuard 的"反复零碎读同一文件"提示
 */
export class GenericToolExecutor {
  constructor(private readonly deps: GenericToolExecutorDeps) {}

  async execute(req: GenericToolExecuteRequest): Promise<GenericToolExecuteResult> {
    const { toolName, meta } = req;
    const toolArgs = req.toolArgs;
    let result = "";
    let status: "success" | "error" = "success";

    // check_diagnostics 去重：把请求的文件过滤为"仍在待诊断集合里"的（即之前没诊断过、
    // 或诊断后又被改动过的）。已诊断通过且之后没再改动的文件跳过，避免重复跑 tsc。
    // 若过滤后一个都不剩，直接返回跳过提示，连 executeToolCall 都不调。
    // 跳过时标记 hidden，让前端不渲染这张无诊断内容的空卡片。
    if (toolName === ToolName.CheckDiagnostics) {
      const skip = await this.filterDiagnosticsPaths(toolArgs, req.runtime.aiTouchedFilesNeedingDiagnostics);
      if (skip) {
        meta.hidden = true;
        return skip;
      }
    }

    // 写文件类：执行前建快照（问答模式不做快照）
    if (req.runtime.mode !== "quest" && SNAPSHOT_TOOLS.has(toolName)) {
      const filesToSnapshot = await extractTargetFiles(toolName, toolArgs, this.deps.cwd, this.deps.host, this.deps.workspaces);
      if (filesToSnapshot.length > 0) {
        const turnId = `turn-${req.runtime.turnCount}`;
        const created = await this.deps.snapshotMgr.beforeEdit(turnId, filesToSnapshot).catch(() => false);
        if (created) {
          // 刷新左侧快照面板：与"这次编辑能否执行"无关，不该 await 在写文件之前。
          // list() 是一次全量 git for-each-ref（本仓库实测约 150ms），而 beforeEdit 内部的
          // prune() 刚刚已经跑过一遍——串行 await 只是白白推迟工具真正开始执行。
          void this.deps.snapshotMgr.list()
            .then((snapshots) => this.deps.sendSnapshotsListed(snapshots))
            .catch(() => { /* 面板刷新失败不影响编辑 */ });
        }
      }
    }

    try {
      result = await executeToolCall(
        toolName,
        toolArgs,
        this.deps.cwd,
        this.deps.host,
        meta,
        this.deps.workspaces,
        this.deps.skillLoader,
        this.deps.web,
        this.deps.powerLoader,
        req.runtime.signal,
      );
      this.deps.trackTerminalCwd(toolName, toolArgs, meta);
      if (toolName === "read_file" && typeof toolArgs.path === "string") {
        result += req.runtime.guard.noteFileRead(toolArgs.path);
      }
    } catch (err) {
      const error = err as Error & { userMessage?: string };
      result = `错误: ${error.message}`;
      status = "error";
      if (error.name === "ToolError" && error.userMessage && !meta.userMessage) {
        meta.userMessage = error.userMessage;
      }
    }

    return { result, status };
  }

  /**
   * check_diagnostics 去重过滤：把请求的文件过滤为"仍在待诊断集合里"的（即之前没诊断过、
   * 或诊断后又被改动过的）。已诊断通过且之后没再改动的文件跳过，避免重复跑 tsc。
   *
   * 仅当集合非空时才做过滤（集合为空说明追踪尚未生效或已被清空，此时放行所有文件）。
   *
   * @returns 若过滤后仍有待检查文件（或不做过滤），返回 undefined（继续正常执行）；
   *          若一个都不剩，返回一个跳过结果（调用方据此提前返回，不再调 executeToolCall）。
   */
  private async filterDiagnosticsPaths(
    toolArgs: Record<string, unknown>,
    touched: Set<string>,
  ): Promise<GenericToolExecuteResult | undefined> {
    // 集合为空 → 追踪尚未生效，不做过滤，放行
    if (touched.size === 0) return undefined;

    const requested = Array.isArray(toolArgs.paths)
      ? (toolArgs.paths as unknown[]).filter((p): p is string => typeof p === "string" && p.trim() !== "")
      : [];
    // 无显式路径时不介入，交给底层工具按原语义处理
    if (requested.length === 0) return undefined;

    const touchedNorm = new Set([...touched].map((p) => p.replace(/\\/g, "/").toLowerCase()));
    const kept: string[] = [];
    for (const rel of requested) {
      try {
        const abs = await resolveInWorkspaces(rel, this.deps.cwd, this.deps.host, this.deps.workspaces);
        if (touchedNorm.has(abs.replace(/\\/g, "/").toLowerCase())) {
          kept.push(rel);
        }
      } catch {
        kept.push(rel);
      }
    }

    if (kept.length === 0) {
      return {
        result: "本次 check_diagnostics 请求中的文件都已在之前成功诊断过，且之后没有再被 AI 改动；已跳过重复诊断。",
        status: "success",
      };
    }
    toolArgs.paths = kept;
    return undefined;
  }
}

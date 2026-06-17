/**
 * Relay 存储 - 落盘在 <workspace>/.axon/relays/<id>/
 *
 * 目录布局：
 *   <workspace>/.axon/relays/<id>/
 *     ├── relay.json        元数据（RelayMeta：阶段、任务、确认门状态等）
 *     ├── requirements.md   需求文档（brainstorm 阶段产出）
 *     ├── design.md         设计文档（design 阶段产出）
 *     └── plan.md           任务计划（plan 阶段产出，含复选框任务清单）
 *
 * 设计要点：
 * - 元数据与文档分离：relay.json 机器读写，md 文件人/机都可读可手改
 * - 任务清单以 plan.md 的复选框为「单一事实源」：读取时从 plan.md 解析，
 *   状态变更同时回写 plan.md 和 relay.json.tasks，保证两边一致
 * - 跟随工作区而非用户目录：relay 是项目级产物，团队可随仓库共享
 */

import { join } from "node:path";
import type { RelayData, RelayMeta, RelaySummary, RelayPhase, RelayTask, RelayQualityConfig, TaskReview, TaskReviewStatus } from "./types.js";
import { toRelaySummary, slugify, PHASE_DOC_FILE, DEFAULT_QUALITY_CONFIG } from "./types.js";
import { parseTasks, writeBackTaskStatus } from "./planParser.js";
import type { AgentHost } from "../host/index.js";

/** Relay 根目录：<workspace>/.axon/relays */
function relaysRoot(workspace: string): string {
  return join(workspace, ".axon", "relays");
}

/** 单个 relay 目录 */
function relayDir(workspace: string, id: string): string {
  return join(relaysRoot(workspace), id);
}

/**
 * Relay 存储管理器。每个工作区一套 relays 目录；多工作区时以主工作区为准
 * （relay 是任务级产物，归属创建它的主工作区）。
 */
export class RelayStore {
  constructor(private workspace: string, private host: AgentHost) {}

  /** 切换主工作区（会话切换工作区组时调用） */
  setWorkspace(workspace: string): void {
    this.workspace = workspace;
  }

  private async pathExists(p: string): Promise<boolean> {
    return (await this.host.fs.stat(p)) !== null;
  }

  private async readFileSafe(p: string): Promise<string> {
    return (await this.host.fs.read(p)) ?? "";
  }

  /** 列出当前工作区下所有 relay 摘要（按 updatedAt 降序） */
  async list(): Promise<RelaySummary[]> {
    const root = relaysRoot(this.workspace);
    if (!(await this.pathExists(root))) return [];
    let entries: import("../host/index.js").DirChild[];
    try {
      entries = await this.host.fs.readdir(root);
    } catch {
      return [];
    }
    const summaries: RelaySummary[] = [];
    for (const entry of entries) {
      if (!entry.isDir) continue;
      const meta = await this.readMeta(entry.name);
      if (meta) summaries.push(toRelaySummary(meta));
    }
    summaries.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    return summaries;
  }

  /** 读取 relay.json 元数据（不含文档正文） */
  private async readMeta(id: string): Promise<RelayMeta | null> {
    const metaPath = join(relayDir(this.workspace, id), "relay.json");
    const raw = await this.readFileSafe(metaPath);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as RelayMeta;
    } catch {
      return null;
    }
  }

  /** 写入 relay.json 元数据 */
  private async writeMeta(meta: RelayMeta): Promise<void> {
    const dir = relayDir(this.workspace, meta.id);
    await this.host.fs.mkdirp(dir);
    await this.host.fs.write(join(dir, "relay.json"), JSON.stringify(meta, null, 2));
  }

  /** 获取完整 relay（元数据 + 三份文档正文）。任务以 plan.md 解析为准，但保留 meta 里的评审状态。 */
  async get(id: string): Promise<RelayData | null> {
    const meta = await this.readMeta(id);
    if (!meta) return null;
    const dir = relayDir(this.workspace, id);
    const requirements = await this.readFileSafe(join(dir, "requirements.md"));
    const design = await this.readFileSafe(join(dir, "design.md"));
    const plan = await this.readFileSafe(join(dir, "plan.md"));

    // plan.md 提供任务【结构】（哪些任务、标题、层级）；但任务的【状态与评审】以 relay.json
    // 为单一事实源——因为复选框只有 [ ]/[x] 两态，表达不了 in_progress，也不含评审信息。
    // 因此解析 plan.md 拿结构，status/reviewStatus/review/deps 一律优先用 meta.tasks 记录的值。
    let tasks = meta.tasks;
    if (plan.trim()) {
      const parsed = parseTasks(plan);
      const byId = new Map(meta.tasks.map((t) => [t.id, t]));
      tasks = parsed.map((t) => {
        const prev = byId.get(t.id);
        if (!prev) return t; // plan.md 新增的任务，meta 里还没有
        return {
          ...t,
          status: prev.status,           // 状态以 relay.json 为准（含 in_progress）
          deps: prev.deps,
          reviewStatus: prev.reviewStatus,
          review: prev.review,
        };
      });
    }

    return { ...meta, tasks, requirements, design, plan };
  }

  /** 创建一个新 relay（仅元数据，文档随阶段推进再写入） */
  async create(params: { title: string; summary: string; sessionId?: string; quality?: RelayQualityConfig }): Promise<RelayData> {
    const now = new Date().toISOString();
    let id = slugify(params.title);
    // 避免目录冲突：已存在则追加短后缀
    if (await this.pathExists(relayDir(this.workspace, id))) {
      id = `${id}-${Date.now().toString(36).slice(-4)}`;
    }
    const meta: RelayMeta = {
      id,
      title: params.title,
      summary: params.summary,
      phase: "brainstorm",
      tasks: [],
      approvals: {},
      quality: params.quality || { ...DEFAULT_QUALITY_CONFIG },
      sessionId: params.sessionId,
      createdAt: now,
      updatedAt: now,
    };
    await this.writeMeta(meta);
    return { ...meta, requirements: "", design: "", plan: "" };
  }

  /**
   * 写入某阶段的文档正文（requirements/design/plan），并同步元数据。
   * 写 plan.md 时自动解析任务清单写回 meta.tasks。
   */
  async saveDoc(id: string, phase: RelayPhase, content: string): Promise<RelayData | null> {
    const meta = await this.readMeta(id);
    if (!meta) return null;
    const fileName = PHASE_DOC_FILE[phase];
    if (!fileName) throw new Error(`阶段 ${phase} 没有对应的文档文件`);

    const dir = relayDir(this.workspace, id);
    await this.host.fs.mkdirp(dir);
    await this.host.fs.write(join(dir, fileName), content);

    // plan 文档：解析任务清单同步到元数据
    if (phase === "plan") {
      meta.tasks = parseTasks(content);
    }
    meta.updatedAt = new Date().toISOString();
    await this.writeMeta(meta);
    return this.get(id);
  }

  /**
   * 推进阶段：把指定阶段标记为已确认（通过 checkpoint），并把 relay 推进到下一阶段。
   * @param id relay id
   * @param approvePhase 要确认通过的当前阶段
   * @param toPhase 推进到的目标阶段
   */
  async advancePhase(id: string, approvePhase: RelayPhase, toPhase: RelayPhase): Promise<RelayData | null> {
    const meta = await this.readMeta(id);
    if (!meta) return null;
    meta.approvals[approvePhase] = true;
    meta.phase = toPhase;
    meta.updatedAt = new Date().toISOString();
    await this.writeMeta(meta);
    return this.get(id);
  }

  /** 直接设置阶段（不走确认门，用于回退编辑等场景） */
  async setPhase(id: string, phase: RelayPhase): Promise<RelayData | null> {
    const meta = await this.readMeta(id);
    if (!meta) return null;
    meta.phase = phase;
    meta.updatedAt = new Date().toISOString();
    await this.writeMeta(meta);
    return this.get(id);
  }

  /**
   * 更新单个任务状态，同时回写 plan.md 复选框与 relay.json.tasks。
   * @returns 更新后的完整 relay
   */
  async setTaskStatus(id: string, taskId: string, status: RelayTask["status"]): Promise<RelayData | null> {
    const meta = await this.readMeta(id);
    if (!meta) return null;
    const dir = relayDir(this.workspace, id);
    const planPath = join(dir, "plan.md");
    const planRaw = await this.readFileSafe(planPath);

    // plan.md 提供结构，但状态/评审以 meta.tasks 为准合并（避免重解析丢掉 in_progress 与评审字段）
    const byId = new Map(meta.tasks.map((t) => [t.id, t]));
    const tasks: RelayTask[] = planRaw.trim()
      ? parseTasks(planRaw).map((t) => {
          const prev = byId.get(t.id);
          return prev ? { ...t, status: prev.status, deps: prev.deps, reviewStatus: prev.reviewStatus, review: prev.review } : t;
        })
      : meta.tasks;
    const target = tasks.find((t) => t.id === taskId);
    if (!target) return this.get(id);
    target.status = status;

    // 回写 plan.md 复选框（只反映完成与否；in_progress 在复选框里等同未完成）
    if (planRaw.trim()) {
      const updatedPlan = writeBackTaskStatus(planRaw, tasks);
      await this.host.fs.write(planPath, updatedPlan);
    }

    // 同步元数据
    meta.tasks = tasks;
    // 全部完成则自动进入 done
    if (tasks.length > 0 && tasks.every((t) => t.status === "completed")) {
      meta.phase = "done";
    }
    meta.updatedAt = new Date().toISOString();
    await this.writeMeta(meta);
    return this.get(id);
  }

  /**
   * 更新某个任务的评审状态/结果，写入 relay.json（plan.md 不含评审信息）。
   * @param status 评审流转状态
   * @param review 可选的两阶段评审结果
   */
  async setTaskReview(
    id: string,
    taskId: string,
    status: TaskReviewStatus,
    review?: TaskReview,
  ): Promise<RelayData | null> {
    const meta = await this.readMeta(id);
    if (!meta) return null;
    const dir = relayDir(this.workspace, id);
    const planRaw = await this.readFileSafe(join(dir, "plan.md"));
    // 以 plan.md 为基重建任务结构，状态与评审字段以 meta.tasks 为准合并（不丢 in_progress/评审）
    const parsed = planRaw.trim() ? parseTasks(planRaw) : meta.tasks;
    const byId = new Map(meta.tasks.map((t) => [t.id, t]));
    const tasks: RelayTask[] = parsed.map((t) => {
      const prev = byId.get(t.id);
      return prev ? { ...t, status: prev.status, deps: prev.deps, reviewStatus: prev.reviewStatus, review: prev.review } : t;
    });
    const target = tasks.find((t) => t.id === taskId);
    if (!target) return this.get(id);
    target.reviewStatus = status;
    if (review) target.review = review;

    meta.tasks = tasks;
    meta.updatedAt = new Date().toISOString();
    await this.writeMeta(meta);
    return this.get(id);
  }

  /** 删除一个 relay（连同目录） */
  async remove(id: string): Promise<void> {
    const dir = relayDir(this.workspace, id);
    await this.host.fs.remove(dir).catch(() => {});
  }
}

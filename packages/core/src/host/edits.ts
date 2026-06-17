/**
 * 改动呈现/落盘抽象（执行端 ① 的核心，形态差异最大）
 *
 * 这是方案 C（深度集成 IDE）相对方案 A（仅 webview）体验差异的关键所在：
 * - NodeAgentHost：沿用现有暂存区机制——auto 直接写盘，manual 存内存待确认，
 *   diff 由前端自绘（web 形态没有编辑器原生 diff 能力）。
 * - VSCodeAgentHost：走 WorkspaceEdit + 原生 diff 编辑器 + SCM，
 *   accept/reject 复用 IDE 自身的 diff 视图交互。
 *
 * core 的 tools.ts 不再自己读写暂存 Map，而是把“一处改动”交给 EditPresenter.present，
 * 由具体形态决定如何呈现与落盘。core 仍保留 diff 基准计算等纯逻辑。
 */

/**
 * 一处局部改动块（撤销锚点）。用「上下文指纹包夹」法精确定位、安全反向：
 * 撤销时在当前文件里查找 `beforeContext + newStr + afterContext` 这个长串，
 * 唯一命中才把中间的 newStr 换回 oldStr。比单找 newStr 独特得多，且：
 * - 不依赖行号（规避后续编辑导致的行号漂移误判）
 * - 天然支持 newStr="" 的纯删除撤销（靠 before+after 相邻指纹定位插入点）
 * - 多处 / 零处命中一律判失败（保守，绝不撤错位置）
 *
 * 约定：四个字段均为 CRLF 归一化（\n）后的文本，且
 * `beforeContext + newStr + afterContext` 在「编辑落地后的文件」中是一段真实连续子串。
 */
export interface EditHunk {
  /** 被替换掉的原文（撤销目标） */
  oldStr: string;
  /** 替换后的新文（撤销时要被换回 oldStr 的部分；纯删除时为 ""） */
  newStr: string;
  /** newStr 之前紧邻的上下文指纹（最多若干行） */
  beforeContext: string;
  /** newStr 之后紧邻的上下文指纹（最多若干行） */
  afterContext: string;
}

/** 一处文件改动（与现有 tools.PendingEdit 对齐） */
export interface FileEdit {
  /** 相对路径（AI 使用的路径，用于展示） */
  path: string;
  /** 改动的目标绝对路径（落盘/定位用） */
  absPath: string;
  /** 首次暂存时捕获的磁盘原始内容（用于回滚） */
  originalContent: string;
  /** 最新的待确认/落盘内容 */
  newContent: string;
  /** 是否为新建文件（原文件不存在） */
  isNew: boolean;
  /**
   * 局部改动块（撤销锚点）。str_replace=1 块；apply_patch update=N 块（按应用顺序）。
   * create_file（整文件语义）不带 hunks——撤销走 isNew 删除 / originalContent 整体回退。
   * manual 模式下同文件多次编辑会按顺序累加。
   */
  hunks?: EditHunk[];
  /**
   * 是否为整文件写入（create_file / apply_patch Add File）。
   * 整文件写入无法用 hunk 反向精确撤销，撤销时走整体语义（删除新建文件 / 写回 originalContent）。
   * 同一文件一旦发生过整文件写入，该标记在 manual 暂存合并中保持为 true。
   */
  fullRewrite?: boolean;
  /**
   * 编辑单元 id（= `${toolCallId}::${相对路径}`）。这是「待确认/可撤销」的最小管理单元：
   * 同一文件被多次工具调用修改 → 多个独立单元，可逐次接受/拒绝/撤销。
   * accept/reject/undo 的 target 既可传 editId（精确到一次改动），也可传 path（整文件所有改动）。
   */
  editId?: string;
}

/** 一笔「已接受、可撤销」的文件改动记录 */
export interface UndoableEdit {
  path: string;
  absPath: string;
  /** 编辑单元 id（撤销时按此精确定位某一次改动） */
  editId: string;
  /** 是否 create_file（整文件语义：撤销=删文件 / 写回 originalContent，而非反向 hunk） */
  isCreate: boolean;
  /** 新建文件（撤销=删除） */
  isNew: boolean;
  /** 整文件撤销基准（create_file 覆盖已有文件时回退用） */
  originalContent: string;
  /** 局部改动块（撤销=按逆序反向应用） */
  hunks: EditHunk[];
  /** 接受时间戳（LIFO 排序用） */
  acceptedAt: number;
}

/** 撤销结果。ok=false 时 reason 为给用户的轻提示文案 */
export interface UndoResult {
  ok: boolean;
  path?: string;
  reason?: string;
}

/** 一处改动的 diff 视图载荷（推送给 UI 展示用） */
export interface FileDiff {
  path: string;
  oldContent: string;
  newContent: string;
}

/** 编辑模式：auto 直接落盘 / manual 暂存待用户确认 */
export type EditMode = "auto" | "manual";

/**
 * 改动呈现器。负责“一处改动如何对用户生效与可见”。
 *
 * 关键设计：present 返回一段【给 AI 的提示文本】（与现有 applyEdit 返回值语义一致）。
 * - auto 模式实现：落盘后通常返回空串
 * - manual 模式实现：返回“改动已暂存，等待确认”之类的提示，让后续 read_file 能读到暂存内容
 */
export interface EditPresenter {
  /** 当前编辑模式 */
  getMode(): EditMode;
  /** 设置编辑模式（用户在 UI 切换 auto/manual 时调用） */
  setMode(mode: EditMode): void;

  /**
   * 呈现一处改动。auto 落盘 / manual 暂存。
   * @returns 给 AI 的附加提示文本（无则空串）
   */
  present(edit: FileEdit): Promise<string>;

  /**
   * 读取某文件的“有效内容”：manual 模式下若有暂存改动，返回暂存的新内容而非磁盘内容，
   * 保证 AI 工作流连贯（对齐现有 readEffectiveContent）。
   * @returns content 为有效内容；fromPending 表示来自暂存区；existsOnDisk 表示磁盘是否存在
   */
  readEffective(absPath: string): Promise<{ content: string; fromPending: boolean; existsOnDisk: boolean }>;

  /** 接受待确认改动并落盘；target（相对路径或绝对路径，省略=全部）。返回被接受的相对路径列表 */
  accept(target?: string): Promise<string[]>;

  /**
   * 拒绝待确认改动。target 可为 editId（精确到某一次改动）或 path（整文件），省略=全部。
   * 单元级拒绝走反向引擎（仅回退这一次的 hunk，其余改动保留）；定位歧义/重叠时保守失败。
   * 返回被拒绝的相对路径列表。
   */
  reject(target?: string): Promise<string[]>;

  /**
   * 已接受、可撤销的相对路径列表（按接受时间倒序，LIFO）。
   * 前端据此在「已接受」的编辑卡片上显示「撤销」图标。
   */
  getUndoablePaths(): string[];

  /** 已接受、可撤销的编辑单元 id 列表（供前端逐次卡片精确匹配） */
  getUndoableEditIds(): string[];

  /**
   * 撤销某个已接受改动（反向应用 hunks / 删除新建文件 / 回退覆盖）。
   * target 可为 editId（精确到某一次改动）或 path（整文件最近一次）。
   * 严格保守：定位歧义（多处/零处命中）一律判失败、绝不猜测落点，保证原子性
   * （要么全部 hunk 成功反向、要么完全不动文件）。
   * @returns 撤销结果；ok=false 时 reason 为给用户的轻提示
   */
  undo(target: string): Promise<UndoResult>;

  /** 是否存在待确认改动 */
  hasPending(): boolean;

  /** 待确认改动的相对路径列表（去重，供底部汇总面板/整文件操作） */
  getPendingPaths(): string[];

  /** 待确认改动的编辑单元 id 列表（供前端逐次卡片精确匹配） */
  getPendingEditIds(): string[];

  /** 待确认改动的完整 diff（按文件聚合：最早单元前内容 → 最新内容），供 UI 汇总展示 */
  getPendingDiffs(): FileDiff[];

  /** 序列化暂存区（持久化用）；无暂存能力的形态返回空数组 */
  serialize(): FileEdit[];

  /** 从持久化数据恢复暂存区 */
  restore(edits: FileEdit[]): void;

  /**
   * 派生一个【全新的、独立暂存区】的同类型 EditPresenter，并指定其编辑模式。
   *
   * 用途：子 Agent（delegate/research/review）必须用独立的 auto 模式 EditPresenter——
   * 它的落盘不能污染主 Agent 的 manual 暂存区。core 在不知道具体实现类的情况下，
   * 通过本方法让父 EditPresenter 自行 new 一个同类型的干净实例。
   */
  fork(mode: EditMode): EditPresenter;
}

import type { EventBase } from "./eventModel.js";

/**
 * 工具类型大类：用于前端默认展示、状态提示、统计与路由。
 *
 * 说明：
 * - toolName 解决“具体是哪个工具”。
 * - toolKind 解决“这类工具属于哪一组能力”。
 * - 后续前端图标、默认 title/status 文案、trace 聚合统计都优先基于 toolKind，再按 toolName 做细分。
 */
export type ToolKind =
  | "read"
  | "search"
  | "edit"
  | "command"
  | "diagnostics"
  | "browser"
  | "network"
  | "orchestration"
  | "other";

/**
 * 工具执行阶段：描述单个工具调用在系统内的主生命周期。
 *
 * 说明：
 * - planned：模型已决定调用该工具，但宿主尚未真正开始执行
 * - executing：Axon 已拿到完整参数并开始执行工具
 * - completed：工具执行成功完成
 * - failed：工具执行失败
 * - cancelled：工具在完成前被取消
 */
export type ToolPhase = "planned" | "executing" | "completed" | "failed" | "cancelled";

/**
 * 工具门控状态：描述工具是否卡在用户输入/确认/安全门等执行前环节。
 *
 * 说明：
 * - none：无门控，工具可直接执行
 * - waiting_confirm：等待用户确认
 * - waiting_input：等待用户补充输入
 * - blocked：被安全门或规则直接拦截
 */
export type ToolGateState = "none" | "waiting_confirm" | "waiting_input" | "blocked";

/**
 * 工具结果语义：描述工具虽然已经 completed/failed，但其结果在业务层的附加语义。
 *
 * 说明：
 * - normal：普通结果
 * - noop：执行成功但没有实际变化（如 no-op 编辑）
 * - hidden：对用户隐藏的结果（常见于试探性调用或内部纠错反馈）
 * - partial：部分成功，部分失败或信息不完整
 * - rejected：被用户拒绝/未采纳
 * - reverted：已执行结果后续被撤销
 */
export type ToolOutcomeKind = "normal" | "noop" | "hidden" | "partial" | "rejected" | "reverted";

/**
 * 工具事件公共基类。
 *
 * 目标：
 * - 统一所有工具调用在事件层的公共结构
 * - 上层先基于这组稳定字段完成状态机、trace、前端卡片路由
 * - 各具体工具再在此基础上扩展自己的私有属性
 */
export interface ToolEventBase extends EventBase {
  /** 工具事件统一类型。 */
  type: "tool.phase";
  /** 工具事件默认来源于 tool 层。 */
  source: "tool";
  /** 单次工具调用唯一 id，用于关联参数拼接、执行、结果和前端卡片。 */
  callId: string;
  /** 工具名，如 read_file、search、execute_command。 */
  toolName: string;
  /** 工具所属大类，用于默认展示、状态提示、统计与路由。 */
  toolKind: ToolKind;
  /** 工具当前主阶段。 */
  phase: ToolPhase;
  /**
   * 工具事件层级。
   *
   * 建议约定：
   * - `planned` / `executing` 通常属于 `runtime`
   * - `completed` / `failed` / `cancelled` 通常属于 `committed`
   *
   * 第一阶段先允许显式传入，后续若稳定，可再进一步抽成按 phase 自动推导。
   */
  stage: EventBase["stage"];
  /** 工具当前是否处于门控状态。 */
  gateState?: ToolGateState;
  /** 工具结果的附加业务语义。 */
  outcomeKind?: ToolOutcomeKind;
  /** 原始参数文本（调试时用于查看模型最初产出的参数串）。 */
  rawArgsText?: string;
  /** 解析后的结构化参数对象。 */
  parsedArgs?: Record<string, unknown>;
  /**
   * 面向 AI 的工具结果载荷。
   *
   * 设计说明：
   * - 与展示层文案分离，避免“给 AI 的真实结果/错误”直接泄露到用户卡片。
   * - 第一阶段先统一成最小结构：ok + result/error；后续需要附加更多 AI 消费字段时，可继续扩展。
   */
  aiPayload?: {
    ok: boolean;
    result?: string;
    error?: string;
  };
  /**
   * 调试/追踪用的原始执行载荷。
   *
   * 设计说明：
   * - rawResult/rawError 保留完整现场，服务于 trace、排障、协议对照。
   * - 这层不直接面向普通用户展示，也不应作为前端主卡片文案来源。
   * - 与 aiPayload 分离后，可避免“给 AI 的结果”和“调试现场原文”继续混在同一层字段里。
   */
  tracePayload?: {
    rawResult?: string;
    rawError?: string;
  };
  /**
   * 事件可见性语义。
   *
   * 说明：
   * - normal：正常展示给用户
   * - suppressed：默认不在普通 UI 中展示，但事件本身仍保留，可用于 trace / debug
   * - debug_only：仅调试视图展示，普通用户界面不显示
   */
  visibility?: "normal" | "suppressed" | "debug_only";
  /**
   * 面向展示层的目标摘要。
   *
   * 说明：
   * - 仅用于卡片文案、状态提示、trace 快速浏览等“人类可读”的目标展示。
   * - 不保证结构稳定，不应用作核心逻辑判断依据。
   * - 真正的结构化判断应优先使用 toolName / toolKind / parsedArgs / meta。
   */
  targetLabel?: string;
}

/** read_file（文件读取）工具的专属扩展。 */
export interface ReadFileToolEvent extends ToolEventBase {
  toolName: "read_file";
  toolKind: "read";
  meta?: {
    readTarget?: {
      path?: string;
      resolvedPath?: string;
      readRange?: string;
    };
  };
}

/** browser_get_html（浏览器 DOM 读取）工具的专属扩展。 */
export interface BrowserGetHtmlToolEvent extends ToolEventBase {
  toolName: "browser_get_html";
  toolKind: "browser";
  meta?: {
    readTarget?: {
      target?: string;
    };
  };
}

/** search（代码/文件检索）工具的专属扩展。 */
export interface WorkspaceSearchToolEvent extends ToolEventBase {
  toolName: "search";
  toolKind: "search";
  meta?: {
    searchQuery?: {
      intent?: string;
      query?: string;
      source?: string;
    };
    searchResult?: {
      resultsCount?: number;
    };
  };
}

/** web_search（联网搜索）工具的专属扩展。 */
export interface WebSearchToolEvent extends ToolEventBase {
  toolName: "web_search";
  toolKind: "network";
  meta?: {
    searchQuery?: {
      intent?: string;
      query?: string;
      source?: string;
    };
    searchResult?: {
      resultsCount?: number;
    };
  };
}

/** str_replace / create_file / apply_patch 等编辑型工具的公共扩展。 */
export interface EditToolEvent extends ToolEventBase {
  toolName: "str_replace" | "create_file" | "apply_patch";
  toolKind: "edit";
  meta?: {
    editResult?: {
      /** 本次改动涉及的主路径（单文件场景）。 */
      diffPath?: string;
      /** 本次改动涉及的全部路径（多文件场景）。 */
      diffPaths?: string[];
      /** 执行成功但未产生任何实际内容变化。 */
      noopEdit?: boolean;
    };
    editState?: {
      /** 当前改动是否仍处于待确认状态。 */
      pending?: boolean;
      /** 当前改动是否已被用户拒绝。 */
      rejected?: boolean;
      /** 当前改动是否已被撤销。 */
      reverted?: boolean;
      /** 当前改动是否可撤销。 */
      undoable?: boolean;
    };
  };
}

/** execute_command 的专属扩展。 */
export interface ExecuteCommandToolEvent extends ToolEventBase {
  toolName: "execute_command";
  toolKind: "command";
  meta?: {
    commandRequest?: {
      requestedCommand?: string;
      executedCommand?: string;
      cwd?: string;
    };
  };
}

/** check_diagnostics 的专属扩展。 */
export interface DiagnosticsToolEvent extends ToolEventBase {
  toolName: "check_diagnostics";
  toolKind: "diagnostics";
  meta?: {
    diagnosticsResult?: {
      diagnostics?: Array<{
        path: string;
        ok: boolean;
        errorCount: number;
      }>;
    };
  };
}

/**
 * 通用兜底工具事件。
 *
 * 说明：
 * - 用于尚未单独建模的工具类型。
 * - 仍要求 meta 保持“按语义分组的结构化对象”，避免重新退化成任意顶层字段大杂烩。
 * - 当某类工具被频繁使用、前端需要专门展示，或 trace 需要稳定结构时，应优先从 GenericToolEvent 升级为专属事件类型。
 */
export interface GenericToolEvent extends ToolEventBase {
  meta?: {
    [group: string]: Record<string, unknown> | string | number | boolean | undefined;
  };
}

/** 内部统一工具事件联合类型。 */
export type ToolEvent =
  | ReadFileToolEvent
  | BrowserGetHtmlToolEvent
  | WorkspaceSearchToolEvent
  | WebSearchToolEvent
  | EditToolEvent
  | ExecuteCommandToolEvent
  | DiagnosticsToolEvent
  | GenericToolEvent;

/**
 * 统一事件模型（第一阶段定义层）
 *
 * 目标：
 * 1. 统一 Chat Completions / Responses 两条协议在 Axon 内部的语义表示。
 * 2. 明确 request / turn / reasoning / tool 的边界，避免后续实现继续混用概念。
 * 3. 为后续的 turn assembler、前端交替式渲染、最近一次对话现场(trace) 提供稳定地基。
 *
 * 设计原则：
 * - 该文件只定义“内部标准模型”，不直接耦合某个 provider 的原始字段。
 * - request 表示用户的一次完整问题/任务；turn 表示系统为完成该 request 的一次内部 LLM 推进。
 * - reasoning / content / tool 默认都归属于某个 turn，而 turn 隶属于 request。
 * - 调试场景必须可追溯，因此所有事件都强制带时间戳；可见事件默认带 requestId，绝大多数带 turnId。
 */

import type { ToolEvent } from "./toolEventModel.js";

/** 当前支持的底层协议类型。 */
export type ProtocolKind = "chat_completions" | "responses";

/** 请求阶段：对应用户视角的一次完整任务生命周期。 */
export type RequestPhase = "start" | "running" | "complete" | "error" | "cancelled";

/** turn 阶段：对应 request 内一次内部 LLM 推进的生命周期。 */
export type TurnPhase = "start" | "running" | "complete" | "truncated" | "error" | "cancelled";

/** 状态提示阶段：供前端展示“当前大体正在做什么”。 */
export type StatusPhase =
  | "idle"
  | "thinking"
  | "reasoning"
  | "acting"
  | "responding"
  | "waiting"
  | "completed"
  | "error"
  | "cancelled";

/**
 * 状态细分码：用于代码逻辑判断，比 phase 更细，但仍保持为稳定、可枚举的内部语义。
 *
 * 设计原则：
 * - phase 负责表达“大阶段”（如 acting / responding）。
 * - code 负责表达“当前具体动作”（如 search_workspace / read_file / render_mermaid）。
 * - text 负责面向前端展示，允许动态变化，但 code 应尽量稳定。
 */
export type StatusCode =
  | "idle"
  | "thinking"
  | "reasoning"
  | "search_workspace"
  | "read_file"
  | "list_dir"
  | "edit_file"
  | "apply_patch"
  | "execute_command"
  | "check_diagnostics"
  | "web_search"
  | "web_fetch"
  | "browser_open"
  | "browser_interact"
  | "render_drawing"
  | "render_mermaid"
  | "render_svg"
  | "summarizing"
  | "waiting_confirm"
  | "waiting_input"
  | "completed"
  | "error"
  | "cancelled";

/** content 的最终语义归类。 */
export type ContentRole = "answer" | "narration";

/** reasoning 内容类型。第一阶段先保留最常见的 summary/full 区分。 */
export type ReasoningKind = "summary" | "full";

/** debug 事件类型：用于协议级排障与 trace 记录。 */
export type DebugKind = "request" | "protocol_raw" | "normalized";

/** 统一事件层级：区分运行中草案事件与已提交事件。 */
export type EventStage = "runtime" | "committed";

/** request 唯一标识：一次用户问题/任务对应一个 request。 */
export type RequestId = string;

/**
 * turn 唯一标识：同一个 request 内可能包含多个 turn。
 *
 * 示例：
 * - request = “帮我定位 bug 并修复”
 * - turn1 = 搜索相关文件
 * - turn2 = 读取文件
 * - turn3 = 修改代码
 * - turn4 = 最终总结
 */
export type TurnId = string;

/** 事件来源：用于标识该事件最初由哪一层产生。 */
export type EventSource = "llm" | "tool" | "system" | "debug";

/**
 * 统一事件基类。
 *
 * 设计说明：
 * - 所有事件都必须带时间戳，保证问题现场可回放、可排序、可做时序调试。
 * - requestId 用于标识“这条事件属于哪次用户请求”。
 * - turnId 用于标识“这条事件属于 request 内的哪一次内部推进”；request 顶层事件可省略。
 * - source 用于调试和事件路由，帮助区分该事件来自 LLM、工具执行、系统状态机还是调试链路。
 */
export interface EventBase {
  /** 事件类型名，推荐使用 dot.case 风格（如 content.delta、tool.executing）。 */
  type: string;
  /** ISO 8601 时间戳，要求在事件产生时就写入，不依赖外层补填。 */
  ts: string;
  /** 本事件所属的 request。 */
  requestId: RequestId;
  /** 本事件所属的 turn。request 级事件和少数全局 debug 事件可省略。 */
  turnId?: TurnId;
  /** 事件来源层，用于排障与协议/执行链路区分。 */
  source: EventSource;
  /** 事件层级：运行态草案 or 已提交事件。 */
  stage: EventStage;
}

/**
 * request 事件：表示一次用户任务的整体生命周期。
 *
 * 说明：
 * - request 是最外层容器，用户只看到“我提了一次问题，AI 处理了一次任务”。
 * - request 内部可能包含多个 turn，但 request.completed / request.error 只发生一次。
 * - running 表示该 request 仍在进行中，内部可能还会继续产生多个 turn。
 */
export interface RequestEvent extends EventBase {
  type: "request.phase";
  /** request 事件默认来源于 system 层。 */
  source: "system";
  /** request 事件默认属于已提交层。 */
  stage: "committed";
  phase: RequestPhase;
  /** 任务完成/失败时的补充原因，如 provider failed、用户取消等。 */
  reason?: string;
  /** 仅在异常/失败场景下提供面向调试的错误消息。 */
  error?: string;
}

/**
 * turn 事件：表示同一个 request 内，一次内部 LLM 推进的生命周期。
 *
 * 说明：
 * - turn 是 request 内部步骤级容器，content / reasoning / tool 默认直接归属于 turn。
 * - truncated 归属于 turn，而不是 request：某一轮输出被截断后，request 仍可能继续推进并最终成功完成。
 */
export interface TurnEvent extends EventBase {
  type: "turn.phase";
  /** turn 事件默认来源于 system 层。 */
  source: "system";
  /** turn 事件默认属于已提交层。 */
  stage: "committed";
  /** turn 事件必须明确归属于一个具体 turn。 */
  turnId: TurnId;
  phase: TurnPhase;
  /** 本轮完成/截断/失败时的补充原因，如 length、provider failed、用户取消等。 */
  reason?: string;
  /** 仅在异常/失败场景下提供面向调试的错误消息。 */
  error?: string;
}

/**
 * content 增量事件：表示模型通过“正文通道”输出的可见内容片段。
 *
 * 注意：
 * - 这里的 text 只是流式片段，不代表最终一定会归档成 answer。
 * - 某些 turn 中，content 最终可能被归类为 narration（例如工具前的过程性叙述）。
 */
export interface ContentDeltaEvent extends EventBase {
  type: "content.delta";
  /** content 增量事件默认来源于 llm。 */
  source: "llm";
  /** content 增量事件默认属于运行态草案层。 */
  stage: "runtime";
  /** 本次新增的正文片段。 */
  text: string;
}

/**
 * content 提交事件：表示某段正文在本 turn 收尾时被正式归类。
 *
 * 说明：
 * - answer：真正给用户的最终回答内容。
 * - narration：模型在工具调用前后给出的过程性叙述，不等于 reasoning。
 */
export interface ContentCommitEvent extends EventBase {
  type: "content.commit";
  /** content 提交事件默认来源于 llm。 */
  source: "llm";
  /** content 提交事件默认属于已提交层。 */
  stage: "committed";
  role: ContentRole;
  /** 已定型的完整文本。 */
  text: string;
}

/**
 * reasoning 增量事件：表示模型通过独立思考/推理通道输出的片段。
 *
 * 说明：
 * - reasoning 直接归属于 turn，而不是直接归属于整个 request。
 * - partIndex / itemId 用于保留 provider 的分段能力（尤其是 GPT Responses reasoning summary）。
 */
export interface ReasoningDeltaEvent extends EventBase {
  type: "reasoning.delta";
  /** reasoning 增量事件默认来源于 llm。 */
  source: "llm";
  /** reasoning 增量事件默认属于运行态草案层。 */
  stage: "runtime";
  text: string;
  kind?: ReasoningKind;
  partIndex?: number;
  itemId?: string;
}

/**
 * reasoning 提交事件：表示某一段 reasoning 已完整成型。
 *
 * 主要用于：
 * - 前端将 reasoning 分段落地成可折叠块
 * - trace 中按章节查看模型思考内容
 */
export interface ReasoningCommitEvent extends EventBase {
  type: "reasoning.commit";
  /** reasoning 提交事件默认来源于 llm。 */
  source: "llm";
  /** reasoning 提交事件默认属于已提交层。 */
  stage: "committed";
  text: string;
  kind?: ReasoningKind;
  partIndex?: number;
  itemId?: string;
}

/**
 * 状态提示事件：给前端展示“当前 AI 正在做什么”。
 *
 * 设计说明：
 * - phase 表示稳定的大阶段（如 acting / responding）。
 * - code 表示更细的、可供代码逻辑判断的动作类别（如 read_file / render_mermaid）。
 * - text 表示面向用户展示的动态文案，可根据工具参数、目标文件、渲染阶段实时变化。
 * - 这三层配合使用：避免把所有状态都硬塞进一个大枚举，也避免前端只能靠中文文案做逻辑判断。
 *
 * 示例：
 * - { phase: "acting", code: "search_workspace", text: "搜索工作区" }
 * - { phase: "acting", code: "read_file", text: "读取 PublishDAO.kt" }
 * - { phase: "responding", code: "render_mermaid", text: "正在绘制节点..." }
 */
export interface StatusEvent extends EventBase {
  type: "status";
  /** status 事件默认来源于 system 层。 */
  source: "system";
  /**
   * status 事件层级。
   *
   * 建议约定：
   * - 绝大多数运行中的状态提示（如 thinking / reasoning / read_file / render_mermaid）属于 `runtime`
   * - 若某些状态需要作为最终稳定结论展示（如 completed / error / cancelled），可显式标记为 `committed`
   */
  stage: EventStage;
  phase: StatusPhase;
  code: StatusCode;
  /** 面向用户的状态文案，如“正在推理...”或“读取 PublishDAO.kt”。 */
  text: string;
  /** 可选：该状态若由工具驱动产生，则记录对应工具名。 */
  toolName?: string;
  /** 可选：当前状态的目标对象，如文件名、查询目标、渲染目标等。 */
  target?: string;
  /** 可选：用于生成动态文案的结构化参数，供后续前端/trace 调试使用。 */
  args?: Record<string, unknown>;
}

/**
 * debug 事件：用于记录调试现场，不直接面向普通用户渲染。
 *
 * 典型用途：
 * - request：记录发给模型的完整请求快照（messages、tools、参数等）
 * - protocol_raw：记录 provider 的原始流式事件
 * - normalized：记录协议适配层产出的内部标准事件
 */
export interface DebugEvent extends EventBase {
  type: "debug";
  /** debug 事件默认来源于 debug 层。 */
  source: "debug";
  kind: DebugKind;
  /** 任意结构化调试载荷。第一阶段先保持宽松，后续可再收紧成更细的类型。 */
  payload: unknown;
}

/** 所有 renderable（可参与前端渲染）的标准事件。 */
export type RenderableEvent =
  | RequestEvent
  | TurnEvent
  | ContentDeltaEvent
  | ContentCommitEvent
  | ReasoningDeltaEvent
  | ReasoningCommitEvent
  | ToolEvent
  | StatusEvent;

/** 所有内部统一事件（包含调试事件）。 */
export type InternalEvent = RenderableEvent | DebugEvent;

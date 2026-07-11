import type { StatusCode, StatusEvent, StatusPhase, EventSource, RequestId, TurnId } from "./eventModel.js";

/**
 * 状态文案解析上下文。
 *
 * 说明：
 * - phase / code 是结构化状态骨架。
 * - text 为可选的显式文案，若已给出则优先使用。
 * - toolName / target / args 用于根据具体工具或目标生成更自然的动态文案。
 */
export interface StatusResolveContext {
  requestId: RequestId;
  turnId?: TurnId;
  phase: StatusPhase;
  code: StatusCode;
  text?: string;
  toolName?: string;
  target?: string;
  args?: Record<string, unknown>;
  source?: EventSource;
}

/** 状态文案解析器名称：用于调试时定位是哪一层规则命中了当前文案。 */
export type StatusResolverName = "explicit" | "action" | "render" | "default" | "fallback";

/**
 * 状态解析结果。
 *
 * 说明：
 * - matched=false：当前解析器不处理该上下文，责任链继续传递
 * - matched=true：当前解析器已产出结构化结果
 * - stop=true：责任链到此终止，直接采用当前结果
 */
export type StatusResolveResult =
  | {
      matched: false;
      resolver: StatusResolverName;
    }
  | {
      matched: true;
      resolver: StatusResolverName;
      text: string;
      stop: boolean;
    };

/** 责任链节点：基于上下文返回结构化解析结果，而不是用 undefined 表示控制流。 */
export interface StatusTextResolver {
  resolve(ctx: StatusResolveContext): StatusResolveResult;
}

/** 显式文案优先：若调用方已经给出 text，则直接使用。 */
export class ExplicitTextResolver implements StatusTextResolver {
  resolve(ctx: StatusResolveContext): StatusResolveResult {
    const text = (ctx.text || "").trim();
    return text
      ? { matched: true, resolver: "explicit", text, stop: true }
      : { matched: false, resolver: "explicit" };
  }
}

/** 工具/动作类状态解析：优先根据 code + target 生成更贴近用户心智的动态文案。 */
export class ActionStatusResolver implements StatusTextResolver {
  resolve(ctx: StatusResolveContext): StatusResolveResult {
    let text: string | undefined;
    switch (ctx.code) {
      case "search_workspace":
        text = "搜索工作区";
        break;
      case "read_file":
        text = ctx.target ? `读取 ${ctx.target}` : "读取文件";
        break;
      case "list_dir":
        text = "查看目录结构";
        break;
      case "edit_file":
      case "apply_patch":
        text = ctx.target ? `编辑 ${ctx.target}` : "编辑文件";
        break;
      case "execute_command":
        text = "执行命令";
        break;
      case "check_diagnostics":
        text = "检查诊断结果";
        break;
      case "web_search":
        text = "联网搜索";
        break;
      case "web_fetch":
        text = "抓取网页内容";
        break;
      case "browser_open":
        text = "打开浏览器页面";
        break;
      case "browser_interact":
        text = "操作浏览器页面";
        break;
      default:
        text = undefined;
    }
    return text
      ? { matched: true, resolver: "action", text, stop: true }
      : { matched: false, resolver: "action" };
  }
}

/** 渲染类状态解析：用于图形/可视化输出阶段。 */
export class RenderStatusResolver implements StatusTextResolver {
  resolve(ctx: StatusResolveContext): StatusResolveResult {
    let text: string | undefined;
    switch (ctx.code) {
      case "render_drawing":
        text = "正在构思图形...";
        break;
      case "render_mermaid":
        text = "正在绘制节点...";
        break;
      case "render_svg":
        text = "正在绘制图形...";
        break;
      case "summarizing":
        text = "正在整理最终结论...";
        break;
      default:
        text = undefined;
    }
    return text
      ? { matched: true, resolver: "render", text, stop: true }
      : { matched: false, resolver: "render" };
  }
}

/** 通用状态默认文案：兜底解决思考、等待、完成、失败、取消等稳定状态。 */
export class DefaultStatusResolver implements StatusTextResolver {
  resolve(ctx: StatusResolveContext): StatusResolveResult {
    let text: string | undefined;
    switch (ctx.code) {
      case "idle":
        text = "空闲中";
        break;
      case "thinking":
        text = "思考中...";
        break;
      case "reasoning":
        text = "正在推理...";
        break;
      case "waiting_confirm":
        text = "等待确认...";
        break;
      case "waiting_input":
        text = "等待输入...";
        break;
      case "completed":
        text = "已完成";
        break;
      case "error":
        text = "执行出错";
        break;
      case "cancelled":
        text = "已取消";
        break;
      default:
        text = undefined;
    }
    return text
      ? { matched: true, resolver: "default", text, stop: true }
      : { matched: false, resolver: "default" };
  }
}

/** 最终兜底：确保任意状态都至少有一句可展示文案。 */
export class FallbackStatusResolver implements StatusTextResolver {
  resolve(_ctx: StatusResolveContext): StatusResolveResult {
    return { matched: true, resolver: "fallback", text: "处理中...", stop: true };
  }
}

const DEFAULT_RESOLVER_CHAIN: StatusTextResolver[] = [
  new ExplicitTextResolver(),
  new ActionStatusResolver(),
  new RenderStatusResolver(),
  new DefaultStatusResolver(),
  new FallbackStatusResolver(),
];

/**
 * 解析最终展示文案。
 *
 * 责任链顺序：
 * 1. 显式 text
 * 2. 动作/工具类状态
 * 3. 渲染类状态
 * 4. 通用默认状态
 * 5. 最终兜底
 */
export function resolveStatusText(
  ctx: StatusResolveContext,
  chain: StatusTextResolver[] = DEFAULT_RESOLVER_CHAIN,
): string {
  for (const resolver of chain) {
    const result = resolver.resolve(ctx);
    if (!result.matched) continue;
    if (result.stop) return result.text;
  }
  return "处理中...";
}

/**
 * 便捷构造统一的 StatusEvent。
 *
 * 调用方只需给出 phase/code 及少量上下文，该函数会自动补齐 text 与 source。
 */
export function buildStatusEvent(ctx: StatusResolveContext): StatusEvent {
  return {
    type: "status",
    ts: new Date().toISOString(),
    requestId: ctx.requestId,
    turnId: ctx.turnId,
    source: "system",
    stage: ctx.code === "completed" || ctx.code === "error" || ctx.code === "cancelled" ? "committed" : "runtime",
    phase: ctx.phase,
    code: ctx.code,
    text: resolveStatusText(ctx),
    toolName: ctx.toolName,
    target: ctx.target,
    args: ctx.args,
  };
}

/**
 * Segment 渲染与相关卡片组件
 * 从原 ChatPanel.tsx 拆出：renderSegments + SkillBadgeCard / RelayProgressCard / SubAgentCard。
 *
 * renderSegments 把 segments 渲染为节点，并把"连续相邻的同类工具调用"合并成分组卡片
 * （search / read_file / 同文件编辑 / use_skill / relay）。SubAgentCard 复用 renderSegments
 * 渲染子 agent 内部流程，故几者放在同一文件内以解循环依赖。
 */

import { useState, useRef, useEffect, type ReactNode } from "react";
import { Loader2, Boxes, ListChecks, ChevronRight, ChevronDown, Check, X, Bot, Clock, BookOpen } from "lucide-react";
import { MarkdownRenderer } from "@/components/MarkdownRenderer";
import {
  ToolCallItem, SearchGroupItem, ReadFileGroupItem, EditGroupItem,
  BrowserSessionGroup, BROWSER_TOOL_NAMES,
  exploreDisplayText, disambiguatePaths, toLineNumber, isToolInFlight,
  type ToolStatus, type SearchGroupData, type ReadFileGroupData, type EditGroupData,
} from "@/components/ToolCallItem";
import type { Segment, ToolSegment, SubAgentSegment, WikiRecallSegment } from "./types";
import { ArtifactCard } from "./ArtifactCard";
import { resolveQueuedWaitingIds } from "./toolCardPhase";
import { ReasoningBlock } from "./ReasoningBlock";
import { RetryBlock } from "./RetryBlock";
import { isRelayTool, relayToolLabel } from "./relayUtils";

/** 从展示串行号区间（如 "1300-1415" / "2-EOF"）解析起始行号 */
function parseRangeStart(range?: string): number | undefined {
  const m = range?.match(/^(\d+)-(?:\d+|EOF)$/);
  return m ? toLineNumber(m[1]) : undefined;
}

/** 从展示串行号区间解析结束行号；"EOF" 视为未指定（仅跳转到起始行） */
function parseRangeEnd(range?: string): number | undefined {
  const m = range?.match(/^\d+-(\d+)$/);
  return m ? toLineNumber(m[1]) : undefined;
}

/**
 * Skill 触发卡片：独立、简洁，展示图标 + 一个或多个触发的 skill 名称。
 * 用于 use_skill 工具调用（连续多次会合并到一张卡片），以及子 agent 委托加载 skill 时。
 */
export function SkillBadgeCard({ skills, pending, queuedOnly }: { skills: string[]; pending?: boolean; queuedOnly?: boolean }) {
  const names = skills.filter(Boolean);
  return (
    <div className={`my-2 flex items-center gap-2 rounded-lg border px-2.5 py-1.5 flex-wrap ${queuedOnly ? "border-border/50 bg-muted/10 opacity-60" : "border-primary/30 bg-primary/5"}`}>
      {pending
        ? (queuedOnly
            ? <Clock className="w-3.5 h-3.5 shrink-0 text-muted-foreground/50" />
            : <Loader2 className="w-3.5 h-3.5 shrink-0 text-primary animate-spin" />)
        : <Boxes className="w-3.5 h-3.5 shrink-0" />}
      <span className="text-xs text-muted-foreground shrink-0">{queuedOnly ? "待加载 Skill" : pending ? "加载 Skill" : "使用 Skill"}</span>
      {names.map((n) => (
        <span key={n} className="px-1.5 py-0.5 rounded bg-primary/10 text-xs font-mono font-medium text-primary">{n}</span>
      ))}
    </div>
  );
}

/**
 * 记忆召回卡片 —— 本轮把哪些项目 Wiki 页面注入了上下文。
 *
 * 只在召回集合【变化】时出现（首次 / 页面增删 / 某页转陈旧），稳定期完全静默，
 * 因此「它出现」本身就是信号：记忆变了，值得看一眼 —— 而不是每轮都刷的噪音。
 * 这与侧栏徽标只在有待复核页时才亮，是同一条原则。
 *
 * 用彩色而非灰底：它交代的是「AI 手里有哪些材料」，属于需要被注意的上下文，
 * 而不是可以略过的过程细节。
 */
export function WikiRecallCard({ seg }: { seg: WikiRecallSegment }) {
  const [expanded, setExpanded] = useState(false);
  const staleCount = seg.pages.filter((p) => p.stale).length;
  const omitted = seg.total - seg.pages.length;
  return (
    <div className="my-2 rounded-lg border border-emerald-500/30 bg-emerald-500/5 overflow-hidden">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-2 w-full py-1.5 px-2.5 text-xs text-left hover:bg-emerald-500/10 transition-colors"
      >
        <BookOpen className="w-3.5 h-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
        <span className="font-medium text-foreground shrink-0">记忆召回</span>
        <span className="text-muted-foreground shrink-0">项目 Wiki {seg.total} 页</span>
        {staleCount > 0 && (
          <span className="shrink-0 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-600 dark:text-amber-400">
            {staleCount} 页待复核
          </span>
        )}
        {omitted > 0 && (
          <span className="shrink-0 text-[10px] text-muted-foreground/70">另有 {omitted} 页未注入</span>
        )}
        <ChevronRight className={`w-3.5 h-3.5 shrink-0 ml-auto text-muted-foreground transition-transform ${expanded ? "rotate-90" : ""}`} />
      </button>
      {expanded && (
        <div className="border-t border-emerald-500/20 px-2.5 py-1.5 space-y-0.5">
          {seg.pages.map((p) => (
            <div key={p.title} className="flex items-center gap-1.5 text-xs">
              <span className={p.stale ? "shrink-0 text-amber-500" : "shrink-0 text-emerald-600/60"}>{p.stale ? "⚠️" : "•"}</span>
              <span className={p.stale ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground"}>{p.title}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Relay 进度卡片：把一串连续的 Relay 工具调用合并成一行可展开的轨迹。
 * 折叠态只显示最新一步（一行，省空间）；展开看完整步骤。
 * 完整可视化（阶段进度条/任务清单/评审）在右侧 Relay 面板，这里只是对话流里的轻量提示。
 */
export function RelayProgressCard({ steps, pending, queuedOnly }: { steps: { name: string; description: string; status: ToolStatus; relayId?: string }[]; pending?: boolean; queuedOnly?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  if (steps.length === 0) return null;
  const last = steps[steps.length - 1];
  const hasError = steps.some((s) => s.status === "error");

  // 从 steps 中提取 relay ID（relay_create 的 description 包含 "id: xxx"）
  const relayId = steps.find((s) => s.relayId)?.relayId;

  const handleClick = () => {
    setExpanded((v) => !v);
  };

  return (
    <div className="my-2 rounded-lg border border-primary/30 bg-primary/5 overflow-hidden">
      <button
        onClick={handleClick}
        className="flex items-center gap-2 w-full py-1.5 px-2.5 text-xs text-left hover:bg-primary/10 transition-colors"
      >
        {pending
          ? (queuedOnly
              ? <Clock className="w-3.5 h-3.5 shrink-0 text-muted-foreground/50" />
              : <Loader2 className="w-3.5 h-3.5 shrink-0 text-primary animate-spin" />)
          : <ListChecks className={`w-3.5 h-3.5 shrink-0 ${hasError ? "text-red-500" : "text-primary"}`} />}
        <span className="text-muted-foreground shrink-0">Relay</span>
        <span className="text-foreground truncate flex-1 min-w-0">{last.description}</span>
        {steps.length > 1 && (
          <span className="text-[10px] text-muted-foreground shrink-0">{steps.length} 步</span>
        )}
        {steps.length > 1 && (
          <ChevronRight className={`w-3.5 h-3.5 shrink-0 text-muted-foreground transition-transform ${expanded ? "rotate-90" : ""}`} />
        )}
      </button>
      {expanded && steps.length > 1 && (
        <div className="border-t border-primary/20 px-2.5 py-1.5 space-y-1">
          {steps.map((s, idx) => (
            <div key={idx} className="flex items-center gap-2 text-xs">
              {s.status === "error"
                ? <X className="w-3 h-3 shrink-0 text-red-500" />
                : s.status === "queued"
                  ? <Clock className="w-3 h-3 shrink-0 text-muted-foreground/50" />
                  : s.status === "pending"
                    ? <Loader2 className="w-3 h-3 shrink-0 animate-spin text-muted-foreground" />
                    : <Check className="w-3 h-3 shrink-0" />}
              <span className="text-muted-foreground/80 truncate">{s.description}</span>
            </div>
          ))}
          {relayId && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                const vs = (window as any).__axonVSCode;
                if (vs) vs.postMessage({ type: "open_relay", relayId });
              }}
              className="mt-1 text-[10px] text-primary/70 hover:text-primary underline cursor-pointer"
            >
              在 Relay 面板中查看 →
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * 子 Agent 委托卡片：默认折叠，标题行展示意图 + skill；展开显示 prompt 灰框 + 内部执行过程。
 */
export function SubAgentCard({ seg }: { seg: SubAgentSegment }) {
  const [expanded, setExpanded] = useState(false);
  const summaryRef = useRef<HTMLDivElement>(null);
  // 折叠态摘要区是否"贴底"。
  // 只有用户本来就在底部时才自动跟随新内容；用户一旦往上滚，就不该再把他拽回去。
  // 原写法是无依赖数组的 effect —— 每次渲染都无条件 `scrollTop = scrollHeight`，
  // 而流式期间每帧都在渲染，于是视口被反复拉回底部，滚动条实际上滚不动（"被吸住"）。
  const summaryStickRef = useRef(true);
  useEffect(() => {
    const el = summaryRef.current;
    if (!el) return;
    const onScroll = () => {
      // 8px 容差：行高/亚像素误差下也算"在底部"
      summaryStickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 8;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [expanded]); // 摘要区在折叠时才存在，展开会卸载它，故按 expanded 重新挂监听
  useEffect(() => {
    const el = summaryRef.current;
    if (el && !expanded && summaryStickRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  });

  const running = seg.status === "running";
  const verb = running ? "Invoking" : "Invoked";

  return (
    <div className="my-2 rounded-lg border border-border bg-muted/20 overflow-hidden">
      {/* 标题行 */}
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-2 w-full py-1.5 px-2.5 text-xs text-left hover:bg-muted/30 transition-colors"
      >
        <ChevronDown className={`w-3.5 h-3.5 shrink-0 text-muted-foreground transition-transform ${expanded ? "" : "-rotate-90"}`} />
        {running
          ? <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0 text-amber-500" />
          : <Bot className="w-3.5 h-3.5 shrink-0" />}
        <span className="font-medium text-foreground shrink-0">{verb} Sub-Agent</span>
        {seg.skill && (
          <span className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-primary/10 text-[10px] font-mono text-primary shrink-0">
            <Boxes className="w-3 h-3" />
            {seg.skill}
          </span>
        )}
        <span className="text-muted-foreground truncate">{seg.intent}</span>
      </button>
      {/* 折叠态动态摘要：执行中展示最新工具/文字；完成后只给一句"已完成"。
          刻意不把子 Agent 的结论正文塞进来——那是给主 Agent 的交付物，用户不必在折叠卡里再读一遍
          （想看过程或内容，点开卡片即可）。 */}
      {!expanded && (
        <div ref={summaryRef} className="border-t border-border/50 px-2.5 py-1.5 max-h-40 overflow-y-auto [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-transparent [&::-webkit-scrollbar-track]:bg-transparent [&:hover::-webkit-scrollbar-thumb]:bg-muted-foreground/30">
          {running ? (
            (() => {
              const visible = seg.inner.filter((s) => !(s.type === "tool" && (s as ToolSegment).hidden));
              const last = visible[visible.length - 1];
              if (last?.type === "tool") {
                // 只有"还在跑"的工具卡才配当最新活动。已跑完的（如 apply_patch）说明子 Agent
                // 正在整理结论，继续挂着它会让用户看到"应用补丁中…"迟迟不动。
                const st = (last as ToolSegment).status;
                if (st === "queued" || st === "pending") return renderSegments([last]);
              }
              if (last?.type === "text" && seg.innerStreaming) {
                // 子 agent 正在输出文字（如分析过程）
                return <MarkdownRenderer content={last.content} streaming />;
              }
              if (visible.length > 0) {
                // ⚠️ 这里不能写"正在汇总分析结论，准备返回结果"。
                //
                // 子 Agent 是连续多步执行的：每一步工具跑完之后、下一步开始之前，最后一段都是"已完成的工具卡"，
                // 于是这个分支会在**整个执行过程中反复命中**——文案一直宣称"准备返回结果"，
                // 而子 Agent 其实还在正常干活（用户报的正是"不是正常执行中吗，怎么是返回结论了"）。
                //
                // 原注释的假设是"已跑完的工具（如 apply_patch）说明子 Agent 正在整理结论"，这个假设是错的：
                // 跑完一个工具恰恰说明后面多半还有下一步。数据结构里也没有"即将返回"的真实信号
                // （SubAgentSegment 只有 status: running/done，外加 innerStreaming），
                // 所以这里只能给一句对所有中间态都成立的话——不猜它处在哪个阶段。
                return (
                  <div className="flex items-center gap-1.5">
                    <Loader2 className="w-3 h-3 animate-spin shrink-0 text-muted-foreground" />
                    <span className="text-xs text-muted-foreground">正在继续执行...</span>
                  </div>
                );
              }
              // 刚开始，还没有任何输出
              return (
                <div className="flex items-center gap-1.5">
                  <Loader2 className="w-3 h-3 animate-spin shrink-0 text-muted-foreground" />
                  <span className="text-xs text-muted-foreground">正在分析任务...</span>
                </div>
              );
            })()
          ) : (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Check className="w-3.5 h-3.5 shrink-0 text-primary" />
              <span>子 Agent 已执行完成，AI 已获悉结论</span>
            </div>
          )}
        </div>
      )}
      {/* 展开区 */}
      {expanded && (
        <div className="border-t border-border/50 px-2.5 py-2 space-y-2">
          {/* 传给子 agent 的 prompt（灰框） */}
          <div className="rounded-md bg-muted/40 px-2.5 py-1.5 text-xs text-muted-foreground whitespace-pre-wrap break-words">
            {seg.prompt}
          </div>
          {/* 子 agent 内部执行过程（复用 renderSegments，无编辑确认） */}
          <div className="min-w-0">
            {renderSegments(seg.inner, seg.innerStreaming)}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * 渲染 segments，并把"连续相邻的同类工具"合并为分组卡片。
 * 非分组工具、文字段照常逐个渲染。
 */
export function renderSegments(
  segments: Segment[],
  streaming?: boolean,
  onAcceptEdit?: (path: string) => void,
  onRejectEdit?: (path: string) => void,
  onUndoEdit?: (path: string) => void,
): ReactNode[] {
  // 过滤掉不会被渲染的段，避免它们夹在中间打断"连续同类工具"的合并：
  // ① hidden 的 tool 段（软失败的前 N 次重试不展示）
  // ② 空的 / 纯标点的 text 段（模型工具调用间夹带的 "..." 等弱内容）
  // ③ 空的 reasoning 段
  segments = segments.filter((s) => {
    if (s.type === "tool" && (s as ToolSegment).hidden) return false;
    if (s.type === "text") {
      const t = s.content.trim();
      // 与主循环里的弱内容判断保持一致：无字母数字中文即视为不渲染
      if (!t || !/[A-Za-z0-9\u4e00-\u9fff]/.test(t)) return false;
    }
    if (s.type === "reasoning" && !s.content.trim()) return false;
    return true;
  });

  const nodes: ReactNode[] = [];
  let i = 0;

  // 「待执行」vs「生成中」的判定（判定规则与其理由见 toolCardPhase.ts）。
  // 抽成纯函数是因为它不该藏在这个几百行的渲染函数里——它是可独立验证的协议推断逻辑。
  const queuedWaitingIds = resolveQueuedWaitingIds(segments);
  const toolStatusById = new Map(
    segments.filter((item): item is ToolSegment => item.type === "tool").map((item) => [item.id, item.status]),
  );
  const activeWaitingFor = (seg: ToolSegment) => seg.waitingFor?.filter((item) => {
    const status = toolStatusById.get(item.id);
    return status === "queued" || status === "pending";
  });

  // turn 级文件名消歧：收集本轮所有编辑过的文件完整路径，统一算一份"路径→展示名"映射，
  // 让分散在多张编辑卡片里的同名文件（如多个 SKILL.md）也能补路径区分，而不是各自只显示文件名。
  // 同时纳入 apply_patch 的多文件路径（s.diffs）。
  const editPaths = Array.from(new Set(
    segments
      .filter((s): s is ToolSegment => s.type === "tool")
      .flatMap((s) => {
        const t = s as ToolSegment;
        if ((t.name === "str_replace" || t.name === "create_file") && t.diff?.path) return [t.diff.path];
        if (t.name === "apply_patch" && t.diffs && t.diffs.length > 0) return t.diffs.map((d) => d.path).filter(Boolean);
        return [];
      }),
  ));
  const editNames = disambiguatePaths(editPaths);
  const editDisplayMap = new Map(editPaths.map((p, idx) => [p, editNames[idx]]));
  const editDisplay = (fullPath: string): string =>
    editDisplayMap.get(fullPath) || fullPath.split("/").pop()?.split("\\").pop() || fullPath;

  // turn 级 Power 去重：同一会话同一个 Power 只激活一次，但 pending 段与 success 段可能
  // 被其它工具调用隔开，导致渲染成上下两张卡片。这里按 Power 名汇总出"最完整"的代表段
  // （优先有 powerActivated 数据、其次 success），整轮只在首次出现处渲染一张卡片。
  const powerKey = (s: ToolSegment): string => s.powerActivated?.name || (s.args?.name as string) || s.id;
  const powerReps = new Map<string, ToolSegment>();
  for (const s of segments) {
    if (s.type !== "tool" || s.name !== "activate_power") continue;
    const key = powerKey(s);
    const prev = powerReps.get(key);
    const better = !prev
      || (s.powerActivated && !prev.powerActivated)
      || (s.status === "success" && prev.status !== "success");
    if (better) powerReps.set(key, s);
  }
  const renderedPowers = new Set<string>();

  while (i < segments.length) {
    const seg = segments[i];

    // 文字段
    if (seg.type === "text") {
      const isLast = i === segments.length - 1;
      const trimmedContent = seg.content.trim();
      // 跳过弱内容段（纯标点符号/省略号等无意义叙述，如模型工具调用前夹带的 "..."）
      if (!trimmedContent || !/[A-Za-z0-9\u4e00-\u9fff]/.test(trimmedContent)) {
        i++;
        continue;
      }
      // ⚠️ 下面两个分支必须渲染**同一种元素类型**：只允许差在 streaming 与光标上。
      // 历史上是一个套 <div class="relative">、另一个直接是裸 MarkdownRenderer —— React 对
      // 「同 key、不同 type」的处理是**卸载 + 重挂载**，于是"回复完成"那一帧整段文本被 remount：
      // 重跑 computeHtml + hljs，而由 DOM 手术（hydrateMermaid/hydrateSvg 的 pre.replaceWith）插入的
      // 已 hydrate 图表随之丢失，要等缓存恢复才回来 —— 用户看到的就是"回复完白屏刷新一下"。
      // 实测（真实组件 + 逐帧 MutationObserver）：streaming 翻 false 后 6.4ms 记录到
      // removedNodes=[div.relative]、addedNodes=[div.axon-chat-prose]，prose 节点 id 由 1 跳到 134。
      // StreamingCursor 在非流式时本就返回 null，所以保留同一个 wrapper 即可，代价仅是多一层 div.relative。
      nodes.push(
        <div key={`text-${i}`} className="relative">
          {/* 整条消息仍在流式时传 streaming：增强渲染（svg/mermaid/html 预览）推迟到终态再 hydrate。 */}
          <MarkdownRenderer content={seg.content} streaming={streaming} />
          {streaming && isLast && <StreamingCursor />}
        </div>
      );
      i++;
      continue;
    }

    // 思考过程段：把**连续相邻**的思考块合并成一个可折叠区块。
    //
    // 为什么会相邻：reasoning 段的粒度是"协议块"（轮次 + content block 索引 / Responses item），
    // 一次回答里天然会有多块——Anthropic 一轮内可以 thinking → tool_use → thinking，
    // agent loop 的每一轮也各有自己的思考块。块之间原本夹着工具/正文段，但上面的过滤会摘掉
    // hidden 工具段与弱内容 text 段，于是"中间那一步不展示"的两块思考就贴到了一起。
    //
    // 合并只发生在渲染层：chatHistory 里的段结构与 key 一个都不动。reasoning 增量靠 key 归属
    // （见 stateHandlers.reasoningKeyOf），要是在数据层并段，后续增量就找不到自己的段了。
    if (seg.type === "reasoning") {
      const groupStart = i;
      const parts: string[] = [];
      let anyStreaming = false;
      // 合并块的实际思考时长 = 各段 (endedAt - startedAt) 之和。累加而不是取首尾差：
      // 块与块之间可能夹着不展示的工具调用/正文，首尾差会把那些等待时间也算成"思考"。
      let durationMs = 0;
      while (i < segments.length) {
        const s = segments[i];
        if (s.type !== "reasoning") break;
        if (s.content.trim()) parts.push(s.content);
        // 任一块仍在流式 → 整个合并块算"进行中"（保持展开，末块结束后才折叠）
        if (s.streaming) anyStreaming = true;
        if (s.startedAt !== undefined && s.endedAt !== undefined) {
          durationMs += Math.max(0, s.endedAt - s.startedAt);
        }
        i++;
      }
      if (parts.length > 0) {
        // 单块时原样透传，保持与合并前完全一致的行为；多块之间补空行，避免上块末尾与下块开头粘连
        const content = parts.length === 1
          ? parts[0]
          : parts.map((p) => p.replace(/\s+$/, "")).join("\n\n");
        nodes.push(<ReasoningBlock key={`reasoning-${groupStart}`} content={content} streaming={anyStreaming} durationMs={durationMs > 0 ? durationMs : undefined} />);
      }
      continue;
    }

    // 子 Agent 委托段：折叠卡片（委托用的 skill 显示在卡片标题，不再外层单独飘一个）
    if (seg.type === "subagent") {
      nodes.push(<SubAgentCard key={`sub-${seg.id}`} seg={seg} />);
      i++;
      continue;
    }

    // 接口重试段
    if (seg.type === "retry") {
      nodes.push(<RetryBlock key={`retry-${i}`} attempt={seg.attempt} maxRetries={seg.maxRetries} error={seg.error} status={seg.status} />);
      i++;
      continue;
    }

    // 记忆召回段：本轮把哪些 Wiki 页面注入了上下文（仅在召回集合变化时出现）
    if (seg.type === "wikirecall") {
      nodes.push(<WikiRecallCard key={`recall-${i}`} seg={seg} />);
      i++;
      continue;
    }

    // 连续 Relay 工具段：合并成一张精简的"Relay 进度"卡片。
    // 这些状态机操作的完整可视化在右侧 Relay 面板，对话流里只保留一行可展开的轨迹，避免刷屏。
    if (seg.type === "tool" && isRelayTool(seg.name)) {
      const groupStart = i;
      const steps: { name: string; description: string; status: ToolStatus; relayId?: string }[] = [];
      let pending = false;
      let executing = false;
      while (i < segments.length) {
        const s = segments[i];
        if (s.type === "tool" && isRelayTool(s.name)) {
          // 从 relay_create 结果的 description 中提取 relay ID（格式："...（id: xxx-yyy）..."）
          let relayId: string | undefined;
          if (s.name === "relay_create" && s.description) {
            const m = s.description.match(/id:\s*([^）)，,\s]+)/);
            if (m) relayId = m[1];
          }
          // 其他 relay 工具的 args 里有 id 字段
          if (!relayId && s.args && typeof s.args.id === "string") {
            relayId = s.args.id;
          }
          steps.push({ name: s.name, description: s.description || relayToolLabel(s.name), status: s.status, relayId });
          if (isToolInFlight(s.status)) pending = true;
          if (s.status === "pending") executing = true;
          i++;
        } else {
          break;
        }
      }
      const groupSeg = segments[groupStart] as ToolSegment;
      nodes.push(<RelayProgressCard key={`relay-${groupSeg.id}`} steps={steps} pending={pending} queuedOnly={pending && !executing} />);
      continue;
    }

    // 连续探索段（search / list_dir）：向后收集所有相邻的探索调用，合并成一个卡片
    if (seg.type === "tool" && (seg.name === "search" || seg.name === "list_dir")) {
      const groupStart = i;
      const queries: SearchGroupData["queries"] = [];
      let pending = false;
      let executing = false;
      while (i < segments.length) {
        const s = segments[i];
        if (s.type === "tool" && (s.name === "search" || s.name === "list_dir")) {
          queries.push({ name: s.name, args: s.args, label: exploreDisplayText(s.name, s.args, s.query) });
          if (isToolInFlight(s.status)) pending = true;
          if (s.status === "pending") executing = true;
          i++;
        } else {
          break;
        }
      }
      const groupSeg = segments[groupStart] as ToolSegment;
      const group: SearchGroupData = { id: groupSeg.id, pending, queuedOnly: pending && !executing, queries };
      nodes.push(<SearchGroupItem key={`search-${groupSeg.id}`} group={group} />);
      continue;
    }

    // 连续 read_file 段：合并成一张卡片
    if (seg.type === "tool" && seg.name === "read_file") {
      const groupStart = i;
      // 先收集每个文件的完整路径 + 行号区间，最后统一做消歧展示
      const raw: { fullPath: string; range?: string; startLine?: number; endLine?: number }[] = [];
      let pending = false;
      let executing = false;
      let hasError = false;
      while (i < segments.length) {
        const s = segments[i];
        if (s.type === "tool" && s.name === "read_file") {
          // 优先用后端返回的绝对路径（resolvedPath），回退到参数里的路径，再回退到从 description 提取
          const fullPath = s.resolvedPath
            || (typeof s.args?.path === "string" && s.args.path ? (s.args.path as string) : "")
            || (() => {
                const desc = s.description || "";
                const m = desc.match(/^(?:已读取|读取)\s+(\S+)(?:\s+\d+-(?:\d+|EOF))?$/);
                return m ? m[1] : (desc.replace(/^(?:已读取|读取)\s+/, "") || "文件");
              })();
          // 行号区间仍从 description 提取（args 里是 startLine/endLine，展示串在 desc）
          const desc = s.description || "";
          const rm = desc.match(/\s(\d+-(?:\d+|EOF))$/);
          // 起止行号优先取参数（用于点击跳转选中），回退从展示串解析
          const startLine = toLineNumber(s.args?.startLine) ?? parseRangeStart(rm ? rm[1] : undefined);
          const endLine = toLineNumber(s.args?.endLine) ?? parseRangeEnd(rm ? rm[1] : undefined);
          raw.push({ fullPath, range: rm ? rm[1] : undefined, startLine, endLine });
          if (isToolInFlight(s.status)) pending = true;
          if (s.status === "pending") executing = true;
          if (s.status === "error") hasError = true;
          i++;
        } else {
          break;
        }
      }
      // 默认仅显示文件名；只有同批读取里出现“同名但不同绝对路径”时，
      // 才对冲突项展示完整路径，以便用户明确区分来源。
      const isAbsolutePath = (path: string) => /^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(path);
      const displayNames = disambiguatePaths(raw.map((r) => r.fullPath));
      const pathsByBaseName = new Map<string, Set<string>>();
      for (const r of raw) {
        const baseName = r.fullPath.replace(/\\/g, "/").split("/").filter(Boolean).pop() || r.fullPath;
        const paths = pathsByBaseName.get(baseName) || new Set<string>();
        paths.add(r.fullPath);
        pathsByBaseName.set(baseName, paths);
      }
      const files = raw.map((r, idx) => {
        const baseName = r.fullPath.replace(/\\/g, "/").split("/").filter(Boolean).pop() || r.fullPath;
        const hasSameNameAtDifferentPaths = (pathsByBaseName.get(baseName)?.size || 0) > 1;
        const showFullPath = isAbsolutePath(r.fullPath) && hasSameNameAtDifferentPaths;
        return {
          name: showFullPath ? r.fullPath : displayNames[idx],
          range: r.range,
          path: r.fullPath,
          startLine: r.startLine,
          endLine: r.endLine,
          isAbsolute: showFullPath,
        };
      });
      const groupSeg = segments[groupStart] as ToolSegment;
      const group: ReadFileGroupData = { id: groupSeg.id, pending, queuedOnly: pending && !executing, hasError, files };
      nodes.push(<ReadFileGroupItem key={`read-${groupSeg.id}`} group={group} />);
      continue;
    }

    // 连续同文件编辑段：合并成可展开的分组卡片。
    // 「单文件编辑」涵盖 str_replace / create_file（用 seg.diff）以及单文件 apply_patch（用 seg.diffs[0]）。
    const singleFileOf = (s: Segment): { path: string; diff: NonNullable<ToolSegment["diff"]> } | null => {
      if (s.type !== "tool") return null;
      if ((s.name === "str_replace" || s.name === "create_file") && s.diff) return { path: s.diff.path, diff: s.diff };
      if (s.name === "apply_patch" && s.diffs && s.diffs.length === 1) return { path: s.diffs[0].path, diff: s.diffs[0] };
      return null;
    };
    const segSF = singleFileOf(seg);
    if (segSF) {
      const currentFile = segSF.path || "";
      const groupStart = i;
      const collected: { seg: ToolSegment; diff: NonNullable<ToolSegment["diff"]> }[] = [];
      while (i < segments.length) {
        const sf = singleFileOf(segments[i]);
        if (sf && sf.path === currentFile) {
          collected.push({ seg: segments[i] as ToolSegment, diff: sf.diff });
          i++;
        } else {
          break;
        }
      }
      // 单次编辑不分组，直接走 FileEditItem
      if (collected.length === 1) {
        const { seg: e, diff } = collected[0];
        nodes.push(
          <ToolCallItem
            key={e.id}
            tool={{ id: e.id, name: e.name, status: e.status, description: e.name === "apply_patch" ? "已应用补丁" : e.description, command: e.command, cwd: e.cwd, output: e.output, query: e.query, diff, diagnostics: e.diagnostics, pending: e.pending, rejected: e.rejected, undoable: e.undoable, reverted: e.reverted, editId: diff.editId, displayName: editDisplay(diff.path) }}
            onAcceptEdit={onAcceptEdit}
            onRejectEdit={onRejectEdit}
            onUndoEdit={onUndoEdit}
          />
        );
        continue;
      }
      // 多次编辑合并为分组（每次编辑是独立单元，可逐次接受/拒绝/撤销）
      const firstSeg = segments[groupStart] as ToolSegment;
      const shortName = editDisplay(currentFile);
      const group: EditGroupData = {
        id: firstSeg.id,
        fileName: shortName,
        // 同文件多次编辑里全是打补丁时，标题说"已应用补丁"而不是"已编辑"；
        // 混编（先 str_replace 再 apply_patch 同一文件）按"编辑"讲——那确实是多次编辑
        kind: collected.every((c) => c.seg.name === "apply_patch") ? "patch" : "edit",
        pending: collected.some((c) => c.seg.pending),
        undoable: collected.some((c) => c.seg.undoable),
        reverted: collected.length > 0 && collected.every((c) => c.seg.reverted),
        edits: collected.map(({ seg: t, diff }) => ({
          id: t.id, name: t.name, status: t.status, description: t.description, command: t.command, cwd: t.cwd, output: t.output, query: t.query, diff, diagnostics: t.diagnostics, pending: t.pending, rejected: t.rejected, undoable: t.undoable, reverted: t.reverted, editId: diff.editId,
        })),
      };
      nodes.push(<EditGroupItem key={`edit-group-${firstSeg.id}`} group={group} onAcceptEdit={onAcceptEdit} onRejectEdit={onRejectEdit} onUndoEdit={onUndoEdit} />);
      continue;
    }

    // apply_patch 多文件：一次调用改多个文件，复用 EditGroupItem 分组卡（单文件已在上面的合并分支处理）。
    if (seg.type === "tool" && seg.name === "apply_patch" && seg.diffs && seg.diffs.length > 1) {
      const diffs = seg.diffs;
      // 逐文件判断 pending（部分接受后，已接受文件独立脱 pending）
      const pp = new Set(seg.pendingPaths || []);
      const fileIsPending = (path: string) => seg.pending ? pp.size === 0 || pp.has(path) : false;
      // 逐文件判断 undoable（只有后端 undoable 列表里有的文件才显示撤销图标）
      const undoableSet = new Set(((seg as any).undoablePaths as string[] | undefined) || []);
      const fileIsUndoable = (path: string) => !!seg.undoable && undoableSet.has(path);
      // 逐文件判断已撤销（只灰对应行）
      const revertedSet = new Set(((seg as any).revertedPaths as string[] | undefined) || []);
      const fileIsReverted = (path: string) => revertedSet.has(path) || !!seg.reverted;
      {
        const group: EditGroupData = {
          id: seg.id,
          fileName: `${diffs.length} 个文件`,
          multiFile: true,
          kind: "patch",
          pending: !!seg.pending,
          undoable: !!seg.undoable,
          reverted: !!seg.reverted,
          edits: diffs.map((d, idx) => ({
            id: `${seg.id}-${idx}`,
            name: "apply_patch",
            status: seg.status,
            description: "",
            diff: d,
            pending: fileIsPending(d.path),
            rejected: seg.rejected,
            undoable: fileIsUndoable(d.path),
            reverted: fileIsReverted(d.path),
            editId: d.editId,
            displayName: editDisplay(d.path),
          })),
        };
        nodes.push(<EditGroupItem key={`patch-group-${seg.id}`} group={group} onAcceptEdit={onAcceptEdit} onRejectEdit={onRejectEdit} onUndoEdit={onUndoEdit} />);
      }
      i++;
      continue;
    }

    // 连续 use_skill 段：合并成一张卡片（多个 skill 并排展示，与 read_file 分组一致）
    if (seg.type === "tool" && seg.name === "use_skill") {
      const groupStart = i;
      const skillNames: string[] = [];
      let pending = false;
      let executing = false;
      while (i < segments.length) {
        const s = segments[i];
        if (s.type === "tool" && s.name === "use_skill") {
          const n = (s.args?.name as string) || "";
          if (n && !skillNames.includes(n)) skillNames.push(n);
          if (isToolInFlight(s.status)) pending = true;
          if (s.status === "pending") executing = true;
          i++;
        } else {
          break;
        }
      }
      const groupSeg = segments[groupStart] as ToolSegment;
      nodes.push(<SkillBadgeCard key={`useskill-${groupSeg.id}`} skills={skillNames} pending={pending} queuedOnly={pending && !executing} />);
      continue;
    }

    // create_artifact / render_media 段：渲染成产物卡片，不走普通工具卡片。
    // render_media 的成片同样走 artifact 协议，卡片、历史恢复都是同一套。
    // 每次调用就是一份独立产物（同名会存成新版本），所以不做合并/去重，一次调用一张卡。
    if (seg.type === "tool" && (seg.name === "create_artifact" || seg.name === "render_media")) {
      nodes.push(<ArtifactCard key={seg.id} seg={seg} />);
      i++;
      continue;
    }

    // activate_power 段：整轮按 Power 名去重，只在首次出现处渲染一张最完整的卡片
    if (seg.type === "tool" && seg.name === "activate_power") {
      const key = powerKey(seg);
      i++; // 消费当前 seg
      if (renderedPowers.has(key)) continue; // 同一 Power 已渲染过，跳过重复卡片
      renderedPowers.add(key);
      const rep = powerReps.get(key) || seg;
      nodes.push(
        <ToolCallItem
          key={rep.id}
          tool={{ id: rep.id, name: rep.name, status: rep.status, description: rep.description, args: rep.args, powerActivated: rep.powerActivated }}
        />
      );
      continue;
    }

    // 连续浏览器操作段：合并成 Browser Session 大卡片
    if (seg.type === "tool" && BROWSER_TOOL_NAMES.has(seg.name)) {
      const groupStart = i;
      const steps: import("@/components/ToolCallItem").ToolCallData[] = [];
      let url: string | undefined;
      let closed = false;
      let hasError = false;
      let pending = false;
      let executing = false;
      while (i < segments.length) {
        const s = segments[i];
        if (s.type === "tool" && BROWSER_TOOL_NAMES.has(s.name)) {
          steps.push({
            id: s.id, name: s.name, status: s.status, description: s.description,
            command: s.command, output: s.output, args: s.args,
            queuedWaiting: queuedWaitingIds.has(s.id),
          });
          if (s.name === "open_browser" && typeof s.args?.url === "string") url = s.args.url as string;
          if (s.name === "close_browser" && s.status === "success") closed = true;
          if (s.status === "error") hasError = true;
          if (isToolInFlight(s.status)) pending = true;
          if (s.status === "pending") executing = true;
          i++;
        } else {
          break;
        }
      }
      const firstSeg = segments[groupStart] as ToolSegment;
      nodes.push(
        <BrowserSessionGroup
          key={`browser-session-${firstSeg.id}`}
          group={{ id: firstSeg.id, url, steps, closed, hasError, pending, queuedOnly: pending && !executing }}
        />
      );
      continue;
    }

    // 其他工具段
    nodes.push(
      <ToolCallItem
        key={seg.id}
        tool={{ id: seg.id, name: seg.name, status: seg.status, description: seg.description, command: seg.command, cwd: seg.cwd, output: seg.output, query: seg.query, args: seg.args, diff: seg.diff, diffs: seg.diffs, diagnostics: seg.diagnostics, searchResults: seg.searchResults, fetchResult: seg.fetchResult, powerActivated: seg.powerActivated, pending: seg.pending, rejected: seg.rejected, mcpServer: seg.mcpServer, mcpTool: seg.mcpTool, queuedWaiting: queuedWaitingIds.has(seg.id), waitingFor: activeWaitingFor(seg) }}
        onAcceptEdit={onAcceptEdit}
        onRejectEdit={onRejectEdit}
      />
    );
    i++;
  }

  return nodes;
}


/**
 * 流式光标 —— 贴合 Axon 神经元品牌主题的"脉冲核心"。
 * 渐变核心呼吸（indigo→cyan）+ 向外扩散并褪色的信号环（indigo→violet），
 * 比黑方块更有生命感，呼应 AxonLogo 的"核心发光 + 信号脉冲"。
 */
function StreamingCursor() {
  return null;
}

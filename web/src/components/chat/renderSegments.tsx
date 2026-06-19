/**
 * Segment 渲染与相关卡片组件
 * 从原 ChatPanel.tsx 拆出：renderSegments + SkillBadgeCard / RelayProgressCard / SubAgentCard。
 *
 * renderSegments 把 segments 渲染为节点，并把"连续相邻的同类工具调用"合并成分组卡片
 * （search / read_file / 同文件编辑 / use_skill / relay）。SubAgentCard 复用 renderSegments
 * 渲染子 agent 内部流程，故几者放在同一文件内以解循环依赖。
 */

import { useState, type ReactNode } from "react";
import { Loader2, Boxes, ListChecks, ChevronRight, ChevronDown, Check, X, Bot } from "lucide-react";
import { MarkdownRenderer } from "@/components/MarkdownRenderer";
import {
  ToolCallItem, SearchGroupItem, ReadFileGroupItem, EditGroupItem,
  BrowserSessionGroup, BROWSER_TOOL_NAMES,
  fallbackIntent, disambiguatePaths, toLineNumber,
  type ToolStatus, type SearchGroupData, type ReadFileGroupData, type EditGroupData,
} from "@/components/ToolCallItem";
import type { Segment, ToolSegment, SubAgentSegment } from "./types";
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
export function SkillBadgeCard({ skills, pending }: { skills: string[]; pending?: boolean }) {
  const names = skills.filter(Boolean);
  return (
    <div className="my-2 flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/5 px-2.5 py-1.5 flex-wrap">
      {pending
        ? <Loader2 className="w-3.5 h-3.5 shrink-0 text-primary animate-spin" />
        : <Boxes className="w-3.5 h-3.5 shrink-0 text-green-600" />}
      <span className="text-xs text-muted-foreground shrink-0">{pending ? "加载 Skill" : "使用 Skill"}</span>
      {names.map((n) => (
        <span key={n} className="px-1.5 py-0.5 rounded bg-primary/10 text-xs font-mono font-medium text-primary">{n}</span>
      ))}
    </div>
  );
}

/**
 * Relay 进度卡片：把一串连续的 Relay 工具调用合并成一行可展开的轨迹。
 * 折叠态只显示最新一步（一行，省空间）；展开看完整步骤。
 * 完整可视化（阶段进度条/任务清单/评审）在右侧 Relay 面板，这里只是对话流里的轻量提示。
 */
export function RelayProgressCard({ steps, pending }: { steps: { name: string; description: string; status: ToolStatus; relayId?: string }[]; pending?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  if (steps.length === 0) return null;
  const last = steps[steps.length - 1];
  const hasError = steps.some((s) => s.status === "error");

  // 从 steps 中提取 relay ID（relay_create 的 description 包含 "id: xxx"）
  const relayId = steps.find((s) => s.relayId)?.relayId;

  const handleClick = () => {
    if (relayId) {
      const vs = (window as any).__axonVSCode;
      if (vs) {
        vs.postMessage({ type: "open_relay", relayId });
        return;
      }
    }
    setExpanded((v) => !v);
  };

  return (
    <div className="my-2 rounded-lg border border-primary/30 bg-primary/5 overflow-hidden">
      <button
        onClick={handleClick}
        className="flex items-center gap-2 w-full py-1.5 px-2.5 text-xs text-left hover:bg-primary/10 transition-colors"
      >
        {pending
          ? <Loader2 className="w-3.5 h-3.5 shrink-0 text-primary animate-spin" />
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
                : <Check className="w-3 h-3 shrink-0 text-green-600" />}
              <span className="text-muted-foreground/80 truncate">{s.description}</span>
            </div>
          ))}
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
  const running = seg.status === "running";
  const verb = running ? "Invoking" : "Invoked";

  // 子 agent 最终结论（后端 sub_agent_end 明确返回）
  const conclusion = !running ? seg.conclusion : null;

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
          : <Bot className="w-3.5 h-3.5 shrink-0 text-green-600" />}
        <span className="font-medium text-foreground shrink-0">{verb} Sub-Agent</span>
        {seg.skill && (
          <span className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-primary/10 text-[10px] font-mono text-primary shrink-0">
            <Boxes className="w-3 h-3" />
            {seg.skill}
          </span>
        )}
        <span className="text-muted-foreground truncate">{seg.intent}</span>
      </button>
      {/* 折叠态结论摘要：done + 未展开时，显示最终结论（限高可滚动） */}
      {!expanded && conclusion && (
        <div className="border-t border-border/50 px-2.5 py-1.5 max-h-40 overflow-y-auto [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-transparent [&::-webkit-scrollbar-track]:bg-transparent [&:hover::-webkit-scrollbar-thumb]:bg-muted-foreground/30">
          <MarkdownRenderer content={conclusion} />
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
  // 过滤掉 hidden 的 tool segment（软失败的前 N 次重试不展示给用户）
  segments = segments.filter((s) => !(s.type === "tool" && (s as ToolSegment).hidden));

  const nodes: ReactNode[] = [];
  let i = 0;

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
      if (streaming && isLast) {
        nodes.push(
          <div key={`text-${i}`} className="relative">
            <MarkdownRenderer content={seg.content} />
            <StreamingCursor />
          </div>
        );
      } else if (seg.content.trim()) {
        nodes.push(<MarkdownRenderer key={`text-${i}`} content={seg.content} />);
      }
      i++;
      continue;
    }

    // 子 Agent 委托段：折叠卡片（委托用的 skill 显示在卡片标题，不再外层单独飘一个）
    if (seg.type === "subagent") {
      nodes.push(<SubAgentCard key={`sub-${seg.id}`} seg={seg} />);
      i++;
      continue;
    }

    // 连续 Relay 工具段：合并成一张精简的"Relay 进度"卡片。
    // 这些状态机操作的完整可视化在右侧 Relay 面板，对话流里只保留一行可展开的轨迹，避免刷屏。
    if (seg.type === "tool" && isRelayTool(seg.name)) {
      const groupStart = i;
      const steps: { name: string; description: string; status: ToolStatus; relayId?: string }[] = [];
      let pending = false;
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
          if (s.status === "pending") pending = true;
          i++;
        } else {
          break;
        }
      }
      const groupSeg = segments[groupStart] as ToolSegment;
      nodes.push(<RelayProgressCard key={`relay-${groupSeg.id}`} steps={steps} pending={pending} />);
      continue;
    }

    // 连续探索段（search / list_dir）：向后收集所有相邻的探索调用，合并成一个卡片
    if (seg.type === "tool" && (seg.name === "search" || seg.name === "list_dir")) {
      const groupStart = i;
      const queries: string[] = [];
      let pending = false;
      while (i < segments.length) {
        const s = segments[i];
        if (s.type === "tool" && (s.name === "search" || s.name === "list_dir")) {
          queries.push(s.query || fallbackIntent(s.name));
          if (s.status === "pending") pending = true;
          i++;
        } else {
          break;
        }
      }
      const groupSeg = segments[groupStart] as ToolSegment;
      const group: SearchGroupData = { id: groupSeg.id, pending, queries };
      nodes.push(<SearchGroupItem key={`search-${groupSeg.id}`} group={group} />);
      continue;
    }

    // 连续 read_file 段：合并成一张卡片
    if (seg.type === "tool" && seg.name === "read_file") {
      const groupStart = i;
      // 先收集每个文件的完整路径 + 行号区间，最后统一做消歧展示
      const raw: { fullPath: string; range?: string; startLine?: number; endLine?: number }[] = [];
      let pending = false;
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
          if (s.status === "pending") pending = true;
          if (s.status === "error") hasError = true;
          i++;
        } else {
          break;
        }
      }
      // 消歧：同名文件补最短区分路径，否则只显示文件名
      const displayNames = disambiguatePaths(raw.map((r) => r.fullPath));
      const files = raw.map((r, idx) => ({ name: displayNames[idx], range: r.range, path: r.fullPath, startLine: r.startLine, endLine: r.endLine }));
      const groupSeg = segments[groupStart] as ToolSegment;
      const group: ReadFileGroupData = { id: groupSeg.id, pending, hasError, files };
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
            tool={{ id: e.id, name: e.name, status: e.status, description: e.name === "apply_patch" ? "已编辑" : e.description, command: e.command, cwd: e.cwd, output: e.output, query: e.query, diff, diagnostics: e.diagnostics, pending: e.pending, rejected: e.rejected, undoable: e.undoable, reverted: e.reverted, editId: diff.editId, displayName: editDisplay(diff.path) }}
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
      while (i < segments.length) {
        const s = segments[i];
        if (s.type === "tool" && s.name === "use_skill") {
          const n = (s.args?.name as string) || "";
          if (n && !skillNames.includes(n)) skillNames.push(n);
          if (s.status === "pending") pending = true;
          i++;
        } else {
          break;
        }
      }
      const groupSeg = segments[groupStart] as ToolSegment;
      nodes.push(<SkillBadgeCard key={`useskill-${groupSeg.id}`} skills={skillNames} pending={pending} />);
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
      while (i < segments.length) {
        const s = segments[i];
        if (s.type === "tool" && BROWSER_TOOL_NAMES.has(s.name)) {
          steps.push({
            id: s.id, name: s.name, status: s.status, description: s.description,
            command: s.command, output: s.output, args: s.args,
          });
          if (s.name === "open_browser" && typeof s.args?.url === "string") url = s.args.url as string;
          if (s.name === "close_browser" && s.status === "success") closed = true;
          if (s.status === "error") hasError = true;
          if (s.status === "pending") pending = true;
          i++;
        } else {
          break;
        }
      }
      const firstSeg = segments[groupStart] as ToolSegment;
      nodes.push(
        <BrowserSessionGroup
          key={`browser-session-${firstSeg.id}`}
          group={{ id: firstSeg.id, url, steps, closed, hasError, pending }}
        />
      );
      continue;
    }

    // 其他工具段
    nodes.push(
      <ToolCallItem
        key={seg.id}
        tool={{ id: seg.id, name: seg.name, status: seg.status, description: seg.description, command: seg.command, cwd: seg.cwd, output: seg.output, query: seg.query, args: seg.args, diff: seg.diff, diffs: seg.diffs, diagnostics: seg.diagnostics, searchResults: seg.searchResults, fetchResult: seg.fetchResult, powerActivated: seg.powerActivated, pending: seg.pending, rejected: seg.rejected, mcpServer: seg.mcpServer, mcpTool: seg.mcpTool }}
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
  return (
    <span className="inline-block align-[-0.2em] ml-1" aria-hidden="true" style={{ width: 16, height: 16 }}>
      <svg viewBox="0 0 24 24" width="16" height="16">
        <defs>
          <radialGradient id="axon-cursor-core" cx="42%" cy="38%" r="62%">
            <stop offset="0%" stopColor="#ffffff" />
            <stop offset="45%" stopColor="#38bdf8" />
            <stop offset="100%" stopColor="#6366f1" />
          </radialGradient>
        </defs>
        {/* 向外扩散的信号环（emit） */}
        <circle cx="12" cy="12" r="4" fill="none" stroke="#818cf8" strokeWidth="1.6">
          <animate attributeName="r" values="3.5;10" dur="1.4s" repeatCount="indefinite" />
          <animate attributeName="opacity" values="0.7;0" dur="1.4s" repeatCount="indefinite" />
          <animate attributeName="stroke" values="#6366f1;#a78bfa" dur="1.4s" repeatCount="indefinite" />
        </circle>
        {/* 呼吸的核心 */}
        <circle cx="12" cy="12" r="4.5" fill="url(#axon-cursor-core)">
          <animate attributeName="r" values="3.8;5.4;3.8" dur="1.4s" repeatCount="indefinite" calcMode="spline" keySplines="0.4 0 0.2 1;0.4 0 0.2 1" keyTimes="0;0.5;1" />
          <animate attributeName="opacity" values="1;0.85;1" dur="1.4s" repeatCount="indefinite" />
        </circle>
      </svg>
    </span>
  );
}

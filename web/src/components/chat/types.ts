/**
 * ChatPanel 相关类型与常量
 *
 * 从原 ChatPanel.tsx 拆出：聊天消息 / segment / 附件 / 回复风格等纯类型定义，
 * 供 ChatPanel 壳层、useChatSession hook 与各展示组件共享。
 */

import type { ToolStatus } from "@/components/ToolCallItem";

/** 一个 segment 可以是文本、工具调用或子 Agent 委托 */
export interface TextSegment {
  type: "text";
  content: string;
}

export interface ToolSegment {
  type: "tool";
  id: string;
  /** 是否已绑定后端真实工具调用 id（true 后不再被同名事件抢占匹配） */
  boundId?: boolean;
  name: string;
  status: ToolStatus;
  description: string;
  command?: string; // execute_command 专用：命令内容
  cwd?: string;     // execute_command 专用：工作目录
  output?: string;  // execute_command 专用：执行结果
  query?: string;   // search 专用：搜索关键词
  args?: Record<string, unknown>; // 原始工具参数，用于失败态仍能展示路径等关键信息
  diff?: { path: string; oldContent: string; newContent: string; editId?: string }; // str_replace/create_file 专用：本次修改的完整文件前后快照
  diffs?: { path: string; absPath?: string; oldContent: string; newContent: string; editId?: string }[]; // apply_patch 专用：一次改多个文件
  diagnostics?: { path: string; ok: boolean; errorCount: number }[]; // check_diagnostics 专用：按文件诊断结果
  searchResults?: { query: string; source: string; results: { title: string; url: string; snippet: string; domain: string; date?: string }[] }; // web_search 专用
  fetchResult?: { url: string; title: string; byteSize: number; success: boolean; error?: string }; // web_fetch 专用
  powerActivated?: { name: string; displayName: string; mcpServerCount: number; skillCount: number; keywords: string[] }; // activate_power 专用
  pending?: boolean; // str_replace/create_file 专用：手动模式下是否待确认（未落盘）
  rejected?: boolean; // str_replace/create_file 专用：该改动已被用户拒绝
  undoable?: boolean; // 该改动已被接受、可撤销（右侧显示撤销图标）
  reverted?: boolean; // 该改动已被用户撤销（恢复到接受前）
  /** apply_patch 多文件分组：逐文件 pending 路径列表（子项据此独立判断自身 pending 状态） */
  pendingPaths?: string[];
  /** apply_patch 多文件分组：逐文件 undoable 路径列表（只有后端确认可撤销的文件才显示撤销图标） */
  undoablePaths?: string[];
  /** apply_patch 多文件分组：逐文件已撤销路径列表（只灰对应行，不整卡置灰） */
  revertedPaths?: string[];
  userMessage?: string; // 失败态：给用户看的简短文案（不含内部工具名），优先于 result 展示
  /** 该工具调用卡片是否对用户隐藏（中性结果：文件不存在/已存在被拦等试探性调用） */
  hidden?: boolean;
  /** read_file 专用：后端 resolve 后的绝对路径（点击打开文件用） */
  resolvedPath?: string;
  /** MCP 工具专用：真实 server 名 / 工具名（后端透传，卡片展示用） */
  mcpServer?: string;
  mcpTool?: string;
}

export type Segment = TextSegment | ToolSegment | SubAgentSegment;

/** 用户消息的内联片段：纯文本 或 一个上下文 tag（用于气泡里把 tag 渲染成内联 pill） */
export type UserSegment = { type: "text"; text: string } | { type: "tag"; tag: AttachedFile };

/** 子 Agent 委托段：折叠卡片，内部维护独立的 segments（实时流式 4B 模式） */
export interface SubAgentSegment {
  type: "subagent";
  /** 与后端 delegateId 对应，用于路由内部事件 */
  id: string;
  /** 委托意图（标题行展示），来自 delegate_task 的 intent 参数 */
  intent: string;
  /** 加载的 skill 名称（可选） */
  skill?: string | null;
  /** 传给子 agent 的完整 prompt（展开区灰框展示） */
  prompt: string;
  /** 执行状态：running / done */
  status: "running" | "done";
  /** 子 agent 内部的 segment 流（复用 renderSegments 渲染） */
  inner: Segment[];
  /** 子 agent 内部当前是否在流式输出文字（控制内部打字光标） */
  innerStreaming?: boolean;
  /** 子 agent 最终结论（sub_agent_end 时由后端明确返回，折叠时展示） */
  conclusion?: string;
}

/** 聊天消息：用户消息 或 AI 回复（一个 turn 含多个 segment） */
export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  /** 消息创建时间戳（毫秒） */
  timestamp?: number;
  // user 用
  content?: string;
  images?: string[];
  attachedFiles?: AttachedFile[]; // user 上传的文本文件
  // assistant 用
  segments?: Segment[];
  /** user 用：内联片段（文本 + tag），用于富文本渲染用户气泡 */
  userSegments?: UserSegment[];
  streaming?: boolean;
  /** 本轮状态：pending=等待响应 / running=执行中 / success=正常完成 / cancelled=用户取消 / error=异常中断 */
  turnStatus?: "pending" | "running" | "success" | "cancelled" | "error";
  turnStats?: { elapsed: number; tokens: number; model?: string; credits?: number; creditDetail?: CreditDetail };
  /** turn 代数：取消后启动新轮时递增，防止陈旧事件穿透到新轮 */
  turnGen?: number;
}

/** Credits 明细（hover 展示） */
export interface CreditDetail {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  inputRate: number;
  outputRate: number;
  tier: string;
  /** 记忆（对话历史）token */
  memoryTokens?: number;
  /** system token（系统提示 + 工具 + skill/power + IDE 上下文等框架开销） */
  systemTokens?: number;
  /** 本次问题 token（本次输入 + 本轮子 Agent 总 token） */
  questionTokens?: number;
}

/** 上传的文本文件 / 注入的上下文（如终端选区） */
export interface AttachedFile {
  name: string;
  content: string;
  size: number;
  /**
   * 来源类型：
   * - file=文件（用户上传 / 斜杠命令选中），terminal=终端选区，editor=编辑器代码选区
   * - folder=文件夹引用（斜杠命令选中），diagnostics=当前文件的问题/诊断
   */
  kind?: "file" | "terminal" | "editor" | "folder" | "diagnostics";
}

/** 回复风格预设 */
export type ReplyStyle = "concise" | "default" | "detailed";

export const REPLY_STYLES: { id: ReplyStyle; label: string; hint: string }[] = [
  { id: "concise", label: "简洁", hint: "直奔结论，尽量短" },
  { id: "default", label: "默认", hint: "平衡详略" },
  { id: "detailed", label: "详细", hint: "展开讲解，多给背景" },
];

/**
 * ChatPanel props（多会话版）。
 * - clientId：本面板的稳定标识，用于事件总线路由与命令打标（每个 tab 一个，跨切换稳定）。
 * - sessionId：当前会话 id（null = 新会话，尚未创建）。
 * - connected / send：App 级共享的 Agent 连接状态与发送函数。
 * - onSessionCreated：会话被创建后回传新 id，供上层更新 tab。
 * - onStreamingChange：本面板流式状态变化（true=RUNNING），供 SessionContainer 决定保活/卸载。
 */
export interface ChatPanelProps {
  clientId: string;
  sessionId: string | null;
  /** 会话模式：agent=智能体，quest=纯问答 */
  mode: "agent" | "quest";
  connected: boolean;
  /** 本面板是否为当前可见（激活）的 tab。由 false→true 时自动滚到底部。 */
  active: boolean;
  send: (cmd: Record<string, unknown>) => void;
  onSessionCreated: (id: string) => void;
  onStreamingChange?: (streaming: boolean) => void;
}

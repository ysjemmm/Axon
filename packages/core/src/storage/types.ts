/**
 * 会话存储抽象层 - 接口定义
 *
 * 当前实现：本地 JSON 文件
 * 未来扩展：SQLite / 云端 API
 */

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { EditHunk } from "../host/edits.js";

/** 会话摘要（列表用，不含完整消息） */
export interface SessionMeta {
  id: string;
  title: string;
  model: string;
  workspace: string; // 工作区绝对路径
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  /** 会话模式：agent=智能体（默认），quest=纯问答 */
  mode?: "agent" | "quest";
}

/** 持久化的待确认编辑（序列化友好，不含 Map） */
export interface SerializedPendingEdit {
  absPath: string;       // 文件绝对路径（Map key）
  path: string;          // 相对路径（展示用）
  originalContent: string;
  newContent: string;
  isNew: boolean;
  /** 撤销锚点（局部改动块）。缺省视为空数组（旧数据兼容） */
  hunks?: EditHunk[];
  /** 是否整文件写入（create_file / patch add）。缺省视为 false */
  fullRewrite?: boolean;
  /** 编辑单元 id（缺省回退 absPath，旧数据兼容） */
  editId?: string;
}

/** 完整会话数据 */
export interface SessionData {
  id: string;
  title: string;
  model: string;
  provider: string;
  workspace: string; // 工作区绝对路径（AI 读写文件、执行命令的根目录）- 向后兼容保留
  workspaces?: string[]; // 多工作区路径列表（工作区组绑定时使用）
  workspaceGroupId?: string; // 绑定的工作区组 ID
  messages: ChatCompletionMessageParam[];
  totalTokens: number; // 当前上下文 token 占用（API 真实 prompt token）
  pendingEdits?: SerializedPendingEdit[]; // 手动模式下暂存的待确认改动
  /** 会话模式：agent=智能体（默认），quest=纯问答（无工具/不绑工作区） */
  mode?: "agent" | "quest";
  createdAt: string;
  updatedAt: string;
}

/** 存储接口（未来换实现只需实现此接口） */
export interface SessionStorage {
  /** 获取所有会话摘要（按 updatedAt 降序） */
  listSessions(): Promise<SessionMeta[]>;

  /** 获取单个会话完整数据 */
  getSession(id: string): Promise<SessionData | null>;

  /** 创建会话 */
  createSession(data: Omit<SessionData, "createdAt" | "updatedAt">): Promise<SessionData>;

  /** 更新会话（消息追加、标题修改等） */
  updateSession(id: string, patch: Partial<Pick<SessionData, "title" | "model" | "provider" | "workspace" | "workspaces" | "workspaceGroupId" | "messages" | "totalTokens" | "pendingEdits">>): Promise<void>;

  /** 删除会话 */
  deleteSession(id: string): Promise<void>;
}

import { isScriptFile } from "./taskIntent";

export interface OutputFile {
  path: string;
  kind?: "created" | "edited";
  /** 原稿快照目录（edited 且有快照时存在）：查看改动/恢复原稿的依据 */
  snapshotDir?: string;
}

interface HistoryToolCall {
  id?: string;
  function?: { name?: string; arguments?: string };
}

export interface HistoryMessage {
  role?: string;
  tool_calls?: HistoryToolCall[];
  tool_call_id?: string;
  _toolName?: string;
  status?: string;
  content?: unknown;
  reportedOutputs?: string[];
  reportedOutputItems?: OutputFile[];
}

function absolutePath(path: string): boolean {
  return /^(?:[a-z]:[\\/]|[\\/])/i.test(path);
}

function reportedPaths(call: HistoryToolCall | undefined, content: unknown): string[] {
  if (call?.function?.name !== "report_outputs" || typeof content !== "string") return [];
  const count = /已登记\s*(\d+)\s*个产出文件/.exec(content);
  if (!count || Number(count[1]) === 0) return [];

  try {
    const args = JSON.parse(call.function.arguments || "{}") as { files?: { path?: string }[] };
    const files = Array.isArray(args.files) ? args.files : [];
    const missing = content.includes("以下路径在磁盘上不存在，未登记：")
      ? new Set(content.split("以下路径在磁盘上不存在，未登记：")[1]
        .split("请确认文件确实已写入")[0]
        .split("\n").map((line) => line.replace(/^- /, "").trim()).filter(Boolean))
      : new Set<string>();
    const paths = [...new Set(files.map((file) => file.path?.trim() || "")
      .filter((path) => absolutePath(path) && !missing.has(path)))];
    // 旧版仅保存成功数量和原始参数；数量对不上时无法辨认具体成功项，不猜测。
    return paths.length === Number(count[1]) ? paths : [];
  } catch {
    return [];
  }
}

/** 从一个用户回合的历史消息中恢复实际展示过的产出，不重放工具调用。 */
export function restoreOutputs(messages: HistoryMessage[]): OutputFile[] {
  const calls = new Map<string, HistoryToolCall>();
  let outputs: OutputFile[] = [];
  for (const message of messages) {
    if (message.role === "assistant") {
      for (const call of message.tool_calls || []) {
        if (call.id) calls.set(call.id, call);
      }
    }
    if (message.role !== "tool") continue;
    const call = calls.get(message.tool_call_id || "");
    const name = message._toolName || call?.function?.name;
    if (name === "report_outputs") {
      const files = Array.isArray(message.reportedOutputItems)
        ? message.reportedOutputItems.filter((file) => typeof file.path === "string" && file.path.length > 0)
          .map((file) => ({
            path: file.path,
            ...(file.kind === "created" || file.kind === "edited" ? { kind: file.kind } : {}),
          }))
        : (Array.isArray(message.reportedOutputs)
          ? message.reportedOutputs
          : message.status === "success" ? reportedPaths(call, message.content) : [])
          .map((path) => ({ path }));
      if (files.length > 0) outputs = files;
    } else if (name === "create_file" && message.status === "success") {
      try {
        const args = JSON.parse(call?.function?.arguments || "{}") as { path?: string };
        const path = args.path?.trim() || "";
        const fileName = path.replace(/\\/g, "/").split("/").pop() || "";
        if (absolutePath(path) && !isScriptFile(fileName) && !outputs.some((file) => file.path === path)) {
          outputs = [...outputs, { path }];
        }
      } catch {
        // 旧会话缺少参数或参数损坏时不从回复正文猜文件路径。
      }
    }
  }
  return outputs;
}

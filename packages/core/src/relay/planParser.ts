/**
 * plan.md 任务清单解析与回写
 *
 * 约定的任务清单格式（Markdown 复选框，支持层级编号）：
 *   - [ ] 1. 顶层任务标题
 *     - [ ] 1.1 子任务标题
 *       说明文字（缩进的非复选框行作为该任务的 details）
 *   - [x] 2. 已完成的任务
 *
 * 设计要点：
 * - 解析时只认 `- [ ]` / `- [x]` 行，编号（1. / 1.2）从标题里提取，提不到就按出现顺序生成
 * - 回写时只翻转复选框状态，不重排、不改写用户/模型写的正文，保证 plan.md 仍可读可手改
 */

import type { RelayTask } from "./types.js";

/** 复选框行正则：捕获缩进、勾选标记、剩余文本 */
const CHECKBOX_RE = /^(\s*)-\s*\[([ xX])\]\s+(.*)$/;
/** 从任务文本开头提取层级编号（如 "1."、"1.2"、"1.2.3"） */
const NUMBER_RE = /^(\d+(?:\.\d+)*)[.)]?\s+(.*)$/;

/**
 * 从 plan.md 正文解析出结构化任务清单。
 * @param markdown plan.md 全文
 * @returns 任务数组（顺序与文档一致）
 */
export function parseTasks(markdown: string): RelayTask[] {
  const lines = (markdown || "").split("\n");
  const tasks: RelayTask[] = [];
  let autoSeq = 0;
  let lastTaskIndentLen = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(CHECKBOX_RE);
    if (!m) {
      // 非复选框行：若缩进比上一个任务更深，作为该任务 details 追加
      if (tasks.length > 0 && line.trim() && lastTaskIndentLen >= 0) {
        const indentLen = line.match(/^\s*/)?.[0].length ?? 0;
        if (indentLen > lastTaskIndentLen) {
          const t = tasks[tasks.length - 1];
          t.details = t.details ? `${t.details}\n${line.trim()}` : line.trim();
        }
      }
      continue;
    }

    const indent = m[1];
    const checked = m[2].toLowerCase() === "x";
    const rest = m[3].trim();

    // 提取编号与标题
    let id: string;
    let title: string;
    const nm = rest.match(NUMBER_RE);
    if (nm) {
      id = nm[1];
      title = nm[2].trim();
    } else {
      autoSeq++;
      id = String(autoSeq);
      title = rest;
    }

    tasks.push({
      id,
      title,
      status: checked ? "completed" : "pending",
    });
    lastTaskIndentLen = indent.length;
  }

  return tasks;
}

/**
 * 把任务状态回写进 plan.md：只翻转对应任务行的复选框，不动其它内容。
 * 通过「编号 + 标题」匹配定位行，匹配不到的任务忽略（不报错，保持文档稳定）。
 * @param markdown 原 plan.md
 * @param tasks 带最新状态的任务清单
 * @returns 更新复选框后的 plan.md
 */
export function writeBackTaskStatus(markdown: string, tasks: RelayTask[]): string {
  const statusById = new Map(tasks.map((t) => [t.id, t.status]));
  const lines = (markdown || "").split("\n");
  let autoSeq = 0;

  const out = lines.map((line) => {
    const m = line.match(CHECKBOX_RE);
    if (!m) return line;

    const indent = m[1];
    const rest = m[3].trim();
    const nm = rest.match(NUMBER_RE);
    let id: string;
    if (nm) {
      id = nm[1];
    } else {
      autoSeq++;
      id = String(autoSeq);
    }

    const status = statusById.get(id);
    if (!status) return line;

    const mark = status === "completed" ? "x" : " ";
    return `${indent}- [${mark}] ${rest}`;
  });

  return out.join("\n");
}

/**
 * 计算下一个可执行任务：第一个 pending 且其所有依赖均已 completed 的任务。
 * 无依赖声明时退化为「文档顺序里第一个未完成任务」。
 */
export function nextExecutableTask(tasks: RelayTask[]): RelayTask | null {
  const doneIds = new Set(tasks.filter((t) => t.status === "completed").map((t) => t.id));
  for (const t of tasks) {
    if (t.status === "completed") continue;
    const depsReady = !t.deps || t.deps.every((d) => doneIds.has(d));
    if (depsReady) return t;
  }
  return null;
}

/**
 * 计算当前一批可【并行】执行的任务：所有 pending 且依赖已满足的任务。
 * 编排器据此决定哪些任务可以同时派给子 Agent。
 */
export function parallelExecutableTasks(tasks: RelayTask[]): RelayTask[] {
  const doneIds = new Set(tasks.filter((t) => t.status === "completed").map((t) => t.id));
  return tasks.filter((t) => {
    if (t.status !== "pending") return false;
    return !t.deps || t.deps.every((d) => doneIds.has(d));
  });
}

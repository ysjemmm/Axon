/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * 工具调用执行入口（迁移自 server/src/tools.ts 的 executeToolCall）
 *
 * 与执行端解耦：所有 node 文件系统/进程/诊断调用都改为走注入的 AgentHost：
 *   - readFile/writeFile/mkdir   → host.fs / host.edits
 *   - 暂存区（EditContext）       → host.edits（EditPresenter）
 *   - child_process.exec          → host.commands（含 PowerShell UTF-8 包装，由实现负责）
 *   - checkDiagnostics（tsc）      → host.diagnostics
 *
 * 危险命令检测由 CommandGate 在调用前统一处理（含用户确认），此处不再重复。
 *
 * web 能力（webSearch/webFetch）依赖 node:https/http，尚未迁入 core，
 * 通过可选的 web 注入参数提供；未注入时 web_search/web_fetch 直接报错。
 *
 * 逐字符保留模型可见的提示文本、错误文本与业务逻辑。
 */

import { resolve, relative, sep } from "node:path";
import { isWithinWorkspaces } from "./safety.js";
import {
  resolveInWorkspaces,
  owningWorkspace,
  searchEntries,
  searchContent,
  listDir,
  mergeMultiRootResults,
} from "./search.js";
import type { ToolMeta, SkillLoaderFn, PowerLoaderFn } from "./definitions.js";
import { ToolError, getToolDefinitions } from "./definitions.js";
import type { AgentHost, DiagnosticFileResult } from "../host/index.js";
import type { FileEdit } from "../host/index.js";
import type { EditHunk } from "../host/index.js";
import { parsePatch, applyHunks, PatchError } from "./applyPatch.js";
import { computeAnchorContext } from "./reverseEdit.js";

/**
 * web 能力注入：webSearch/webFetch 依赖 node 网络栈，尚未迁入 core，
 * 由上层（server/cli）注入。未注入时相关工具会报错。
 */
export interface WebCapability {
  search: (query: string) => Promise<any>;
  fetch: (url: string) => Promise<any>;
}

/**
 * 按行号范围切片文件内容，并把实际生效的行范围记到 meta.readRange 里。
 * - 行号 1-indexed，包含两端
 * - 不传或非法时回退到全文
 * - startLine 超出文件总行数返回空内容
 * - endLine 超过文件末尾自动夹到末尾
 */
function sliceByLineRange(
  content: string,
  startLine: unknown,
  endLine: unknown,
  meta?: ToolMeta,
): string {
  const lines = content.split("\n");
  const total = lines.length;

  // 解析与校验
  const rawStart = typeof startLine === "number" ? startLine : parseInt(String(startLine ?? ""), 10);
  const rawEnd = typeof endLine === "number" ? endLine : parseInt(String(endLine ?? ""), 10);
  const hasStart = Number.isFinite(rawStart) && rawStart >= 1;
  const hasEnd = Number.isFinite(rawEnd) && rawEnd >= 1;

  // 既无 start 也无 end：返回全文，不记 readRange
  if (!hasStart && !hasEnd) return content;

  const start = hasStart ? Math.max(1, Math.floor(rawStart)) : 1;
  const end = hasEnd ? Math.min(total, Math.floor(rawEnd)) : total;
  if (start > total || start > end) {
    if (meta) meta.readRange = { startLine: start, endLine: start };
    return `（请求的行范围 ${start}-${hasEnd ? end : "EOF"} 超出文件实际行数 ${total}）`;
  }

  if (meta) meta.readRange = { startLine: start, endLine: end };
  return lines.slice(start - 1, end).join("\n");
}

/**
 * 呈现一处文件改动。
 * - diff 用"本次编辑前的有效内容"（preEditContent）作为 old，确保每张卡片只反映本次改动
 * - 落盘/暂存交给 host.edits.present 决定（auto 直接落盘 / manual 暂存）
 * - rollbackOriginal 为最初磁盘原始内容（回滚基准）；present 实现会在已有暂存时沿用首次的基准
 * 返回给 AI 的提示文本片段。
 */
async function presentEdit(
  host: AgentHost,
  meta: ToolMeta | undefined,
  relPath: string,
  absPath: string,
  newContent: string,
  preEditContent: string,
  rollbackOriginal: string,
  isNewFile: boolean,
  hunks?: EditHunk[],
): Promise<string> {
  // 编辑单元 id：${toolCallId}::${相对路径}。同一文件多次工具调用 → 多个独立单元，可逐次接受/拒绝/撤销。
  const unitId = meta?.editId ? `${meta.editId}::${relPath}` : undefined;
  if (meta) {
    // 内容相同时不生成 fileDiff（没变就没 diff，前端不显示 diff 图标）
    if (preEditContent !== newContent) {
      const diff = { path: relPath, absPath, oldContent: preEditContent, newContent, editId: unitId };
      meta.fileDiff = diff; // 单文件工具向后兼容（apply_patch 多文件时为最后一个）
      (meta.fileDiffs ??= []).push(diff); // apply_patch 等多文件工具：逐文件累计
    }
  }
  const edit: FileEdit = {
    path: relPath,
    absPath,
    originalContent: rollbackOriginal,
    newContent,
    isNew: isNewFile,
    hunks,
    editId: unitId,
  };
  return host.edits.present(edit);
}

/**
 * 工作区边界校验：目标路径必须落在 cwd 或某个绑定工作区之内。
 * 越界（如 ../ 穿越到工作区外）直接 Fail-Fast 抛错，防止越权读写。
 */
function assertWithinWorkspaces(
  absPath: string,
  cwd: string,
  workspaces: string[] | undefined,
  op: string,
): void {
  const roots = workspaces && workspaces.length > 0 ? workspaces : [cwd];
  if (!isWithinWorkspaces(absPath, roots)) {
    throw new Error(
      `${op} 被安全策略拒绝：目标路径越出工作区边界。` +
      `只能在当前工作区内操作文件，不允许用 ../ 等方式访问工作区之外的路径。`,
    );
  }
}

/** 执行工具调用。meta 为可选的输出参数，用于收集附加信息（如 fileDiff）。host 提供执行端能力 */
export async function executeToolCall(
  name: string,
  // LLM 返回的 JSON 参数运行时类型不固定（read_file 的 startLine/endLine 是 number，其他是 string），用 any 放过类型检查，调用前由各 case 自行校验
  args: Record<string, any>,
  cwd: string,
  host: AgentHost,
  meta?: ToolMeta,
  workspaces?: string[],
  skillLoader?: SkillLoaderFn,
  web?: WebCapability,
  powerLoader?: PowerLoaderFn,
  signal?: AbortSignal,
): Promise<string> {
  switch (name) {
    case "read_file": {
      if (typeof args.path !== "string" || !args.path.trim()) {
        if (meta) meta.userMessage = "未指定文件路径";
        throw new Error("read_file 失败：缺少必填参数 path。请提供要读取的文件路径（字符串）。");
      }
      const filePath = await resolveInWorkspaces(args.path, cwd, host, workspaces);
      assertWithinWorkspaces(filePath, cwd, workspaces, "read_file");
      // 把解析后的绝对路径写入 meta，供前端文件名点击打开用
      if (meta) { (meta as any).resolvedPath = filePath; }
      // 优先读暂存区的待确认内容（手动模式下保持工作流连贯）
      const eff = await host.edits.readEffective(filePath);
      if (eff.fromPending) {
        const sliced = sliceByLineRange(eff.content, args.startLine, args.endLine, meta);
        return `（注意：此文件有你之前做出的、尚待用户确认的改动，以下是待确认后的内容）\n${sliced}`;
      }
      if (!eff.existsOnDisk) {
        // 文件不存在不作为"错误"抛出（避免刺眼的红色失败卡片，对齐 Kiro/Claude 的体验）。
        // 返回平静的普通结果，模型据此判断"此文件不存在"即可，不影响流程。
        // meta 标记 hidden，前端隐藏该卡片。
        if (meta) { meta.hidden = true; meta.hiddenReason = "文件不存在"; }
        return `文件不存在：${args.path}（已在工作区中确认查找，确实没有这个文件）。如果你是按惯例/技能步骤尝试读取某个可选文件（如 README），说明该项目没有它，跳过即可，不要重试。`;
      }
      try {
        const sliced = sliceByLineRange(eff.content, args.startLine, args.endLine, meta);
        // 如果实际路径和模型给的路径不一致（走了兜底），提醒模型用正确路径
        const intendedPath = resolve(cwd, args.path);
        if (filePath !== intendedPath) {
          const relFromCwd = relative(cwd, filePath).split(sep).join("/");
          return `[路径修正：你给的 "${args.path}" 不存在，实际读取的是 "${relFromCwd}"。后续请使用正确路径。]\n${sliced}`;
        }
        return sliced;
      } catch (err) {
        if (meta) meta.userMessage = `读取失败`;
        throw new Error(`read_file 失败：${args.path}，原因：${(err as Error).message}`);
      }
    }
    case "create_file": {
      if (typeof args.path !== "string" || !args.path.trim()) {
        throw new Error("create_file 失败：缺少必填参数 path。请提供要创建的文件路径（字符串）。");
      }
      if (typeof args.content !== "string") {
        throw new Error("create_file 失败：缺少必填参数 content。请提供文件内容（字符串，可为空串）。");
      }
      const filePath = await resolveInWorkspaces(args.path, cwd, host, workspaces);
      assertWithinWorkspaces(filePath, cwd, workspaces, "create_file");
      // 本次编辑前的有效内容（手动模式下可能已有暂存版本），作为 diff 基准
      const eff = await host.edits.readEffective(filePath);
      const preEditContent = eff.content;
      // 回滚基准：最初磁盘原始内容（present 实现会在已有暂存时沿用首次的基准）。
      // 直接读磁盘内容；fromPending 时磁盘内容即为最初未改动内容。
      const diskContent = await host.fs.read(filePath);
      const existsOnDisk = eff.fromPending ? eff.existsOnDisk : diskContent !== null;
      // 防覆盖保护：目标已存在但未显式授权覆盖时，统一返回中性提示（不暂存、不写盘、不报错）。
      // 无论手动/自动模式，不带 overwrite=true 就不允许覆盖——AI 应先问用户再决定。
      // 这样不会出现「先暗中暂存覆盖、再让用户确认」的暧昧流程。
      if (existsOnDisk && args.overwrite !== true) {
        const lineCount = preEditContent.split("\n").length;
        if (meta) { meta.hidden = true; meta.hiddenReason = "文件已存在"; }
        return (
          `文件 ${args.path} 已存在（共 ${lineCount} 行），未做任何改动（这不是错误）。\n` +
          `请先询问用户：要覆盖已有文件，还是换一个新文件名？等用户明确回复后再行动。\n` +
          `· 用户说覆盖 → 重新调用 create_file 并传 overwrite=true\n` +
          `· 用户说换名 → 用户给的新文件名调用 create_file\n` +
          `· 不要自己替用户决定`
        );
      }
      try {
        const note = await presentEdit(
          host, meta, args.path, filePath, args.content, preEditContent, diskContent ?? "", !existsOnDisk,
        );
        // 区分新建与覆盖，文案如实反映行为（覆盖是破坏性操作，必须让用户看清）
        const verb = existsOnDisk ? "已覆盖" : "已创建";
        return `${verb}文件 ${args.path}${note ? "\n" + note : ""}`;
      } catch (err) {
        throw new Error(
          `create_file 失败：${args.path}，原因：${(err as Error).message}。` +
          `请确认路径合法（无非法字符）且有写入权限。`
        );
      }
    }
    case "str_replace": {
      if (typeof args.path !== "string" || !args.path.trim()) {
        throw new Error("str_replace 失败：缺少必填参数 path。请提供要修改的文件路径（字符串）。");
      }
      if (typeof args.oldStr !== "string" || args.oldStr.length === 0) {
        throw new Error("str_replace 失败：缺少必填参数 oldStr。请提供要被替换的原始文本，需与文件内容逐字符一致（含空格、缩进、换行）。");
      }
      if (typeof args.newStr !== "string") {
        throw new Error("str_replace 失败：缺少必填参数 newStr。请提供替换后的文本（字符串，可为空串表示删除）。");
      }
      const filePath = await resolveInWorkspaces(args.path, cwd, host, workspaces);
      assertWithinWorkspaces(filePath, cwd, workspaces, "str_replace");
      // 基于"有效内容"做替换（手动模式下基于暂存的最新版本）
      const eff = await host.edits.readEffective(filePath);
      if (!eff.existsOnDisk && !eff.fromPending) {
        throw new Error(`str_replace 失败：文件 ${args.path} 不存在。请先用 read_file 确认路径，或用 create_file 创建。`);
      }
      const content = eff.content;
      // CRLF 归一化：LLM 生成的 oldStr/newStr 通常不含 \r，但文件可能是 CRLF
      // 匹配时统一归一化为 \n，替换后恢复文件原始换行风格
      const hasCRLF = content.includes("\r\n");
      const normalizedContent = hasCRLF ? content.replace(/\r\n/g, "\n") : content;
      const normalizedOldStr = (args.oldStr as string).replace(/\r\n/g, "\n");
      const normalizedNewStr = (args.newStr as string).replace(/\r\n/g, "\n");

      if (!normalizedContent.includes(normalizedOldStr)) {
        // 在文件中找到与 oldStr 第一行最相似的位置，返回该区域实际内容
        const oldLines = normalizedOldStr.split("\n");
        const firstOldLine = oldLines[0].trim();
        const fileLines = normalizedContent.split("\n");
        let bestLine = 0;
        let bestScore = 0;
        if (firstOldLine.length > 5) {
          for (let i = 0; i < fileLines.length; i++) {
            const trimmed = fileLines[i].trim();
            // 简单相似度：共同字符比例
            if (trimmed === firstOldLine) { bestLine = i; bestScore = 1; break; }
            if (trimmed.includes(firstOldLine) || firstOldLine.includes(trimmed)) {
              const score = Math.min(trimmed.length, firstOldLine.length) / Math.max(trimmed.length, firstOldLine.length);
              if (score > bestScore) { bestScore = score; bestLine = i; }
            }
          }
        }
        // 返回匹配位置附近的实际内容（上下各 10 行的窗口）
        const contextStart = Math.max(0, bestLine - 5);
        const contextEnd = Math.min(fileLines.length, bestLine + oldLines.length + 10);
        const nearby = fileLines.slice(contextStart, contextEnd).join("\n");
        const totalLines = fileLines.length;
        throw new Error(
          `str_replace 失败：在 ${args.path} 中未找到 oldStr（共 ${totalLines} 行）。` +
          `最可能的位置在第 ${contextStart + 1}-${contextEnd} 行附近，实际内容如下：\n` +
          `\`\`\`\n${nearby}\n\`\`\`\n` +
          `请基于以上实际内容重新确定准确的 oldStr 后重试。注意空格、缩进和换行必须完全匹配。`
        );
      }
      // 检查 oldStr 是否唯一，避免误替换
      const firstIdx = normalizedContent.indexOf(normalizedOldStr);
      const lastIdx = normalizedContent.lastIndexOf(normalizedOldStr);
      if (firstIdx !== lastIdx) {
        throw new Error(
          `str_replace 失败：oldStr 在 ${args.path} 中出现多次（不唯一），无法确定替换位置。` +
          `请在 oldStr 中包含更多上下文（前后多取几行）使其唯一后再重试。`
        );
      }
      // 在归一化内容上替换，然后恢复文件原始换行风格
      const normalizedNewContent = normalizedContent.replace(normalizedOldStr, normalizedNewStr);
      let newContent = normalizedNewContent;
      if (hasCRLF) {
        newContent = newContent.replace(/\n/g, "\r\n");
      }
      // 撤销锚点：newStr 落地后起点 = oldStr 原起点（firstIdx，前缀不变），基于归一化新内容取上下文指纹。
      // 全程用归一化(\n)文本，与撤销引擎 reverseApplyHunks 的匹配口径一致。
      const { beforeContext, afterContext } = computeAnchorContext(normalizedNewContent, firstIdx, normalizedNewStr.length);
      const strReplaceHunk: EditHunk = {
        oldStr: normalizedOldStr,
        newStr: normalizedNewStr,
        beforeContext,
        afterContext,
      };
      // diff 基准用"本次编辑前的有效内容"（content），只展示本次改动；
      // 回滚基准用最初磁盘原始内容（present 实现会在已有暂存时沿用首次的基准）。
      const diskContent = await host.fs.read(filePath);
      const rollbackOriginal = diskContent ?? content;
      const note = await presentEdit(
        host, meta, args.path, filePath, newContent, content, rollbackOriginal, !eff.existsOnDisk, [strReplaceHunk],
      );
      return `已替换 ${args.path} 中的文本${note ? "\n" + note : ""}`;
    }
    case "apply_patch": {
      if (typeof args.patch !== "string" || !args.patch.trim()) {
        throw new Error("apply_patch 失败：缺少必填参数 patch（补丁文本，*** Begin Patch ... *** End Patch 格式）。");
      }
      let ops;
      try {
        ops = parsePatch(args.patch);
      } catch (err) {
        throw new Error((err as Error).message);
      }
      const changed: string[] = [];
      try {
        for (const op of ops) {
          const filePath = await resolveInWorkspaces(op.path, cwd, host, workspaces);
          assertWithinWorkspaces(filePath, cwd, workspaces, "apply_patch");
          const eff = await host.edits.readEffective(filePath);
          const diskContent = await host.fs.read(filePath);

          if (op.type === "add") {
            if (eff.existsOnDisk || eff.fromPending) {
              throw new Error(`apply_patch 失败：Add File 目标 ${op.path} 已存在。要改已有文件请用 *** Update File，整文件重写用 create_file(overwrite=true)。`);
            }
            const content = op.addLines.join("\n");
            await presentEdit(host, meta, op.path, filePath, content, "", diskContent ?? "", true);
            changed.push(op.path);
            continue;
          }

          // update
          if (!eff.existsOnDisk && !eff.fromPending) {
            throw new Error(`apply_patch 失败：Update File 目标 ${op.path} 不存在。请先 read_file 确认路径，或用 *** Add File 新建。`);
          }
          const before = eff.content;
          const collectedHunks: EditHunk[] = [];
          const after = applyHunks(before, op.hunks, op.path, collectedHunks);
          if (after === before) continue; // 无实际改动
          await presentEdit(host, meta, op.path, filePath, after, before, diskContent ?? before, !eff.existsOnDisk, collectedHunks);
          changed.push(op.path);
        }
      } catch (err) {
        // PatchError / 业务错误：原样反馈给模型（含定位提示），让它修正后重试
        if (err instanceof PatchError) throw new Error(err.message);
        throw err;
      }
      if (changed.length === 0) return "apply_patch：补丁未产生任何改动（内容已是目标状态）。";
      return `已应用补丁，修改 ${changed.length} 个文件：${changed.join("、")}`;
    }
    case "execute_command": {
      // 命令在用户可见的 "Axon" 终端里执行（可交互输入），用 Shell Integration 捕获输出。
      // 解析 cwd 参数：支持相对路径或绝对路径，不传时从命令文本智能推断工作区
      let execCwd: string;
      if (typeof args.cwd === "string" && args.cwd.trim()) {
        execCwd = await resolveInWorkspaces(args.cwd, cwd, host, workspaces);
      } else if (workspaces && workspaces.length > 1) {
        // 多工作区：从命令文本中匹配路径推断目标工作区
        const cmd = String(args.command || "");
        const matched = workspaces.find((ws) => cmd.includes(ws) || cmd.includes(ws.replace(/\\/g, "/")));
        execCwd = matched || cwd;
      } else {
        execCwd = cwd;
      }
      // 超时放宽到 120 秒——终端里跑较长命令是正常的；超时不代表失败，命令可能仍在运行。
      const result = await host.commands.exec(args.command as string, {
        cwd: execCwd,
        timeoutMs: 120_000,
        signal,
        onWaitingInput: meta?.onWaitingInput,
      }) as Awaited<ReturnType<typeof host.commands.exec>>;
      // 同步终端实际工作目录（shell integration 返回的真实 cwd）
      if (meta && result.cwd) meta.terminalCwd = result.cwd;
      // 终端层主动取消：通常是 PowerShell 续行/等待输入（引号或括号未闭合）
      if (result.cancelReason === "terminal_stuck_waiting_input") {
        const shellName = process.platform === "win32" ? "PowerShell" : "shell";
        throw new ToolError(
          `命令疑似进入 ${shellName} 续行/等待输入状态，已自动发送 Ctrl+C 取消：${args.command}\n` +
          `常见原因是引号/括号未闭合，或命令过长导致 shell 解析为多行输入。` +
          `不要原样重试；请改用临时脚本文件（${process.platform === "win32" ? ".ps1/.js/.cjs" : ".sh/.js"}）或拆分命令后再执行。`,
          "AI 已获悉错误，它正尝试其他方式继续"
        );
      }
      if (result.cancelReason === "aborted") {
        throw new ToolError(
          `命令已被取消：${args.command}`,
          "命令已被取消"
        );
      }
      // 超时：命令在终端里可能仍在运行（如开发服务器、需要持续交互）
      if (result.timedOut) {
        throw new ToolError(
          `命令在 120 秒内未结束：${args.command}。` +
          `可能是长时间运行的进程（开发服务器/watch）或正在等待用户输入。` +
          `请提示用户切换到终端面板查看并完成操作。不要重试此命令。`,
          "命令超时，AI 已获悉"
        );
      }
      // 非零退出码：组织"命令失败"错误文本
      if (result.exitCode !== 0 && result.exitCode !== null) {
        const output = (result.stdout || "") + (result.stderr || "");
        const platform = process.platform;
        const shellHint = platform === "win32"
          ? `当前环境是 Windows（PowerShell）。如果是语法错误或"找不到命令"，请改用 PowerShell 的正确写法（例如 Get-ChildItem 而非 ls，Get-Content 而非 cat）。`
          : platform === "darwin"
          ? `当前环境是 macOS（zsh/bash）。如果是语法错误或"找不到命令"，请检查命令是否适用于 Unix 环境。`
          : `当前环境是 Linux。如果是语法错误或"找不到命令"，请检查命令拼写和适用性。`;
        throw new ToolError(
          `命令失败（退出码 ${result.exitCode}）：${args.command}\n${output || "(无输出)"}\n${shellHint}`,
          `命令执行失败（退出码 ${result.exitCode}），AI 已获悉并将尝试其他方式`
        );
      }
      return (result.stdout + (result.stderr ? `\n[stderr]\n${result.stderr}` : "")) || "(无输出)";
    }
    case "start_process": {
      if (typeof args.command !== "string" || !args.command.trim()) {
        throw new Error("start_process 失败：缺少必填参数 command（要在后台启动的命令）。");
      }
      if (!host.processes) {
        throw new Error("start_process 失败：当前形态不支持后台进程。请改用 execute_command（注意它会等命令结束，不适合常驻进程）。");
      }
      const procCwd = typeof args.cwd === "string" && args.cwd.trim()
        ? await resolveInWorkspaces(args.cwd, cwd, host, workspaces)
        : cwd;
      const started = await host.processes.start(args.command as string, { cwd: procCwd });
      const reuseNote = started.reused
        ? "（复用了已在运行的相同进程，未重复启动）"
        : "";
      return (
        `已在后台启动：${args.command}${reuseNote}\n` +
        `terminalId: ${started.terminalId}`
      );
    }
    case "get_process_output": {
      if (typeof args.terminalId !== "string" || !args.terminalId.trim()) {
        throw new Error("get_process_output 失败：缺少必填参数 terminalId（start_process 返回的进程句柄）。");
      }
      if (!host.processes) {
        throw new Error("get_process_output 失败：当前形态不支持后台进程。");
      }
      const lines = typeof args.lines === "number" && args.lines > 0 ? args.lines : undefined;
      let out = await host.processes.getOutput(args.terminalId as string, lines);
      if (!out) {
        throw new Error(`get_process_output 失败：找不到进程 ${args.terminalId}。用 list_processes 查看当前有哪些后台进程。`);
      }
      // 输出为空且进程还在运行：等 3 秒再读一次（给进程启动时间，避免模型空转轮询）
      if (!out.output && out.status === "running") {
        await new Promise((r) => setTimeout(r, 3000));
        out = (await host.processes.getOutput(args.terminalId as string, lines)) || out;
      }
      const statusText = out.status === "running"
        ? "运行中"
        : out.status === "exited"
          ? `已退出（exitCode=${out.exitCode ?? "未知"}）`
          : "已停止";
      if (!out.output && out.status === "running") {
        return `进程 ${args.terminalId} 状态：${statusText}\n（进程仍在启动中，暂无输出。不要立即重试——等 5~10 秒后再读，或先做别的事。）`;
      }
      return `进程 ${args.terminalId} 状态：${statusText}\n----- 输出 -----\n${out.output || "(暂无输出)"}`;
    }
    case "stop_process": {
      if (typeof args.terminalId !== "string" || !args.terminalId.trim()) {
        throw new Error("stop_process 失败：缺少必填参数 terminalId（start_process 返回的进程句柄）。");
      }
      if (!host.processes) {
        throw new Error("stop_process 失败：当前形态不支持后台进程。");
      }
      const ok = await host.processes.stop(args.terminalId as string);
      return ok
        ? `已停止后台进程 ${args.terminalId}。`
        : `未找到后台进程 ${args.terminalId}（可能已退出或 id 有误）。用 list_processes 确认。`;
    }
    case "list_processes": {
      if (!host.processes) {
        throw new Error("list_processes 失败：当前形态不支持后台进程。");
      }
      const procs = await host.processes.list();
      if (procs.length === 0) return "当前没有由 start_process 启动的后台进程。";
      const statusLabel = (s: string) => (s === "running" ? "运行中" : s === "exited" ? "已退出" : "已停止");
      return procs
        .map((p) => `- ${p.terminalId} [${statusLabel(p.status)}] ${p.command}  (cwd: ${p.cwd})`)
        .join("\n");
    }
    case "open_browser": {
      if (typeof args.url !== "string" || !/^https?:\/\//i.test(args.url)) {
        throw new Error("open_browser 失败：url 必须是以 http:// 或 https:// 开头的完整地址（如 http://localhost:5173）。");
      }
      if (!host.webBrowser) {
        throw new Error("open_browser 失败：当前形态不支持浏览器能力。");
      }
      try {
        const res = await host.webBrowser.open(args.url as string);
        const reuseNote = res.reused ? "（复用已打开的浏览器）" : "";
        return `已打开：${res.url}${res.title ? `（${res.title}）` : ""}${reuseNote}`;
      } catch (err) {
        throw new Error(`open_browser 失败：${(err as Error).message}`);
      }
    }
    case "get_browser_logs": {
      if (!host.webBrowser) {
        throw new Error("get_browser_logs 失败：当前形态不支持浏览器能力。");
      }
      const clear = args.clear === true;
      const snap = await host.webBrowser.getLogs(clear);
      if (!snap) {
        throw new Error("get_browser_logs 失败：当前没有打开的浏览器。请先用 open_browser 打开页面。");
      }
      const lines: string[] = [`页面：${snap.url}`];
      if (snap.pageErrors.length > 0) {
        lines.push(`\n【未捕获异常 ${snap.pageErrors.length} 条】`);
        for (const e of snap.pageErrors.slice(-20)) lines.push(`✗ ${e.message}${e.stack ? `\n  ${e.stack.split("\n").slice(0, 3).join("\n  ")}` : ""}`);
      }
      if (snap.networkFailures.length > 0) {
        lines.push(`\n【网络失败 ${snap.networkFailures.length} 条】`);
        for (const n of snap.networkFailures.slice(-20)) lines.push(`✗ ${n.method} ${n.status ?? n.failure ?? "失败"} ${n.url}`);
      }
      if (snap.console.length > 0) {
        lines.push(`\n【控制台 ${snap.console.length} 条（最近 30）】`);
        for (const c of snap.console.slice(-30)) lines.push(`[${c.level}] ${c.text}${c.location ? `  (${c.location})` : ""}`);
      }
      if (snap.pageErrors.length === 0 && snap.networkFailures.length === 0 && snap.console.length === 0) {
        lines.push("\n(无控制台日志 / 异常 / 网络失败——页面运行时干净)");
      }
      return lines.join("\n");
    }
    case "screenshot_page": {
      if (!host.webBrowser) {
        throw new Error("screenshot_page 失败：当前形态不支持浏览器能力。");
      }
      const shot = await host.webBrowser.screenshot(args.fullPage === true);
      if (!shot) {
        throw new Error("screenshot_page 失败：当前没有打开的浏览器。请先用 open_browser 打开页面。");
      }
      // 把截图挂到 meta，agent loop 会在工具结果后追加一条带图片的 user 消息喂给多模态模型
      if (meta) meta.screenshotDataUrl = shot.dataUrl;
      return "已截图。页面渲染效果见随后附带的图片。";
    }
    case "close_browser": {
      if (!host.webBrowser) {
        throw new Error("close_browser 失败：当前形态不支持浏览器能力。");
      }
      const ok = await host.webBrowser.close();
      return ok ? "已关闭浏览器。" : "当前没有打开的浏览器。";
    }
    case "browser_click": {
      if (!host.webBrowser || !host.webBrowser.isOpen()) throw new Error("browser_click 失败：浏览器未打开。请先 open_browser。");
      if (typeof args.selector !== "string" || !args.selector.trim()) throw new Error("browser_click 失败：缺少 selector 参数。");
      try {
        await host.webBrowser.click(args.selector as string);
        return `已点击：${args.selector}`;
      } catch (err) {
        throw new Error(`browser_click 失败（selector="${args.selector}"）：${(err as Error).message}。请检查选择器是否正确，或先 screenshot_page 看页面当前状态。`);
      }
    }
    case "browser_type": {
      if (!host.webBrowser || !host.webBrowser.isOpen()) throw new Error("browser_type 失败：浏览器未打开。");
      if (typeof args.selector !== "string" || !args.selector.trim()) throw new Error("browser_type 失败：缺少 selector 参数。");
      if (typeof args.text !== "string") throw new Error("browser_type 失败：缺少 text 参数。");
      try {
        await host.webBrowser.fill(args.selector as string, args.text as string);
        return `已在 ${args.selector} 输入：${(args.text as string).length > 50 ? (args.text as string).slice(0, 50) + "..." : args.text}`;
      } catch (err) {
        throw new Error(`browser_type 失败（selector="${args.selector}"）：${(err as Error).message}。确认元素是 input/textarea，或先 screenshot_page 查看。`);
      }
    }
    case "browser_press": {
      if (!host.webBrowser || !host.webBrowser.isOpen()) throw new Error("browser_press 失败：浏览器未打开。");
      if (typeof args.key !== "string" || !args.key.trim()) throw new Error("browser_press 失败：缺少 key 参数。");
      try {
        await host.webBrowser.press(args.key as string);
        return `已按下：${args.key}`;
      } catch (err) {
        throw new Error(`browser_press 失败：${(err as Error).message}`);
      }
    }
    case "browser_select": {
      if (!host.webBrowser || !host.webBrowser.isOpen()) throw new Error("browser_select 失败：浏览器未打开。");
      if (typeof args.selector !== "string" || !args.selector.trim()) throw new Error("browser_select 失败：缺少 selector 参数。");
      if (typeof args.value !== "string") throw new Error("browser_select 失败：缺少 value 参数。");
      try {
        await host.webBrowser.select(args.selector as string, args.value as string);
        return `已选择 ${args.selector} → ${args.value}`;
      } catch (err) {
        throw new Error(`browser_select 失败：${(err as Error).message}`);
      }
    }
    case "browser_scroll": {
      if (!host.webBrowser || !host.webBrowser.isOpen()) throw new Error("browser_scroll 失败：浏览器未打开。");
      const dir = args.direction as string;
      if (!["up", "down", "top", "bottom"].includes(dir)) throw new Error("browser_scroll 失败：direction 必须是 up/down/top/bottom。");
      await host.webBrowser.scroll(dir as "up" | "down" | "top" | "bottom");
      return `已滚动：${dir}`;
    }
    case "browser_reload": {
      if (!host.webBrowser || !host.webBrowser.isOpen()) throw new Error("browser_reload 失败：浏览器未打开。");
      await host.webBrowser.reload();
      return "已刷新页面。";
    }
    case "get_browser_network": {
      if (!host.webBrowser || !host.webBrowser.isOpen()) throw new Error("get_browser_network 失败：浏览器未打开。请先 open_browser。");
      const filter: import("../host/index.js").NetworkFilter = {};
      if (typeof args.urlContains === "string" && args.urlContains) filter.urlContains = args.urlContains as string;
      if (typeof args.method === "string" && args.method) filter.method = args.method as string;
      if (typeof args.statusMin === "number") filter.statusMin = args.statusMin as number;
      if (typeof args.statusMax === "number") filter.statusMax = args.statusMax as number;
      if (typeof args.resourceType === "string" && args.resourceType) filter.resourceType = args.resourceType as string;
      filter.limit = Math.min(typeof args.limit === "number" ? args.limit : 50, 200);
      const clear = args.clear === true;
      const entries = await host.webBrowser.getNetworkRequests(filter, clear);
      if (!entries) throw new Error("get_browser_network 失败：浏览器未打开。");
      if (entries.length === 0) return "（无匹配的网络请求记录）";
      const lines = [`共 ${entries.length} 条请求：`];
      for (const e of entries) {
        const statusStr = e.status !== null ? String(e.status) : "FAIL";
        const durStr = e.duration !== null ? `${e.duration}ms` : "-";
        const sizeStr = e.size ? `${(e.size / 1024).toFixed(1)}KB` : "-";
        lines.push(`${e.method.padEnd(6)} ${statusStr.padEnd(4)} ${durStr.padEnd(7)} ${sizeStr.padEnd(8)} [${e.resourceType}] ${e.url}${e.failure ? ` (${e.failure})` : ""}`);
      }
      return lines.join("\n");
    }
    case "get_browser_storage": {
      if (!host.webBrowser || !host.webBrowser.isOpen()) throw new Error("get_browser_storage 失败：浏览器未打开。请先 open_browser。");
      const storageType = args.type as "localStorage" | "sessionStorage" | "cookies";
      if (!["localStorage", "sessionStorage", "cookies"].includes(storageType)) {
        throw new Error("get_browser_storage 失败：type 必须是 localStorage / sessionStorage / cookies。");
      }
      const keyFilter = typeof args.keyContains === "string" ? (args.keyContains as string) : undefined;
      const data = await host.webBrowser.getStorage(storageType, keyFilter);
      if (!data) throw new Error("get_browser_storage 失败：浏览器未打开。");
      const keys = Object.keys(data);
      if (keys.length === 0) return `${storageType} 为空${keyFilter ? `（过滤条件："${keyFilter}"）` : ""}。`;
      const lines = [`${storageType}（${keys.length} 条）：`];
      for (const [k, v] of Object.entries(data)) {
        const valPreview = v.length > 200 ? v.slice(0, 200) + "…" : v;
        lines.push(`  ${k} = ${valPreview}`);
      }
      return lines.join("\n");
    }
    case "browser_eval": {
      if (!host.webBrowser || !host.webBrowser.isOpen()) throw new Error("browser_eval 失败：浏览器未打开。");
      if (typeof args.js !== "string" || !args.js.trim()) throw new Error("browser_eval 失败：缺少 js 参数。");
      try {
        const result = await host.webBrowser.evaluate(args.js as string);
        return result ?? "undefined";
      } catch (err) {
        throw new Error(`browser_eval 执行出错：${(err as Error).message}`);
      }
    }
    case "browser_hover": {
      if (!host.webBrowser || !host.webBrowser.isOpen()) throw new Error("browser_hover 失败：浏览器未打开。");
      if (typeof args.selector !== "string" || !args.selector.trim()) throw new Error("browser_hover 失败：缺少 selector。");
      try {
        await host.webBrowser.hover(args.selector as string);
        return `已悬停：${args.selector}`;
      } catch (err) {
        throw new Error(`browser_hover 失败（selector="${args.selector}"）：${(err as Error).message}`);
      }
    }
    case "browser_wait": {
      if (!host.webBrowser || !host.webBrowser.isOpen()) throw new Error("browser_wait 失败：浏览器未打开。");
      const waitSelector = typeof args.selector === "string" ? (args.selector as string) : undefined;
      const waitMs = typeof args.ms === "number" ? (args.ms as number) : undefined;
      if (!waitSelector && !waitMs) throw new Error("browser_wait 失败：至少传 selector 或 ms 之一。");
      try {
        await host.webBrowser.wait(waitSelector, waitMs);
        const desc = [waitSelector ? `元素 "${waitSelector}" 已出现` : "", waitMs ? `等待 ${waitMs}ms` : ""].filter(Boolean).join("，");
        return `已等待完成：${desc}`;
      } catch (err) {
        throw new Error(`browser_wait 超时/失败：${(err as Error).message}`);
      }
    }
    case "browser_get_html": {
      if (!host.webBrowser || !host.webBrowser.isOpen()) throw new Error("browser_get_html 失败：浏览器未打开。");
      const htmlSelector = typeof args.selector === "string" ? (args.selector as string) : undefined;
      const html = await host.webBrowser.getHtml(htmlSelector);
      if (html === null) return htmlSelector ? `未找到元素：${htmlSelector}` : "无法读取页面 HTML。";
      // 截断过长的 HTML（避免爆 token）
      const maxLen = 8000;
      return html.length > maxLen ? html.slice(0, maxLen) + `\n\n[HTML 已截断，原始长度 ${html.length} 字符]` : html;
    }
    case "browser_set_viewport": {
      if (!host.webBrowser || !host.webBrowser.isOpen()) throw new Error("browser_set_viewport 失败：浏览器未打开。");
      const w = typeof args.width === "number" ? args.width : 0;
      const h = typeof args.height === "number" ? args.height : 0;
      if (w <= 0 || h <= 0) throw new Error("browser_set_viewport 失败：width 和 height 必须是正整数。");
      await host.webBrowser.setViewport(w, h);
      return `视口已设置为 ${w}×${h}px。`;
    }
    case "browser_back": {
      if (!host.webBrowser || !host.webBrowser.isOpen()) throw new Error("browser_back 失败：浏览器未打开。");
      await host.webBrowser.goBack();
      return "已后退。";
    }
    case "browser_forward": {
      if (!host.webBrowser || !host.webBrowser.isOpen()) throw new Error("browser_forward 失败：浏览器未打开。");
      await host.webBrowser.goForward();
      return "已前进。";
    }
    case "search": {
      const mode = (args.mode as string) || "content";
      if (!args.query) {
        throw new Error("search 需要 query 参数");
      }
      // 未显式指定 path 时，搜索全部工作区（多工作区场景下不能只搜主工作区，否则会漏掉其他工作区的目标）
      const explicitPath = typeof args.path === "string" && args.path.trim() !== "" && args.path.trim() !== ".";
      const allWs = workspaces && workspaces.length > 0 ? workspaces : [cwd];
      // 每个搜索单元：dir=实际遍历目录，root=相对路径基准（所属工作区根，保证返回路径可被 read_file 正确解析）
      let units: { dir: string; root: string }[];
      if (explicitPath) {
        const dir = await resolveInWorkspaces(args.path as string, cwd, host, workspaces);
        units = [{ dir, root: owningWorkspace(dir, allWs) }];
      } else {
        units = allWs.map((ws) => ({ dir: ws, root: ws }));
      }

      const kind = mode === "file" || mode === "dir" ? (mode as "file" | "dir") : null;
      const parts = await Promise.all(
        units.map((u) =>
          kind
            ? searchEntries(u.dir, args.query as string, u.root, kind, host)
            : searchContent(u.dir, args.query as string, u.root, host, args.includePattern as string | undefined),
        ),
      );
      return mergeMultiRootResults(units.map((u) => u.root), parts);
    }
    case "list_dir": {
      // depth 默认 2，最大 3
      let depth = parseInt(String(args.depth ?? 2), 10);
      if (isNaN(depth) || depth < 1) depth = 2;
      if (depth > 3) depth = 3;
      // 未显式指定 path 且为多工作区时，逐个列出每个工作区根目录
      const explicitPath = typeof args.path === "string" && args.path.trim() !== "" && args.path.trim() !== ".";
      if (!explicitPath && workspaces && workspaces.length > 1) {
        const parts = await Promise.all(workspaces.map((ws) => listDir(ws, ws, depth, host)));
        return workspaces.map((ws, i) => `【工作区: ${ws}】\n${parts[i]}`).join("\n\n");
      }
      const targetPath = await resolveInWorkspaces(args.path || ".", cwd, host, workspaces);
      return await listDir(targetPath, cwd, depth, host);
    }
    case "check_diagnostics": {
      const paths = Array.isArray(args.paths) ? (args.paths as string[]) : [];
      // 手动模式下，若被检查的文件有未落盘的待确认改动，提醒 AI 诊断基于磁盘旧内容
      let pendingNote = "";
      if (host.edits.getMode() === "manual" && host.edits.hasPending()) {
        const pendingRel = host.edits.getPendingPaths();
        const overlap = paths.length > 0
          ? paths.filter((p) => pendingRel.some((pr) => pr === p || pr.endsWith("/" + p) || p.endsWith("/" + pr)))
          : pendingRel;
        if (overlap.length > 0) {
          pendingNote = `\n\n（注意：${overlap.join("、")} 有尚未确认落盘的改动，本次诊断基于磁盘上的旧内容，可能不反映你的最新改动。待用户接受改动后再诊断可得到准确结果。）`;
        }
      }
      // 把请求的相对路径 resolve 成绝对路径交给 host.diagnostics（host 内部转回相对路径展示）
      const absPaths = paths.map((p) => resolve(cwd, p));
      const results = await host.diagnostics.check(cwd, absPaths);
      // 结构化结果写入 meta.diagnostics 供前端折叠展示
      if (meta) {
        meta.diagnostics = results.map((r) => ({ path: r.path, ok: r.ok, errorCount: r.errorCount }));
      }
      const diagResult = formatDiagnostics(results);
      // 强制引导：有错误时在结果开头加一句醒目的指令，防止模型忽略
      const hasAnyError = results.some((r) => !r.ok);
      const forceHint = hasAnyError
        ? "⚠️ 语法/类型检查发现错误（见下方）。你必须立即修复这些问题，不要把有错误的代码交给用户。如果所有文件都已修好，再次调用 check_diagnostics 确认无错后再回复。\n\n"
        : "";
      return forceHint + diagResult + pendingNote;
    }
    case "web_search": {
      const query = (args.query as string || "").trim();
      if (!query) throw new Error("web_search 失败：query 不能为空");
      if (!web) throw new Error("web 能力未启用");
      const response = await web.search(query);
      if (response.results.length === 0) {
        return `搜索 "${query}" 无结果。`;
      }
      // 格式化为 AI 友好的文本（对齐 Kiro 的 web search 结果格式）
      const formatted = response.results.map((r: any, i: number) => {
        const datePart = r.date ? ` (${r.date})` : "";
        return `[${i + 1}] ${r.title}\n    ${r.domain}${datePart}\n    ${r.url}\n    ${r.snippet}`;
      }).join("\n\n");
      // 同时把结构化数据存入 meta 供前端展示
      if (meta) {
        (meta as any).searchResults = {
          query: response.query,
          source: response.source,
          results: response.results,
        };
      }
      return `搜索 "${query}" 返回 ${response.results.length} 条结果（来源：${response.source}）：\n\n${formatted}`;
    }
    case "web_fetch": {
      const url = (args.url as string || "").trim();
      if (!url) throw new Error("web_fetch 失败：url 不能为空");
      if (!url.startsWith("http://") && !url.startsWith("https://")) {
        throw new Error("web_fetch 失败：url 必须以 http:// 或 https:// 开头");
      }
      if (!web) throw new Error("web 能力未启用");
      try {
        const result = await web.fetch(url);
        // 存入 meta 供前端卡片展示
        if (meta) {
          (meta as any).fetchResult = { url, title: result.title, byteSize: result.byteSize, success: true };
        }
        if (!result.content || result.content.length < 50) {
          return `抓取 ${url} 完成，但未获取到有效正文内容（${result.byteSize} 字节原始数据）。该页面可能是 JS 渲染的 SPA，建议通过 web_search 查找替代信息源。`;
        }
        return `抓取 ${url} 完成（${result.byteSize} 字节）：\n\n标题：${result.title}\n\n${result.content}`;
      } catch (err) {
        if (meta) {
          (meta as any).fetchResult = { url, title: "", byteSize: 0, success: false, error: (err as Error).message };
        }
        throw err;
      }
    }
    case "use_skill": {
      const skillName = (args.name as string || "").trim();
      if (!skillName) throw new Error("use_skill 失败：name 不能为空");
      if (!skillLoader) throw new Error("use_skill 失败：当前环境未启用 skill 加载");
      const skill = await skillLoader(skillName);
      if (!skill) {
        throw new Error(`use_skill 失败：未找到 skill "${skillName}"。请确认名称来自系统提示中列出的可用技能。`);
      }
      // 把 skill 名称记到 meta，供前端渲染独立的 skill 卡片
      if (meta) (meta as Record<string, unknown>).skillUsed = skill.name;
      return (
        `[技能已加载：${skill.name}，目录：${skill.dir}]\n` +
        `（这是给你的内部执行说明，不要向用户复述、不要宣布"已加载技能"或"现在开始执行"之类的话，直接按说明开始做事即可）\n\n${skill.body}`
      );
    }
    case "activate_power": {
      const powerName = (args.name as string || "").trim();
      if (!powerName) throw new Error("activate_power 失败：name 不能为空");
      if (!powerLoader) throw new Error("activate_power 失败：当前环境未启用 Power 加载");
      const power = await powerLoader(powerName);
      if (!power) {
        throw new Error(`activate_power 失败：未找到 Power "${powerName}"。请确认名称来自系统提示中列出的可用 Power。`);
      }
      // 存入 meta 供前端渲染 Power 卡片
      if (meta) {
        (meta as any).powerActivated = {
          name: power.name,
          displayName: power.displayName,
          mcpServerCount: power.mcpServerCount,
          skillCount: power.skillCount,
          keywords: power.keywords,
        };
      }
      // 组装返回给 AI 的信息
      const sections: string[] = [];
      sections.push(`[Power 已激活：${power.displayName || power.name}]`);
      if (power.body) {
        sections.push(`\n## 文档\n${power.body}`);
      }
      if (power.skills.length > 0) {
        const skillList = power.skills.map((s) => `- ${s.name}：${s.description}`).join("\n");
        sections.push(`\n## 捆绑的 Skills（可用 use_skill 加载）\n${skillList}`);
      }
      if (Object.keys(power.mcpServers).length > 0) {
        const mcpList = Object.entries(power.mcpServers).map(([k, v]) => `- ${k}：${v.command} ${(v.args || []).join(" ")}`).join("\n");
        sections.push(`\n## MCP 服务器\n${mcpList}`);
      }
      if (power.steeringFiles.length > 0) {
        sections.push(`\n## 工作流引导文件\n${power.steeringFiles.map((f) => `- ${f}`).join("\n")}`);
      }
      return sections.join("\n");
    }
    default:
      throw new Error(`未知工具: ${name}。${suggestTool(name)}`);
  }
}

/**
 * 所有 execute.ts 支持的工具名集合（供 suggestTool 模糊匹配用）
 */
const ALL_TOOL_NAMES = [
  "read_file", "create_file", "str_replace", "apply_patch",
  "execute_command", "start_process", "get_process_output", "stop_process", "list_processes",
  "open_browser", "get_browser_logs", "screenshot_page", "close_browser",
  "browser_click", "browser_type", "browser_press", "browser_select",
  "browser_scroll", "browser_reload", "browser_back", "browser_forward",
  "get_browser_network", "get_browser_storage", "browser_eval",
  "browser_hover", "browser_wait", "browser_get_html", "browser_set_viewport",
  "search", "list_dir", "check_diagnostics", "web_search", "web_fetch",
  "use_skill", "activate_power",
];

/** 计算两个字符串的编辑距离（Levenshtein），下限 0 */
function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp: number[] = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const temp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(dp[j], dp[j - 1], prev);
      prev = temp;
    }
  }
  return dp[n];
}

/** 模糊匹配：在所有已知工具中找编辑距离最小的，若 ≤3 则给出友好提示 */
function suggestTool(name: string): string {
  const lower = name.toLowerCase();

  // 关键词快速匹配：处理常见 AI 变体
  const keywords: [string[], string][] = [
    [["replace", "str_replace", "replace_in", "replacein"], "str_replace"],
    [["read", "readfile", "read_file", "cat", "open"], "read_file"],
    [["create", "write", "new", "make", "createfile", "create_file", "new_file"], "create_file"],
    [["patch", "apply_patch", "applypatch", "diff"], "apply_patch"],
    [["exec", "execute", "run", "cmd", "command", "shell", "terminal"], "execute_command"],
    [["start", "spawn", "launch", "background", "daemon"], "start_process"],
    [["browser", "web"], "open_browser"],
    [["click"], "browser_click"],
    [["type", "input", "fill"], "browser_type"],
    [["screenshot", "capture", "snap"], "screenshot_page"],
    [["search", "find", "grep", "lookup"], "search"],
    [["list", "ls", "dir", "lsdir", "listdir"], "list_dir"],
    [["diagnostic", "check", "lint", "tsc", "typecheck"], "check_diagnostics"],
    [["websearch", "web_search", "google", "internet"], "web_search"],
    [["fetch", "download", "curl", "wget"], "web_fetch"],
  ];

  for (const [aliases, tool] of keywords) {
    if (aliases.some((a) => lower === a || lower.includes(a) || a.includes(lower))) {
      return `你应该使用的是 "${tool}" 吗？请使用精确的工具名称，不要自己编造。`;
    }
  }

  // 编辑距离兜底
  let best = "";
  let bestDist = Infinity;
  for (const tool of ALL_TOOL_NAMES) {
    const dist = levenshtein(lower, tool);
    if (dist < bestDist) { bestDist = dist; best = tool; }
  }
  if (bestDist <= 3 && best) return `你是否想用 "${best}"？请使用精确的工具名称，不要自己编造。`;
  return `可用工具：${ALL_TOOL_NAMES.join("、")}。请只使用以上名称，不要自己编造。`;
}

/**
 * 把 host.diagnostics 的结构化结果格式化为模型可见的文本。
 * 对齐原 checkDiagnostics 的文本拼装：每个文件 "✓ 无错误" 或 "✗ N 个错误" + 明细。
 */
function formatDiagnostics(results: DiagnosticFileResult[]): string {
  const textParts: string[] = [];
  for (const r of results) {
    if (r.ok && r.errorCount === 0) {
      textParts.push(`✓ ${r.path}: 无错误`);
    } else {
      const errLines = r.details
        ? r.details.split("\n").map((e) => "  - " + e).join("\n")
        : "";
      textParts.push(`✗ ${r.path}: ${r.errorCount} 个错误${errLines ? "\n" + errLines : ""}`);
    }
  }
  return textParts.join("\n\n");
}

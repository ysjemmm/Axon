/**
 * useCoworkSession —— Cowork 面板的轻量会话层
 *
 * 为什么不复用 useChatSession：那个 hook 有 900+ 行，承载打字机、工具卡片队列、
 * Relay、快照、命令审批、压缩迁移等等 —— 全部是围绕"开发者看得懂工具调用"这个
 * 前提设计的。Cowork 的用户是会计和做报表的人，界面上不该出现 read_file、
 * execute_command 这类东西。复用它就等于把开发概念搬进办公界面，再花更多力气去藏。
 *
 * 所以这里只订阅办公场景真正需要的事件，并把它们翻译成人话：
 *   · tool_call  → 「正在读取 账目.xlsx」这类进展描述（不暴露工具名与参数）
 *   · stream_*   → 最终回复正文
 *   · token_usage→ 上下文用量（喂给圆环）
 *   · error 类   → 一句用户能看懂的失败说明
 *
 * 复用的部分：底层协议（user_message 指令 + AGENT_EVENT 事件）、事件总线按 clientId
 * 的路由、以及后端的 agent 模式。后端 `cmd.mode === "quest" ? "quest" : "agent"`
 * 会把任何非 quest 值归一化成 agent，因此 Cowork 不需要新增后端模式 ——
 * 它的差异化靠 document-forge Power（按关键词自动激活）和任务描述本身达成。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useSessionEvents } from "@/hooks/useSessionEvents";
import type { WsMessage } from "@/hooks/useWebSocket";
import { resolveModel, shouldEnableThinking } from "@/components/chat/useModelEffort";
import { AGENT_EVENT, CONTROL_CMD, TOOL } from "@/lib/constants";
import { describeIntent, describeStatusPhase, describeToolPhase, isScriptFile } from "./taskIntent";
import { restoreOutputs, type HistoryMessage, type OutputFile } from "./restoreOutputs";

/** 一条任务的生命周期状态 */
export type CoworkTaskStatus = "running" | "done" | "failed" | "cancelled";

export interface CoworkTask {
  id: string;
  /** 用户输入的任务描述 */
  request: string;
  /** 参与本次任务的文件名（仅展示用） */
  fileNames: string[];
  /**
   * 参与本次任务的文件绝对路径（与 fileNames 一一对应）。
   * 有路径才能点开预览；历史还原的任务也带着它，所以刷新后附件依然可点。
   */
  filePaths: string[];
  status: CoworkTaskStatus;
  /**
   * 本轮意图摘要，如「核对差异」。发起时识别一次，整轮不变 ——
   * 它回答"这一轮的目标是什么"，和实时变化的 phase 各管一段。
   */
  intent: string;
  /**
   * intent 是否已被模型生成的文案替换过。
   *
   * 用途是防回退：规则文案在发送瞬间就位（保证不空白），模型文案随后到达替换它。
   * 没有这个标记的话，后续任何一条 status 事件都可能把更好的文案盖回规则版本。
   */
  intentGenerated: boolean;
  /** 当前阶段短语，如「读取 账目.xlsx」。跟着工具调用实时变。 */
  phase: string;
  /** 任务发起时刻（毫秒），用于算耗时 */
  startedAt: number;
  /** 终态耗时（毫秒）。done/failed 后不再走定时器，用这个定格显示。 */
  elapsedMs?: number;
  /**
   * 本轮实际碰过的文件名（去重，按首次出现排序）。
   * 读到/生成了什么是办公用户最关心的事实，比"调了几次工具"有用得多。
   */
  touchedFiles: string[];
  /** 本轮产出：类型由 AI 登记，旧数据无类型时不猜测 */
  outputs: OutputFile[];
  /** Agent 的最终回复正文（流式累积） */
  reply: string;
  /** 失败原因 */
  error?: string;
}

/** 一次任务提交的完整参数（排队时原样存起来，出队时照原样发） */
export interface CoworkSubmitParams {
  request: string;
  files: { path: string; name: string }[];
  model: string;
  provider?: string;
  effort: string | null;
  outputDir: string;
}

/** 排队中的任务 */
export interface QueuedTask {
  id: string;
  params: CoworkSubmitParams;
}

interface UseCoworkSessionOptions {
  /** 面板标识，用作事件总线路由键；与 Chat 侧的 tab key 同级但独立 */
  clientId: string;
  connected: boolean;
  send: (cmd: Record<string, unknown>) => void;
}

export function useCoworkSession({ clientId, connected, send }: UseCoworkSessionOptions) {
  const [tasks, setTasks] = useState<CoworkTask[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [tokenUsage, setTokenUsage] = useState<{ used: number; max: number }>({ used: 0, max: 0 });
  /** 正在加载历史会话：从点击到 session_loaded 到达之间，界面要有反馈 */
  const [loadingHistory, setLoadingHistory] = useState(false);
  /** 排队中的任务：AI 还在跑时提交的任务排在这里，本轮结束后自动依次发出 */
  const [queue, setQueue] = useState<QueuedTask[]>([]);

  /** 当前进行中的任务 id。流式事件不带任务标识，靠它归属到正确的任务上。 */
  const activeTaskRef = useRef<string | null>(null);
  /** 用户主动取消：用于区分「取消」与「真的出错」，两者的收尾事件形态相同 */
  const cancelledRef = useRef(false);

  /** 开启独立 Cowork 会话：不复用旧 sessionId，避免不同办公任务互相污染上下文。 */
  const startNewSession = useCallback(() => {
    if (running) {
      cancelledRef.current = true;
      send({ type: CONTROL_CMD.CANCEL, clientId, sessionId });
    }
    activeTaskRef.current = null;
    cancelledRef.current = false;
    setTasks([]);
    setSessionId(null);
    setRunning(false);
    setTokenUsage({ used: 0, max: 0 });
    // 队列必须清掉：那些任务是针对上一个会话的上下文排的，
    // 留着会在新会话里莫名发出来
    setQueue([]);
  }, [clientId, running, send, sessionId]);

  /**
   * 打开一条历史会话。
   *
   * 走 load_session 让后端把会话读进内存并推 session_loaded，然后把消息还原成
   * 任务卡片。只还原「用户请求 + 最终回复」两件事 —— 工具调用的中间过程对
   * 办公用户没有意义，而且重放进展文案会让界面看起来像在重新跑一遍。
   */
  const openSession = useCallback((targetId: string) => {
    if (running) {
      cancelledRef.current = true;
      send({ type: CONTROL_CMD.CANCEL, clientId, sessionId });
    }
    activeTaskRef.current = null;
    cancelledRef.current = false;
    setTasks([]);
    setRunning(false);
    setTokenUsage({ used: 0, max: 0 });
    // 同 startNewSession：排队的任务属于上一个会话，不能带到新打开的会话里
    setQueue([]);
    setSessionId(targetId);
    setLoadingHistory(true);
    send({ type: "load_session", clientId, sessionId: targetId });
  }, [clientId, running, send, sessionId]);

  const patchActive = useCallback((patch: Partial<CoworkTask> | ((t: CoworkTask) => Partial<CoworkTask>)) => {
    const id = activeTaskRef.current;
    if (!id) return;
    setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, ...(typeof patch === "function" ? patch(t) : patch) } : t)));
  }, []);

  /**
   * 收尾：落定状态并解除 running。同一轮可能来多个收尾事件，用 activeTaskRef
   * 是否已清空去重。
   *
   * 耗时在这里定格进 elapsedMs：终态卡片不该再跟着计时器走，但"这个任务花了
   * 多久"是用户回头看历史时会关心的信息，不能抹掉。
   */
  const finishActive = useCallback((status: CoworkTaskStatus, error?: string) => {
    const id = activeTaskRef.current;
    if (!id) return;
    activeTaskRef.current = null;
    setTasks((prev) => prev.map((t) => (t.id === id
      ? { ...t, status, phase: "", elapsedMs: Date.now() - t.startedAt, ...(error ? { error } : {}) }
      : t)));
    setRunning(false);
  }, []);

  useSessionEvents(clientId, (msg: WsMessage) => {
    switch (msg.type) {
      case AGENT_EVENT.SESSION_CREATED:
        setSessionId((msg as { sessionId?: string }).sessionId || null);
        return;

      // 历史会话加载完成：把消息还原成任务卡片。
      //
      // 只取 user 的请求与 assistant 的最终回复，不还原工具调用过程 ——
      // 办公用户不需要看 read_file / execute_command，而且重放进展文案会让
      // 界面看起来像在重新跑一遍任务。
      case AGENT_EVENT.SESSION_LOADED: {
        const history = (msg as { messages?: unknown[] }).messages || [];
        const restored: CoworkTask[] = [];
        let turnMessages: HistoryMessage[] = [];
        let index = 0;
        for (const raw of history) {
          const m = raw as {
            role?: string;
            content?: unknown;
            displayText?: string;
            attachedFiles?: { name: string; path?: string }[];
          };
          if (m.role === "user") {
            const previous = restored[restored.length - 1];
            if (previous) previous.outputs = restoreOutputs(turnMessages);
            turnMessages = [];
            // displayText 是用户真正打的字；content 里还夹着文件路径清单和产出目录提示
            const text = typeof m.displayText === "string" && m.displayText
              ? m.displayText
              : (typeof m.content === "string" ? m.content : "");
            const attached = m.attachedFiles || [];
            restored.push({
              id: `history-${index++}`,
              request: text,
              fileNames: attached.map((f) => f.name),
              // 老会话（本次修复之前存的）没有 path，用空串占位：
              // 下游据此判断该卡片不可点，而不是给一个点了没反应的卡片。
              filePaths: attached.map((f) => f.path || ""),
              status: "done",
              intent: describeIntent(text, attached.map((f) => f.name)),
              // 历史还原用规则文案：生成的文案没落盘，重算一次不值得（要为每条
              // 历史消息各打一次模型请求），而规则版本已经够用。
              intentGenerated: false,
              phase: "",
              startedAt: 0,
              touchedFiles: [],
              outputs: [],
              reply: "",
            });
          } else if (m.role === "assistant" && typeof m.content === "string" && m.content.trim()) {
            // 回复并入最近一条任务；没有对应任务（历史异常）时丢弃，不凭空造卡片
            const last = restored[restored.length - 1];
            if (last) last.reply = last.reply ? `${last.reply}\n\n${m.content}` : m.content;
          }
          if (restored.length > 0) turnMessages.push(m as HistoryMessage);
        }
        const last = restored[restored.length - 1];
        if (last) last.outputs = restoreOutputs(turnMessages);
        setTasks(restored);
        setLoadingHistory(false);
        const total = (msg as { totalTokens?: number }).totalTokens;
        if (typeof total === "number" && total > 0) {
          setTokenUsage((prev) => ({ ...prev, used: total }));
        }
        return;
      }

      // ── 进展：工具调用翻译成阶段短语，并记录碰过/产出的文件 ──
      case AGENT_EVENT.TOOL_CALL: {
        const m = msg as { name?: string; args?: unknown };
        const name = m.name || "";
        const args = (m.args || {}) as Record<string, unknown>;
        const rawPath = typeof args.path === "string" ? args.path : "";
        const base = rawPath ? rawPath.replace(/\\/g, "/").split("/").filter(Boolean).pop() || "" : "";
        // create_file 收集的产出只作【后备】：权威清单由 Agent 调 report_outputs 登记
        // （cowork_outputs 事件会整体覆盖这里）。保留后备是因为模型未必每次都想起来调。
        // 排除脚本类扩展名 —— 办公任务里 .py/.js 是干活的工具而不是给用户的结果，
        // 把临时脚本列成产出比不列更糟（用户以为那就是成果）。
        const isOutput = name === TOOL.CREATE_FILE && !!rawPath && !isScriptFile(base);
        // 临时脚本不计入"参与的文件"：Agent 为了处理 Excel 会写几个 .py，
        // 把它们数进去就出现了「6 个文件」却一个产出都看不到的割裂感 ——
        // 用户心里的"文件"是自己的表格和文档，不是我们干活的工具。
        const countable = base && !isScriptFile(base);
        patchActive((t) => ({
          phase: describeToolPhase(name, m.args),
          touchedFiles: countable && !t.touchedFiles.includes(base) ? [...t.touchedFiles, base] : t.touchedFiles,
          outputs: isOutput && !t.outputs.some((file) => file.path === rawPath)
            ? [...t.outputs, { path: rawPath }]
            : t.outputs,
        }));
        return;
      }

      // status 有两种来源，处理方式不同：
      //
      // ① humanized=true —— 后端用当前模型为这一轮即时生成的办公化文案。
      //    信息量最高，直接采用：phase=thinking 时它描述的是整轮意图（替换 intent），
      //    否则描述的是当前这一步（替换 phase）。
      // ② 普通 status —— 面向 Chat 的通用文案（"思考中..."）。归一化成阶段短语后
      //    才用，且不准覆盖已经生成好的意图，否则好文案会被通用文案盖回去。
      case AGENT_EVENT.STATUS: {
        const m = msg as { content?: string; phase?: string; humanized?: boolean };
        const content = m.content || "";
        if (m.humanized && content) {
          patchActive({ phase: content });
          return;
        }
        const phase = describeStatusPhase(content);
        if (phase) patchActive({ phase });
        return;
      }

      // ── 最终回复正文 ──
      case AGENT_EVENT.STREAM_START:
        // 一轮里可能多次 stream_start（工具轮之间穿插正文）。不清空已有内容，
        // 否则用户会看到前半段回复凭空消失。为相邻模型回合补上 Markdown 段落边界；
        // delta 是任意文本切片，不能逐片添加分隔符。
        patchActive((t) => ({
          phase: "整理结果",
          reply: t.reply.trim() ? `${t.reply.trimEnd()}\n\n` : t.reply,
        }));
        return;
      case AGENT_EVENT.STREAM_DELTA: {
        const delta = (msg as { content?: string }).content || "";
        if (delta) patchActive((t) => ({ reply: t.reply + delta }));
        return;
      }
      case AGENT_EVENT.STREAM_END:
        // stream_end 就是整轮结束的信号（与 Chat 侧一致：它在这里落终态）。
        // 工具轮不发 stream_start/end，所以收到它即代表 Agent 已说完最后一段话。
        finishActive(cancelledRef.current ? "cancelled" : "done");
        cancelledRef.current = false;
        return;

      // ── 本轮产出的文件 ──
      // AI 登记的产出经后端校验后覆盖按工具调用推测的清单；
      // 文件类型由 AI 声明，缺失时保持中性，不按扩展名猜测。
      case AGENT_EVENT.COWORK_OUTPUTS: {
        const { paths, files } = msg as { paths?: string[]; files?: OutputFile[] };
        if (Array.isArray(files) && files.length > 0) {
          patchActive({ outputs: files });
        } else if (Array.isArray(paths) && paths.length > 0) {
          patchActive({ outputs: paths.map((path) => ({ path })) });
        }
        return;
      }

      // ── 上下文用量 ──
      case AGENT_EVENT.TOKEN_USAGE: {
        const m = msg as { used?: number; max?: number };
        setTokenUsage((prev) => ({
          used: typeof m.used === "number" ? m.used : prev.used,
          max: typeof m.max === "number" && m.max > 0 ? m.max : prev.max,
        }));
        return;
      }

      // Cowork 不展示开发者审批卡片。涉及 Relay / MCP 等开发者操作时安全拒绝，
      // 避免 Agent 永久等待一个办公用户看不懂的确认框。
      case AGENT_EVENT.CONFIRM_TOOL_REQUEST:
        send({ type: "confirm_tool", clientId, confirmed: false });
        patchActive({ phase: "调整处理方式" });
        return;

      // 文档处理过程中如果 Agent 需要用户在选项中作答，采用协议提供的
      // “跳过，让你自己决定”，让任务继续；必要时 Agent 会在最终回复里说明假设。
      case AGENT_EVENT.ASK_USER_REQUEST: {
        const m = msg as { toolCallId?: string; questions?: unknown[] };
        if (m.toolCallId && Array.isArray(m.questions)) {
          send({
            type: "answer_user_question",
            clientId,
            toolCallId: m.toolCallId,
            answers: m.questions.map(() => ({ selected: [], skipped: true })),
          });
        }
        patchActive({ phase: "按文件内容继续" });
        return;
      }

      // 未信任的系统命令一律拒绝。document-forge 的标准流程会把数据处理脚本
      // 作为低层工具执行，但 Cowork 不具备编辑命令的办公化确认界面，不能把风险
      // 命令静默放行；Agent 收到拒绝后会换方案或在结果里说明。
      case AGENT_EVENT.CONFIRM_COMMAND_REQUEST: {
        const m = msg as { requestId?: string };
        if (m.requestId) {
          send({ type: "confirm_command", clientId, requestId: m.requestId, choice: "reject" });
        }
        patchActive({ phase: "调整处理方式" });
        return;
      }

      // ── 收尾 ──
      case AGENT_EVENT.TURN_CANCELLED:
        finishActive(cancelledRef.current ? "cancelled" : "done");
        cancelledRef.current = false;
        return;

      case AGENT_EVENT.ERROR:
      case AGENT_EVENT.SESSION_ERROR: {
        const detail = (msg as { message?: string; error?: string }).message
          || (msg as { error?: string }).error
          || "处理过程中出错了";
        finishActive("failed", detail);
        return;
      }

      default:
        return;
    }
  });

  /**
   * 真正把任务发出去（不做排队判断）。
   *
   * files 传的是【绝对路径】——必须由原生文件对话框提供。浏览器的拖放和
   * <input type="file"> 都拿不到路径，而 Agent 要用 openpyxl / pdfplumber
   * 直接读二进制文件，没有路径就无从下手。
   */
  const sendNow = useCallback((params: CoworkSubmitParams) => {
    const taskId = `cowork-${Date.now()}`;
    const fileNames = params.files.map((f) => f.name);

    setTasks((prev) => [...prev, {
      id: taskId,
      request: params.request,
      fileNames,
      filePaths: params.files.map((f) => f.path),
      status: "running",
      // 意图在发起时识别一次就固定下来：它描述目标，不该跟着阶段抖动。
      // 必须此刻就算出来——等后端第一个事件回来再显示，开头那几秒就又是空白。
      intent: describeIntent(params.request, fileNames),
      intentGenerated: false,
      phase: "",
      startedAt: Date.now(),
      touchedFiles: [],
      outputs: [],
      reply: "",
    }]);
    activeTaskRef.current = taskId;
    cancelledRef.current = false;
    setRunning(true);

    // 组装给 Agent 的消息。
    //
    // 用绝对路径列清单而不是附件：document-forge 的读取流程就是"确认路径 → 转文本 →
    // 读结果"，给路径正好对上。产出目录也写进正文 —— POWER.md 里「用户给了路径就用
    // 用户的」这条规则会消费它，不需要新增协议字段。
    const lines: string[] = [];
    if (params.files.length > 0) {
      lines.push("要处理的文件：");
      for (const f of params.files) lines.push(`- ${f.path}`);
      lines.push("");
    }
    lines.push(params.request);
    lines.push("");
    lines.push("请用 Markdown 分段回答：不同处理阶段各成一段，必要时用小标题或列表，不要把多个回合的内容拼成一长段。简短回答无需刻意加标题。");
    if (params.outputDir) {
      lines.push("");
      lines.push(`产出文件请放到：${params.outputDir}`);
    }
    // 明确要求登记产出。
    //
    // 工具描述里已经写了用法，但模型未必主动想起来调 —— 办公任务的"交付"这一步
    // 对它来说不如写文件本身显眼。在用户消息里点一句，命中率高得多。
    // 这也是产出卡片的唯一数据来源：不登记就什么都不显示。
    lines.push("");
    lines.push("做完后，如果生成或改写了文件，请调用 report_outputs 登记最终产出，并为每个文件标明 kind：本轮新建用 created，修改已有文件用 edited（临时脚本不用登记）。");

    send({
      type: CONTROL_CMD.USER_MESSAGE,
      clientId,
      sessionId,
      content: lines.join("\n"),
      displayText: params.request,
      // 附件清单必须随消息落盘：历史还原时要靠它把文件名显示回来。
      // 早先漏传了这个字段，而还原逻辑却在读 attachedFiles —— 于是刷新后
      // 文件就"消失"了（不是没持久化展示，是压根没存进去）。
      // path 一并存：还原出的卡片要能点开预览，光有文件名做不到。
      ...(params.files.length > 0
        ? { attachedFiles: params.files.map((f) => ({ name: f.name, path: f.path, size: 0 })) }
        : {}),
      model: params.model,
      provider: params.provider,
      // cowork 模式：后端把它的运行时降级为 agent（同一套工具集与系统提示，
      // 处理文档需要读写文件和跑脚本的能力），但落盘时保留 cowork 标记，
      // 这样历史列表能把办公会话和 Code 的开发会话分开列。
      mode: "cowork",
      // 产出目录单独传给后端；正文里的路径供模型决定文件存放位置。
      ...(params.outputDir ? { outputDir: params.outputDir } : {}),
      think: shouldEnableThinking(resolveModel(params.model, params.provider), params.effort),
      ...(params.effort ? { effort: params.effort } : {}),
    });
  }, [clientId, send, sessionId]);

  /**
   * 排队消费的「在途锁」。
   *
   * ⚠️ 不能发完就立刻复位：放行条件看的 running 要等后端首个事件回来才变 true，
   * 「已发出、还没开跑」这段窗口没有任何互斥保护 —— 窗口内 effect 只要重跑一次
   * （队列变更 / connected 抖动），下一条就也被发出去，同一会话并发两轮。
   * 锁只在两种情况释放：① 观察到 running 变 true（真的开跑了）② 兜底超时。
   * 这些都是 Code 侧踩过的坑，照同样的方式防住。
   */
  const consuming = useRef(false);
  const unlockTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sendTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 唯一该清理在途定时器的时机：组件卸载
  useEffect(() => () => {
    if (sendTimer.current) clearTimeout(sendTimer.current);
    if (unlockTimer.current) clearTimeout(unlockTimer.current);
  }, []);

  // 本轮真的开跑了 → 解锁，交给「结束后再发下一条」的正常流程
  useEffect(() => {
    if (!running) return;
    consuming.current = false;
    if (unlockTimer.current) {
      clearTimeout(unlockTimer.current);
      unlockTimer.current = null;
    }
  }, [running]);

  // 出队：上一轮结束且队列非空时，发下一条
  useEffect(() => {
    // 断线时绝不放行：此时 running 可能是被断线逻辑清掉的，不代表本轮已结束
    if (running || !connected) return;
    if (queue.length === 0 || consuming.current) return;

    consuming.current = true;
    const [next, ...rest] = queue;
    setQueue(rest);
    // ⚠️ 这里【不能】返回 cleanup 去 clearTimeout：本 effect 依赖 queue，
    // 上一行 setQueue 立刻换掉它的引用 → effect 重跑 → React 先执行上次的 cleanup，
    // 那个 clearTimeout 恰好把还没到期的定时器掐掉，而新一轮又因 consuming 已置位
    // 直接 return。结果是消息从队列 UI 消失了、却从来没发出去。
    sendTimer.current = setTimeout(() => {
      sendTimer.current = null;
      sendNow(next.params);
      // 兜底解锁：防「后端一个事件都没回」导致队列永久卡死
      unlockTimer.current = setTimeout(() => {
        consuming.current = false;
        unlockTimer.current = null;
      }, 15_000);
    }, 50);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, connected, queue]);

  /**
   * 提交一个任务。
   *
   * 正在跑时不再拒绝，而是排队 —— 用户想到什么就先写下来，不用盯着界面等它结束。
   * 与 Code 侧同一个约定。
   */
  const submit = useCallback((params: CoworkSubmitParams): { ok: true; queued: boolean } | { ok: false; reason: string } => {
    if (!connected) return { ok: false, reason: "还没连上服务，请稍后再试" };
    // 后端对这两个字段是硬校验（缺了直接抛错），前端先挡一次给出人话提示。
    if (!params.model.trim() || !params.provider?.trim()) {
      return { ok: false, reason: "请先选择一个模型" };
    }

    if (running) {
      setQueue((prev) => [...prev, { id: `q-${Date.now()}-${prev.length}`, params }]);
      return { ok: true, queued: true };
    }

    sendNow(params);
    return { ok: true, queued: false };
  }, [connected, running, sendNow]);

  const removeFromQueue = useCallback((id: string) => {
    setQueue((prev) => prev.filter((q) => q.id !== id));
  }, []);

  const cancel = useCallback(() => {
    if (!running) return;
    cancelledRef.current = true;
    send({ type: CONTROL_CMD.CANCEL, clientId, sessionId });
  }, [clientId, running, send, sessionId]);

  return {
    tasks, running, tokenUsage, sessionId, loadingHistory, queue,
    submit, cancel, startNewSession, openSession, removeFromQueue,
  };
}

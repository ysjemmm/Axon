/**
 * CoworkPanel —— 面向办公文档的独立工作面（Cowork 模式）
 *
 * 定位：给会计、做 Excel/PDF/Word、做设计的人用。他们不关心工作区、Provider、
 * 协议、工具调用，所以这一页刻意不出现任何开发概念 —— 只有三件事：
 *   ① 要处理的文件（原生对话框选择）
 *   ② 你想让它做什么（一句话）
 *   ③ 产出放哪（一个看得见的目录）
 *
 * 与 Chat/Code 的关系：共享底层（@axon/core 的 Agent 循环、document-forge 的文档
 * 读写技能），但不复用任何 Chat 侧 UI。这是"第二个产品面"，不是第三种模式。
 *
 * Agent 执行走独立的轻量会话层；文件路径由宿主原生对话框获取。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { CoworkScene } from "@/components/cowork/CoworkScene";
import { ArrowDown, FolderOpen, History, Loader2, Plus, RotateCcw, Send, Square } from "lucide-react";
import { WorkspacePicker } from "@/components/WorkspacePicker";
import { EffortSelector, ModelSelector, normalizeStoredModelId, useModels } from "@/components/ModelSelector";
import { TokenIndicator } from "@/components/chat/TokenIndicator";
import { useModelEffort, resolveEffortForModel, resolveModel } from "@/components/chat/useModelEffort";
import { MentionEditor, type MentionEditorHandle } from "@/components/chat/MentionEditor";
import { AttachmentCard, FileCardBody } from "@/components/chat/AttachmentCard";
import { attachmentTypeLabel } from "@/components/chat/attachmentType";
import { MarkdownRenderer } from "@/components/MarkdownRenderer";
import { useCoworkSession } from "@/components/cowork/useCoworkSession";
import { CoworkHistory } from "@/components/cowork/CoworkHistory";
import { TaskStatusLine } from "@/components/cowork/TaskStatusLine";
import { TaskOutputs } from "@/components/cowork/TaskOutputs";
import { useStickToBottom } from "@/components/cowork/useStickToBottom";
import { useSessionEvents } from "@/hooks/useSessionEvents";
import type { WsMessage } from "@/hooks/useWebSocket";
import { STORAGE, TIMEOUT } from "@/lib/constants";

/**
 * 待处理文件。
 *
 * ⚠️ path 是绝对路径，必须由 VS Code 原生文件对话框提供。
 * webview 里的 <input type="file"> 和拖放都只给 File 对象、拿不到本地路径，
 * 而 Agent 要用 openpyxl / pdfplumber 直接读这些二进制文件，没路径就没法处理。
 * 所以本面板的文件入口只有原生对话框一条路，拖放只作为引导提示。
 */
interface PickedFile {
  id: string;
  name: string;
  /** 绝对路径，交给 Agent 去读 */
  path: string;
  /** 字节数，仅用于展示 */
  size: number;
}

/** 长路径缩略：只留末两级，菜单/标签宽度放不下完整绝对路径 */
function shortenPath(absPath: string): string {
  const parts = absPath.replace(/\\/g, "/").split("/").filter(Boolean);
  if (parts.length <= 2) return absPath;
  return `…/${parts.slice(-2).join("/")}`;
}

/**
 * 空态首发时「输入框从居中落到底部」的动画时长（ms）。
 * CSS 过渡与延后发送的定时器共用这一个值，改动时两边自动同步。
 * 与 Chat 侧的 COMPOSER_LANDING_MS 保持一致，两处观感统一。
 */
const COMPOSER_LANDING_MS = 420;

/** 快捷任务：点一下把起手文案填进输入框，不直接发送 */
const QUICK_TASKS = [
  { id: "summarize", label: "汇总数据", prompt: "帮我把这些表里的数据汇总成一张总表，" },
  { id: "reconcile", label: "核对差异", prompt: "帮我核对这两份数据的差异，把不一致的列出来，" },
  { id: "extract", label: "提取内容", prompt: "帮我把这份文档里的关键信息提取出来，整理成表格，" },
  { id: "report", label: "做成报表", prompt: "根据这些数据做一份报表，" },
];

interface CoworkPanelProps {
  /** 事件总线路由键，由 App 传入固定值（Cowork 只有一个工作面） */
  clientId: string;
  connected: boolean;
  send: (cmd: Record<string, unknown>) => void;
  /**
   * 退出 Cowork、回到 Chat/Code。
   * 仅侧栏形态需要；开在编辑器 Tab 时省略（关 Tab 即退出，再给个按钮反而多余）。
   */
  onExit?: () => void;
}

export function CoworkPanel({ clientId, connected, send, onExit }: CoworkPanelProps) {
  const [files, setFiles] = useState<PickedFile[]>([]);
  const [draft, setDraft] = useState("");
  const editorRef = useRef<MentionEditorHandle>(null);
  const [dragging, setDragging] = useState(false);
  /** 提交失败的人话提示（未选模型、未连上服务等） */
  const [notice, setNotice] = useState<string>("");
  const pendingPickRef = useRef<string | null>(null);
  const pendingOutputPickRef = useRef<string | null>(null);
  /**
   * 空态首发的落位动画状态。
   * true = 正在播放输入框从居中下落到底部的过渡；动画跑完才真正提交任务。
   */
  const [landing, setLanding] = useState(false);
  /** 落位动画结束后要执行的提交动作（动画期间暂存，避免内容插入打断过渡） */
  const pendingSubmitRef = useRef<(() => void) | null>(null);
  const [outputPickerOpen, setOutputPickerOpen] = useState(false);
  const [outputDir, setOutputDir] = useState<string>(() => {
    try { return localStorage.getItem(STORAGE.OUTPUT_DIR) || ""; } catch { return ""; }
  });

  // ── 模型 / 强度 / 上下文 ───────────────────────────────────────────────
  // 复用 Chat 侧的 localStorage 键（LAST_MODEL / LAST_PROVIDER / EFFORT_PREFERENCES）：
  // 这些偏好与会话无关，共享后用户在 Chat 选的模型切到 Cowork 就是同一个，
  // 符合「同一个产品的两个工作面」的预期，也省掉一套要单独维护的设置。
  const models = useModels();
  const [model, setModelState] = useState<string>(() => {
    try { return normalizeStoredModelId(localStorage.getItem(STORAGE.LAST_MODEL)) || ""; } catch { return ""; }
  });
  const [provider, setProvider] = useState<string | undefined>(() => {
    try { return localStorage.getItem(STORAGE.LAST_PROVIDER) || undefined; } catch { return undefined; }
  });
  const [effort, setEffort] = useState<string | null>(null);

  const { levels: effortLevels, defaultEffort, handleEffortChange } = useModelEffort({
    model,
    provider,
    effort,
    setEffort,
    models,
  });

  const handleModelChange = useCallback((nextModel: string, nextProvider?: string) => {
    const target = resolveModel(nextModel, nextProvider, models);
    // 先带出该模型的强度偏好，再切模型——顺序与 Chat 侧一致，
    // 避免中间态里「新模型 + 旧强度」被 useModelEffort 当成非法值纠正掉。
    setEffort(resolveEffortForModel(target));
    setModelState(nextModel);
    setProvider(nextProvider);
    try {
      localStorage.setItem(STORAGE.LAST_MODEL, nextModel);
      if (nextProvider) localStorage.setItem(STORAGE.LAST_PROVIDER, nextProvider);
      else localStorage.removeItem(STORAGE.LAST_PROVIDER);
    } catch { /* 忽略写入失败 */ }
  }, [models]);

  // ── Agent 会话 ─────────────────────────────────────────────────────────
  const { tasks, running, tokenUsage, sessionId, loadingHistory, queue, submit, cancel, startNewSession, openSession, removeFromQueue } = useCoworkSession({ clientId, connected, send });
  const [historyOpen, setHistoryOpen] = useState(false);
  // 贴底跟随：流式输出时自动滚到底，用户手动上滚则停止跟随（与 Code 侧同一套判据）
  const { ref: scrollRef, showScrollButton, scrollToBottom } = useStickToBottom<HTMLDivElement>();

  useSessionEvents(clientId, (msg) => {
    const response = msg as WsMessage & {
      requestId?: string;
      path?: string;
      error?: string;
      files?: { path: string; name: string; size: number }[];
    };
    if (response.type === "cowork_output_dir_picked" && response.requestId === pendingOutputPickRef.current) {
      pendingOutputPickRef.current = null;
      if (response.path) handleSelectOutputDir(response.path);
      else if (response.error) setNotice(`无法选择文件夹：${response.error}`);
      return;
    }
    if (response.type !== "cowork_files_picked" || response.requestId !== pendingPickRef.current) return;
    pendingPickRef.current = null;
    const picked = response.files || [];
    if (!picked.length) return;
    // 文件由 files 状态管理并渲染成卡片（与 Code 侧一致），编辑器只管文字。
    // 不在 setFiles 的 updater 里插入编辑器节点：updater 在严格模式下会被调用两次。
    setFiles((prev) => {
      const seen = new Set(prev.map((file) => file.path));
      const added = picked.filter((file) => {
        if (seen.has(file.path)) return false;
        seen.add(file.path);
        return true;
      }).map((file, index) => ({ ...file, id: `${Date.now()}-${index}-${file.name}` }));
      return [...prev, ...added];
    });
    setNotice("");
  });

  /**
   * 上下文用量。
   * max 优先用后端实测值（token_usage 事件），还没跑过任务时退回当前模型的窗口上限。
   * 圆环只读（不传 onCompact）：Cowork 这一屏不该出现"压缩上下文"这种概念，
   * 真要压缩由后端自动处理。
   */
  const contextMax = tokenUsage.max > 0
    ? tokenUsage.max
    : (resolveModel(model, provider, models)?.contextWindow || TIMEOUT.DEFAULT_CONTEXT_WINDOW);

  /**
   * 通过 VS Code 原生对话框选文件。
   *
   * 走请求/应答：webview 发 cowork_pick_files（带 requestId），扩展弹原生对话框，
   * 再把带绝对路径的结果 postMessage 回来。这是拿到真实路径的唯一途径。
   */
  const pickFiles = useCallback(() => {
    const vscodeApi = (window as unknown as { __axonVSCode?: { postMessage: (m: unknown) => void } }).__axonVSCode;
    if (!vscodeApi) {
      setNotice("请在 Axon 中使用文件选择");
      return;
    }
    const requestId = `cowork-pick-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    pendingPickRef.current = requestId;
    vscodeApi.postMessage({ type: "cowork_pick_files", clientId, requestId });
  }, [clientId]);

  const handleSelectOutputDir = useCallback((dir: string) => {
    setOutputDir(dir);
    try { localStorage.setItem(STORAGE.OUTPUT_DIR, dir); } catch { /* 忽略 */ }
  }, []);

  const pickOutputDir = useCallback(() => {
    const host = (window as unknown as { __axonVSCode?: { postMessage: (m: unknown) => void } }).__axonVSCode;
    if (!host) {
      setOutputPickerOpen(true);
      return;
    }
    const requestId = `cowork-output-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    pendingOutputPickRef.current = requestId;
    host.postMessage({ type: "cowork_pick_output_dir", clientId, requestId, initialPath: outputDir });
  }, [clientId, outputDir]);

  const handleNewTask = useCallback(() => {
    startNewSession();
    editorRef.current?.clear();
    setFiles([]);
    setDraft("");
    setNotice("");
    setLanding(false);
    pendingSubmitRef.current = null;
  }, [startNewSession]);

  /**
   * 空态（还没提交过任何任务）：场景动画 + 输入框居中，像一张等待落笔的便签。
   * 落位动画期间不算空态——动画一开始就要让输入框往底部走，此时还没插入内容，
   * 不排除它的话 flex-grow 目标不会变化、动画根本不会发生。
   */
  // 加载历史时不算空态：否则切会话的瞬间会闪一下「选一份表格或文档」的欢迎屏
  const isEmpty = tasks.length === 0 && !landing && !loadingHistory;
  // 处理中也能发：会排进队列，本轮结束后自动发出（与 Code 侧同一约定）。
  // 单任务串行的约束仍然成立 —— 由会话层的队列保证不并发，而不是靠禁用输入。
  const canSend = draft.trim().length > 0 || files.length > 0;

  /**
   * 落位动画跑完后真正提交。
   *
   * 用定时器而不是 transitionend：后者在过渡被打断、元素被隐藏（切走 Tab）或用户开了
   * reduce-motion 时可能压根不触发，那条任务就永远提交不出去 —— 宁可按固定时长兜底，
   * 也不能让用户的输入凭空消失。
   */
  useEffect(() => {
    if (!landing) return;
    const timer = setTimeout(() => {
      const run = pendingSubmitRef.current;
      pendingSubmitRef.current = null;
      setLanding(false);
      run?.();
    }, COMPOSER_LANDING_MS);
    return () => clearTimeout(timer);
  }, [landing]);

  const handleSubmit = useCallback(() => {
    const text = draft.trim();
    if (!text && files.length === 0) return;

    const commit = () => {
      const result = submit({
        request: text || "处理我选择的这些文件",
        files: files.map((f) => ({ path: f.path, name: f.name })),
        model,
        provider,
        effort,
        outputDir,
      });
      if (!result.ok) {
        // 提交被挡下来（没选模型/没连上）：把草稿还给用户，不让输入白打。
        setNotice(result.reason);
        setDraft(text);
        return;
      }
      setNotice("");
      // 排队的任务不滚动：此刻没有新卡片产生（它只是进了队列），
      // 滚到底反而会把用户正在看的内容挪走。
      if (!result.queued) {
        // 发出后立即回到底部，让新任务卡片进入视野。
        // 放在下一帧：此刻新卡片还没挂到 DOM 上，立刻滚只会滚到旧的内容高度。
        requestAnimationFrame(() => scrollToBottom("smooth"));
      }
      editorRef.current?.clear();
      // 文件清单交给 Agent 后就清空：任务卡片里已经列出参与的文件，
      // 留在输入区会让用户以为下一个任务还会带上它们。
      setFiles([]);
    };

    // 空态首发：先播放落位动画，动画结束再提交。
    // 输入框立即清空，和普通提交的手感一致（不让文字跟着动画一起飞）。
    if (isEmpty) {
      setDraft("");
      setLanding(true);
      pendingSubmitRef.current = commit;
      return;
    }

    setDraft("");
    commit();
  }, [draft, files, isEmpty, submit, model, provider, effort, outputDir, scrollToBottom]);

  return (
    <div className="flex h-full flex-col bg-background">
      {/* 顶部：产出位置常驻可见。
          不藏进菜单是刻意的——办公用户最关心"东西存哪了"，这个信息必须一眼能看到、
          一点能改，而不是像 Chat 那侧藏在加号菜单里。 */}
      <header className="shrink-0 border-b border-border">
        <div className="mx-auto flex w-full max-w-[780px] items-center justify-between gap-3 px-4 py-2.5">
        {/* 整行用 flex + items-center 对齐，不靠 inline 基线：
            按钮是 inline-flex，它的基线取自第一个 flex 项，而那是个
            display:block 的图标（没有基线），于是回退成盒底边对齐，
            和左边「产出到：」的文字基线错开约 2px，看着就是没对齐。 */}
        <div className="flex min-w-0 items-center gap-1 text-[13px]">
          <span className="shrink-0 text-muted-foreground">产出到：</span>
          <button
            onClick={pickOutputDir}
            className="flex min-w-0 items-center gap-1 rounded-md px-1.5 py-0.5 font-medium text-foreground transition-colors hover:bg-muted/60"
            title={outputDir || "点击选择一个文件夹"}
          >
            <FolderOpen className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate">{outputDir ? shortenPath(outputDir) : "选择文件夹"}</span>
          </button>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            onClick={() => setHistoryOpen(true)}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[12px] text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
            title="查看历史任务"
          >
            <History className="h-3.5 w-3.5" />
            历史
          </button>
          <button
            onClick={handleNewTask}
            disabled={running && !connected}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[12px] text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground disabled:opacity-50"
            title="开始一个全新的任务，不继承当前任务记忆"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            新任务
          </button>
          {onExit && (
            <button
              onClick={onExit}
              className="rounded-md px-2 py-1 text-[12px] text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
            >
              退出 Cowork
            </button>
          )}
        </div>
        </div>
      </header>

      {/* 主体：场景/拖放区/已选文件/已提交任务。
          与下方输入区各占 flex-1：空态时本块靠底、输入区靠顶，两者在视觉中心相接；
          提交后输入区 flex-grow 收到 0 落到底部，本块独占剩余高度并改为自上而下排列。 */}
      <div
        // 空态靠底（与下方靠顶的输入区合成一组居中）；有内容后靠顶，像消息流那样自上而下。
        // 空态给 grow:1.15 略大于输入区的 1：场景块本身高，等权重会把交界点顶得偏上，
        // 略微加权让「场景 + 输入框」整组的视觉重心落回屏幕中间。
        className={`relative flex min-h-0 flex-col items-center px-6 transition-colors ${isEmpty ? "justify-end" : "justify-start"} ${dragging ? "bg-primary/5" : ""}`}
        style={{ flexGrow: isEmpty ? 1.15 : 1, flexShrink: 1, flexBasis: "auto" }}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          // 拖放拿不到绝对路径（浏览器安全限制），而 Agent 必须有路径才能读文件。
          // 所以这里不接收拖来的文件，改为引导用户走原生选择器 ——
          // 静默忽略会让用户以为拖成功了，等提交才发现没文件更糟。
          e.preventDefault();
          setDragging(false);
          if (e.dataTransfer.files?.length > 0) {
            setNotice("请点「选择文件」来添加，这样我才能读到文件内容");
          }
        }}
      >
        {loadingHistory && (
          <div className="flex w-full max-w-[780px] items-center justify-center gap-2 py-10 text-[13px] text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            正在打开历史任务
          </div>
        )}

        {!loadingHistory && tasks.length > 0 && (
          // ref 挂滚动容器：贴底跟随 + 用户上滚即停（与 Code 侧同一套判据）
          <div ref={scrollRef} className="min-h-0 w-full max-w-[780px] flex-1 overflow-y-auto py-4">
            {tasks.map((task, taskIndex) => (
              <div
                key={task.id}
                // 任务之间拉开间距并加分隔线：连着跑几轮时，上一条的回复和下一条的
                // 请求原先只差 12px，读起来是一整片文字，根本看不出"这里是新的一轮"。
                // 第一条不加（顶部不需要分隔线）。
                className={taskIndex > 0 ? "mt-7 border-t border-border/60 pt-7" : ""}
              >
                {/* 用户的请求：居右气泡（Claude 那种形态）。
                    ── 为什么靠右而不是铺满 ──
                    左右分立是对话界面里最强的身份区分：不用读内容，光看位置就知道
                    哪句是自己说的。原先铺满整行 + 浅底色，和下方 AI 回复几乎分不开。
                    气泡最宽 80% —— 太宽就失去"靠右"的视觉效果，和铺满没区别。 */}
                <div className="flex justify-end">
                  {/* 底色走 .axon-user-bubble 而不是 bg-muted：
                      muted 在 VS Code 主题下映射到 input 背景，多数浅色主题里它就是
                      纯白、与编辑器背景同色，气泡会彻底隐形。详见 index.css 的说明。 */}
                  <div className="axon-user-bubble max-w-[80%] rounded-2xl rounded-br-md px-3.5 py-2.5">
                    {/* whitespace-pre-wrap：用户可能用 Shift+Enter 分行描述需求，
                        不保留换行会把分行的要求挤成一坨 */}
                    <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-foreground">{task.request}</p>
                    {/* 附件做成可点开的卡片，不再是一行灰色文件名 ——
                        用户回头看历史时最常做的事就是"再打开看一眼那个表"。
                        卡片也靠右排，跟着气泡的对齐方向走。 */}
                    {task.fileNames.length > 0 && (
                      <div className="mt-2 flex justify-end">
                        <TaskOutputs paths={task.filePaths} fallbackNames={task.fileNames} onBubble />
                      </div>
                    )}
                  </div>
                </div>

                {/* Agent 的回复。用 MarkdownRenderer：产出说明常带路径、表格、列表。 */}
                {task.reply && (
                  <div className="mt-2 px-1 text-[13px] leading-relaxed">
                    <MarkdownRenderer content={task.reply} />
                  </div>
                )}

                {/* 状态行：意图 + 阶段 + 耗时，终态转成结果摘要或错误。
                    摆在回复下方而不是上方 —— 进行中它是全卡片唯一内容（自然在顶），
                    有了回复之后用户的注意力在正文上，状态退成脚注更合理。 */}
                <div className="mt-2">
                  <TaskStatusLine task={task} />
                </div>

                {/* 产出文件：点一下直接预览，不用去资源管理器里翻 */}
                {task.status === "done" && task.outputs.length > 0 && (
                  <div className="mt-2 px-1">
                    <TaskOutputs paths={task.outputs} />
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* 回到底部：用户上滚离开底部后出现。
            绝对定位在滚动区右下，不占布局（否则出现/消失会把内容顶上顶下）。 */}
        {showScrollButton && tasks.length > 0 && (
          <button
            onClick={() => scrollToBottom("smooth")}
            className="absolute bottom-3 right-6 z-10 inline-flex h-8 w-8 items-center justify-center rounded-full border border-border bg-background/95 text-muted-foreground shadow-md backdrop-blur-sm transition-colors hover:text-foreground"
            title="回到最新"
            aria-label="回到最新"
          >
            <ArrowDown className="h-4 w-4" />
          </button>
        )}

        {!loadingHistory && tasks.length === 0 ? (
          <div className="text-center">
            {/* 手绘场景动画：这一屏的主视觉 */}
            <CoworkScene size={186} />
            <p className="mt-1 text-[16px] font-medium text-foreground">选一份表格或文档</p>
            <p className="mt-1.5 text-[13px] text-muted-foreground">
              支持 Excel、Word、PDF、CSV。告诉我你想做什么，我来处理。
            </p>
            <button
              onClick={pickFiles}
              className="mt-4 inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-[13px] text-foreground transition-colors hover:bg-muted/50"
            >
              <Plus className="h-3.5 w-3.5" />
              选择文件
            </button>
          </div>
        ) : null}
      </div>

      {/* 输入区。
          限宽居中：开在编辑器区时宽度可能上千像素，输入框铺满整行会让文字读起来很散，
          也和上方居中的场景宽度脱节。

          空态：flex-grow=1 吃满剩余高度并把内容垂直居中（配合上方不抢高度的场景块，
          整组落在视觉中心）。首发时 isEmpty 转 false，flex-grow 回到 0，容器高度收缩、
          带动输入框平滑落到底部 —— 落位动画就是这么来的。

          过渡放在 flex-grow 而不是 transform：后者会让输入框脱离布局、压在上方内容上；
          flex-grow 是真实的布局动画，动画结束时位置即最终位置，不用再校正。
          grow 值写在 style 里（而非 flex-1 类名）：类名简写会连带改 basis 与 shrink，
          属性一起跳变就过渡不起来了。 */}
      <div
        className={`mx-auto flex w-full max-w-[780px] flex-col px-4 pb-4 ${isEmpty ? "justify-start pt-4" : "justify-center"}`}
        style={{
          flexGrow: isEmpty ? 1 : 0,
          flexShrink: 0,
          flexBasis: "auto",
          transition: `flex-grow ${COMPOSER_LANDING_MS}ms cubic-bezier(0.22, 1, 0.36, 1)`,
        }}
      >
        {/* 提交被挡下来时的人话提示（没选模型、没连上、拖放不支持等） */}
        {notice && (
          <p className="mb-2 px-1 text-[12px] text-amber-600 dark:text-amber-500">{notice}</p>
        )}

        {/* 快捷任务：办公场景的高频动作，省掉"我该怎么描述"这一步 */}
        <div className="mb-2 flex flex-wrap gap-1.5">
          {QUICK_TASKS.map((task) => (
            <button
              key={task.id}
              // 文字由 MentionEditor 自己持有，只改 draft 不会回填到编辑器里；
              // 必须通过编辑器句柄写入，onChange 再把 draft 同步回来。
              onClick={() => {
                if (editorRef.current && editorRef.current.isEmpty()) {
                  editorRef.current.setText(task.prompt);
                  editorRef.current.focus();
                }
              }}
              className="rounded-lg border border-border bg-background px-2.5 py-1 text-[12px] text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
            >
              {task.label}
            </button>
          ))}
        </div>

        <div className="relative overflow-hidden rounded-xl border border-border bg-background shadow-[0_1px_2px_rgba(0,0,0,0.04)] transition-all focus-within:ring-1 focus-within:ring-ring">
          {/* 排队中的任务。
              必须让用户看见并能撤回 —— 排了队却没有任何反馈，用户会以为消息丢了，
              然后重复提交一遍。 */}
          {queue.length > 0 && (
            <div className="border-b border-border/40 px-3 pt-2 pb-1.5">
              <div className="mb-1 text-[10px] font-medium text-muted-foreground/70">
                排队中（这一个做完就自动开始）
              </div>
              <div className="max-h-20 space-y-1 overflow-y-auto">
                {queue.map((item) => {
                  const label = item.params.request
                    || (item.params.files.length > 0 ? `${item.params.files.length} 个文件` : "（空）");
                  return (
                    <div key={item.id} className="flex items-center gap-2 rounded bg-muted/40 px-2 py-1 text-[12px] text-foreground/80">
                      <span className="flex-1 truncate">{label}</span>
                      <button
                        onClick={() => removeFromQueue(item.id)}
                        className="shrink-0 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-muted/60 hover:text-destructive"
                        title="不做这条了"
                      >
                        移除
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* 已选文件：与 Code 输入框同一套方形卡片，排在文字上方 */}
          {files.length > 0 && (
            <div className="flex flex-wrap gap-3 px-4 pt-3 pr-12">
              {files.map((file) => (
                <AttachmentCard
                  key={file.id}
                  onRemove={() => setFiles((prev) => prev.filter((f) => f.id !== file.id))}
                  removeLabel={`移除 ${file.name}`}
                  title={file.path}
                  previewPath={file.path}
                >
                  <FileCardBody name={file.name} badge={attachmentTypeLabel({ name: file.name, kind: "file" })} />
                </AttachmentCard>
              ))}
            </div>
          )}
          <div className="px-3 pr-10 pt-2 pb-1">
            <MentionEditor
              ref={editorRef}
              // 运行中不禁用：这时候输入会排进队列，本轮结束自动发出。
              // 只有没连上时才真的不能输入。
              disabled={!connected}
              placeholder={!connected
                ? "等待连接..."
                : (running ? "可以先写下一个任务，这一个做完就接着做" : "说说你想让我做什么，比如「把这三个月的支出按类别汇总」")}
              onChange={() => {
                // 编辑器只承载文字；文件列表由 files 状态独立管理，不从编辑器反推。
                setDraft(editorRef.current?.read().text || "");
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleSubmit();
                }
              }}
            />
          </div>
          <div className="flex items-center justify-between gap-2 px-1.5 pb-1.5">
            {/* 左侧控件组：加号、模型、强度、上下文。
                min-w-0 + 外层 gap 让模型名过长时由 ModelSelector 自己截断，
                而不是把右边的发送按钮挤出容器。 */}
            <div className="flex min-w-0 items-center gap-0.5">
              <button
                onClick={pickFiles}
                className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
                aria-label="添加文件"
              >
                <Plus className="h-4 w-4" />
              </button>
              <ModelSelector
                value={model}
                provider={provider}
                onChange={handleModelChange}
              />
              <EffortSelector
                levels={effortLevels}
                value={effort}
                defaultValue={defaultEffort}
                onChange={handleEffortChange}
              />
              {/* 不传 onCompact：Cowork 这一屏不该出现"压缩上下文"这种概念，
                  超限由后端自动处理，圆环只做用量展示。 */}
              <TokenIndicator used={tokenUsage.used} max={contextMax} />
            </div>
            {/* 处理中换成停止按钮：长任务（读大表格、跑脚本）用户需要能中断，
                否则只能干等。与 Chat 侧同一个交互约定。 */}
            {/* 运行中两个按钮并存：停止（结束当前任务）+ 发送（排进队列）。
                早先运行中只有停止按钮，于是输入框里打好的字没有任何办法提交 ——
                排队功能等于不存在。有内容时才显示发送，避免平时挤占空间。 */}
            <div className="flex shrink-0 items-center gap-1">
              {running && (
                <button
                  onClick={cancel}
                  className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:text-foreground"
                  aria-label="停止处理"
                  title="停止当前任务"
                >
                  <Square className="h-3 w-3" fill="currentColor" />
                </button>
              )}
              {(!running || canSend) && (
                <button
                  onClick={handleSubmit}
                  disabled={!canSend}
                  className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground transition-opacity disabled:opacity-40"
                  aria-label={running ? "加入队列" : "开始处理"}
                  title={running ? "加入队列，这一个做完就开始" : "开始处理"}
                >
                  <Send className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      <CoworkHistory
        open={historyOpen}
        currentSessionId={sessionId}
        onClose={() => setHistoryOpen(false)}
        onSelect={(id) => {
          openSession(id);
          // 切历史会话时清掉当前输入与附件：它们属于上一条任务的上下文
          editorRef.current?.clear();
          setFiles([]);
          setDraft("");
          setNotice("");
        }}
      />

      <WorkspacePicker
        open={outputPickerOpen}
        onOpenChange={setOutputPickerOpen}
        initialPath={outputDir || undefined}
        title="选择文档产出位置"
        confirmLabel="设为产出位置"
        onSelect={handleSelectOutputDir}
      />
    </div>
  );
}

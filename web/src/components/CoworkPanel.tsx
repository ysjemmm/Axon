/**
 * CoworkPanel —— 面向财务、会计、客服的办公工作面（Cowork 模式）
 *
 * ── 和 Chat / Agent 的区别 ──
 * 办公工作大多是周期性的：月底对账、每周工单汇总、每月报销整理。Cowork 的核心是「流程」：
 * 一次做成功的任务存成流程，以后每期放进新文件点运行即可，不用重新描述需求。
 * 再加上两件聊天给不了的东西：结果优先（先看产出文件和核对结果，再看说明）、
 * 每次交付前自动核对（合计、条数、遗漏），让人敢用。
 *
 * 页面三种状态：
 *   · 首页：我的流程 + 岗位模板，底部是临时需求的输入框
 *   · 运行流程：按输入槽放文件，点运行（每次运行是一个独立会话）
 *   · 任务进行中 / 已完成：结果在前、说明在后；自由任务可「保存为流程」
 *
 * 运行时仍是 agent 模式（共享 @axon/core 的 Agent 循环和 document-forge 文档技能），
 * 界面上不出现工具调用、工作区、Provider 这类开发概念。
 */

import { useCallback, useMemo, useState } from "react";
import { ArrowDown, FolderOpen, History, Home, Loader2, Plus, Send, Square } from "lucide-react";
import { WorkspacePicker } from "@/components/WorkspacePicker";
import { ModelSelector, normalizeStoredModelId, useModels } from "@/components/ModelSelector";
import { TokenIndicator } from "@/components/chat/TokenIndicator";
import { useModelEffort, resolveEffortForModel, resolveModel } from "@/components/chat/useModelEffort";
import { MentionEditor, type MentionEditorHandle } from "@/components/chat/MentionEditor";
import { AttachmentCard, FileCardBody } from "@/components/chat/AttachmentCard";
import { attachmentTypeLabel } from "@/components/chat/attachmentType";
import { useCoworkSession, type CoworkSubmitParams } from "@/components/cowork/useCoworkSession";
import { useCoworkFlows } from "@/components/cowork/useCoworkFlows";
import { mergeFiles, useFilePicker, type PickedFileInfo } from "@/components/cowork/useFilePicker";
import { buildFlowMessage, buildFreeTaskMessage, flowDisplayText } from "@/components/cowork/flowPrompt";
import { CoworkHistory } from "@/components/cowork/CoworkHistory";
import { CoworkHome } from "@/components/cowork/CoworkHome";
import { FlowRunner, type FlowRunValues } from "@/components/cowork/FlowRunner";
import { FlowEditor } from "@/components/cowork/FlowEditor";
import { TaskThread } from "@/components/cowork/TaskThread";
import { ConfirmCard } from "@/components/cowork/ConfirmCard";
import { NewFlowDialog } from "@/components/cowork/NewFlowDialog";
import { shareFlowText } from "@/components/cowork/flowShare";
import { useStickToBottom } from "@/components/cowork/useStickToBottom";
import type { CoworkFlow, CoworkFlowDraft } from "@/components/cowork/flowTypes";
import { STORAGE, TIMEOUT } from "@/lib/constants";

/** 长路径缩略：只留末两级，菜单/标签宽度放不下完整绝对路径 */
function shortenPath(absPath: string): string {
  const parts = absPath.replace(/\\/g, "/").split("/").filter(Boolean);
  if (parts.length <= 2) return absPath;
  return `…/${parts.slice(-2).join("/")}`;
}

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

/** 正在打开的流程：已保存的流程带 id；模板 / 草稿没有 */
interface OpenFlow {
  flow: CoworkFlowDraft;
  savedId?: string;
  initial?: Partial<FlowRunValues>;
}

interface EditorState {
  title: string;
  initial: CoworkFlowDraft;
  /** 保存后直接打开运行页（模板存为我的流程、AI 草稿） */
  thenOpen?: boolean;
}

export function CoworkPanel({ clientId, connected, send, onExit }: CoworkPanelProps) {
  const [files, setFiles] = useState<PickedFileInfo[]>([]);
  const [draft, setDraft] = useState("");
  const [editorEl, setEditorEl] = useState<MentionEditorHandle | null>(null);
  const [notice, setNotice] = useState("");
  const [outputPickerOpen, setOutputPickerOpen] = useState(false);
  const [outputDir, setOutputDir] = useState<string>(() => {
    try { return localStorage.getItem(STORAGE.OUTPUT_DIR) || ""; } catch { return ""; }
  });
  const [openFlow, setOpenFlow] = useState<OpenFlow | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [savingFlow, setSavingFlow] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);

  // ── 模型 / 强度 ─────────────────────────────────────────────────────────
  // 复用 Chat 侧的 localStorage 键：同一个产品的两个工作面，用户在 Chat 选的模型切到 Cowork 就是同一个。
  const models = useModels();
  const [model, setModelState] = useState<string>(() => {
    try { return normalizeStoredModelId(localStorage.getItem(STORAGE.LAST_MODEL)) || ""; } catch { return ""; }
  });
  const [provider, setProvider] = useState<string | undefined>(() => {
    try { return localStorage.getItem(STORAGE.LAST_PROVIDER) || undefined; } catch { return undefined; }
  });
  const [effort, setEffort] = useState<string | null>(null);
  const { levels: effortLevels, defaultEffort, handleEffortChange } = useModelEffort({ model, provider, effort, setEffort, models });

  const handleModelChange = useCallback((nextModel: string, nextProvider?: string) => {
    const target = resolveModel(nextModel, nextProvider, models);
    // 先带出该模型的强度偏好，再切模型——顺序与 Chat 侧一致
    setEffort(resolveEffortForModel(target));
    setModelState(nextModel);
    setProvider(nextProvider);
    try {
      localStorage.setItem(STORAGE.LAST_MODEL, nextModel);
      if (nextProvider) localStorage.setItem(STORAGE.LAST_PROVIDER, nextProvider);
      else localStorage.removeItem(STORAGE.LAST_PROVIDER);
    } catch { /* 忽略写入失败 */ }
  }, [models]);

  // ── 会话 / 流程 / 文件选择 ─────────────────────────────────────────────
  const { tasks, running, tokenUsage, sessionId, loadingHistory, queue, confirm, submit, cancel, startNewSession, openSession, removeFromQueue, answerConfirm } = useCoworkSession({ clientId, connected, send });
  const { flows, save: saveFlow, remove: removeFlow, draftFromSession, draftFromDescription } = useCoworkFlows({ clientId, connected, send });
  const [newFlowOpen, setNewFlowOpen] = useState(false);
  const { pickFiles, pickDir } = useFilePicker(clientId);
  const { ref: scrollRef, showScrollButton, scrollToBottom } = useStickToBottom<HTMLDivElement>();

  /** 历史会话属于哪个流程（流程记着自己的运行记录） */
  const flowOfSession = useMemo(() => {
    const map = new Map<string, CoworkFlow>();
    for (const flow of flows) for (const run of flow.runs ?? []) if (!map.has(run.sessionId)) map.set(run.sessionId, flow);
    return map;
  }, [flows]);
  const currentFlow = sessionId ? flowOfSession.get(sessionId) : undefined;
  const threadFlow = tasks.find((t) => t.flow)?.flow;

  const contextMax = tokenUsage.max > 0
    ? tokenUsage.max
    : (resolveModel(model, provider, models)?.contextWindow || TIMEOUT.DEFAULT_CONTEXT_WINDOW);

  const modelControls = (
    <>
      <ModelSelector value={model} provider={provider} onChange={handleModelChange}
        effort={{ levels: effortLevels, value: effort, defaultValue: defaultEffort, onChange: handleEffortChange }} />
    </>
  );

  const handleSelectOutputDir = useCallback((dir: string) => {
    setOutputDir(dir);
    try { localStorage.setItem(STORAGE.OUTPUT_DIR, dir); } catch { /* 忽略 */ }
  }, []);

  const pickOutputDir = useCallback(() => {
    const ok = pickDir(outputDir, (path, error) => {
      if (path) handleSelectOutputDir(path);
      else if (error) setNotice(`无法选择文件夹：${error}`);
    });
    if (!ok) setOutputPickerOpen(true);
  }, [handleSelectOutputDir, outputDir, pickDir]);

  const addFreeFiles = useCallback(() => {
    const ok = pickFiles((picked) => {
      setFiles((prev) => mergeFiles(prev, picked));
      setNotice("");
    });
    if (!ok) setNotice("请在 Axon 中使用文件选择");
  }, [pickFiles]);

  const resetComposer = useCallback(() => {
    editorEl?.clear();
    setFiles([]);
    setDraft("");
    setNotice("");
  }, [editorEl]);

  const goHome = useCallback(() => {
    startNewSession();
    setOpenFlow(null);
    resetComposer();
  }, [resetComposer, startNewSession]);

  const baseParams = (): Pick<CoworkSubmitParams, "model" | "provider" | "effort" | "outputDir"> => ({ model, provider, effort, outputDir });

  // ── 自由任务 ────────────────────────────────────────────────────────────
  const canSend = draft.trim().length > 0 || files.length > 0;
  const handleSubmit = useCallback(() => {
    const text = draft.trim();
    if (!text && files.length === 0) return;
    const request = text || "处理我选择的这些文件";
    const picked = files.map((f) => ({ path: f.path, name: f.name }));
    const result = submit({ ...baseParams(), request, content: buildFreeTaskMessage(request, picked, outputDir), files: picked });
    if (!result.ok) { setNotice(result.reason); return; }
    setNotice("");
    setOpenFlow(null);
    if (!result.queued) requestAnimationFrame(() => scrollToBottom("smooth"));
    editorEl?.clear();
    setDraft("");
    setFiles([]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, files, submit, model, provider, effort, outputDir, scrollToBottom, editorEl]);

  // ── 运行流程 ────────────────────────────────────────────────────────────
  const runFlow = useCallback((open: OpenFlow, values: FlowRunValues) => {
    const { flow } = open;
    const allFiles = flow.inputs.flatMap((input) => (values.slots[input.id] ?? []).map((f) => ({ path: f.path, name: f.name })));
    const result = submit({
      ...baseParams(),
      request: flowDisplayText(flow, values),
      content: buildFlowMessage(flow, values.slots, { answer: values.answer, note: values.note, outputDir }),
      files: allFiles,
      // 每次运行是独立的一期：新会话，不带上一期的记忆
      fresh: true,
      ...(open.savedId ? { flow: { id: open.savedId, name: flow.name } } : {}),
    });
    if (!result.ok) { setNotice(result.reason); return; }
    setNotice("");
    setOpenFlow(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [submit, model, provider, effort, outputDir]);

  const openSavedFlow = useCallback((flow: CoworkFlow, initial?: Partial<FlowRunValues>) => {
    setOpenFlow({ flow, savedId: flow.id, initial });
  }, []);

  /** 「换一批文件再运行」：回到这个流程的运行页 */
  const runAgain = useCallback(() => {
    const id = threadFlow?.id ?? currentFlow?.id;
    const flow = flows.find((f) => f.id === id);
    if (flow) openSavedFlow(flow);
  }, [currentFlow, flows, openSavedFlow, threadFlow]);

  // ── 保存为流程 ──────────────────────────────────────────────────────────
  const saveAsFlow = useCallback(async () => {
    if (!sessionId) return;
    setSavingFlow(true);
    setNotice("");
    try {
      const draftFlow = await draftFromSession(sessionId);
      setEditor({ title: "保存为流程", initial: draftFlow, thenOpen: false });
    } catch (e) {
      setNotice((e as Error).message);
    }
    setSavingFlow(false);
  }, [draftFromSession, sessionId]);

  const handleEditorSave = useCallback(async (flow: CoworkFlowDraft) => {
    const saved = await saveFlow(flow);
    const thenOpen = editor?.thenOpen;
    setEditor(null);
    // 正在看的运行页属于这个流程（编辑或模板另存）：换成保存后的版本
    if (thenOpen || (openFlow && (openFlow.savedId === saved.id || !openFlow.savedId))) {
      setOpenFlow((prev) => ({ flow: saved, savedId: saved.id, initial: prev?.initial }));
    } else {
      setNotice(`已保存流程「${saved.name}」，回到首页就能一键运行。`);
    }
  }, [editor, openFlow, saveFlow]);

  const showRunner = !!openFlow;
  const showThread = !showRunner && (tasks.length > 0 || loadingHistory);
  const isFlowThread = !!(threadFlow || currentFlow);
  const lastDone = tasks[tasks.length - 1]?.status === "done";

  return (
    <div className="relative flex h-full flex-col bg-background">
      {/* 顶部：产出位置常驻可见——办公用户最关心「东西存哪了」 */}
      <header className="shrink-0 border-b border-border">
        <div className="mx-auto flex w-full max-w-[max(640px,80%)] items-center justify-between gap-3 px-4 py-2.5">
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
            {(showThread || showRunner) && (
              <button onClick={goHome} className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[12px] text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground" title="回到首页，开始新的任务">
                <Home className="h-3.5 w-3.5" />首页
              </button>
            )}
            <button onClick={() => setHistoryOpen(true)} className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[12px] text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground" title="查看历史任务">
              <History className="h-3.5 w-3.5" />历史
            </button>
            {onExit && (
              <button onClick={onExit} className="rounded-md px-2 py-1 text-[12px] text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground">
                退出 Cowork
              </button>
            )}
          </div>
        </div>
      </header>

      <div className="relative flex min-h-0 flex-1 flex-col">
        {showRunner && openFlow && (
          <div className="min-h-0 flex-1 overflow-y-auto px-6">
            <FlowRunner
              key={`${openFlow.savedId ?? openFlow.flow.templateId ?? openFlow.flow.name}`}
              flow={openFlow.flow}
              isTemplate={!openFlow.savedId}
              initial={openFlow.initial}
              pickFiles={pickFiles}
              onRun={(values) => runFlow(openFlow, values)}
              onBack={() => setOpenFlow(null)}
              onEdit={() => setEditor({
                title: openFlow.savedId ? "编辑流程" : "存为我的流程",
                initial: openFlow.savedId ? openFlow.flow : { ...openFlow.flow, id: undefined },
                thenOpen: true,
              })}
              modelControls={modelControls}
              disabledReason={!connected ? "还没连上服务" : notice || undefined}
            />
          </div>
        )}

        {showThread && (
          <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-6">
            <div className="mx-auto w-full max-w-[max(640px,80%)] py-4">
              {loadingHistory ? (
                <div className="flex items-center justify-center gap-2 py-10 text-[13px] text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />正在打开历史任务
                </div>
              ) : (
                <TaskThread
                  tasks={currentFlow && !threadFlow ? tasks.map((t, i) => (i === 0 ? { ...t, flow: { id: currentFlow.id, name: currentFlow.name } } : t)) : tasks}
                  onRunAgain={isFlowThread ? runAgain : undefined}
                  onSaveAsFlow={!isFlowThread && lastDone && sessionId ? saveAsFlow : undefined}
                  savingFlow={savingFlow}
                />
              )}
            </div>
          </div>
        )}

        {!showRunner && !showThread && (
          <div className="min-h-0 flex-1 overflow-y-auto px-6">
            <CoworkHome
              flows={flows}
              onRunFlow={(flow) => openSavedFlow(flow)}
              onEditFlow={(flow) => setEditor({ title: "编辑流程", initial: flow })}
              onDeleteFlow={(flow) => { if (window.confirm(`删除流程「${flow.name}」？已经做出来的文件不受影响。`)) removeFlow(flow.id); }}
              onUseTemplate={(template) => setOpenFlow({ flow: template })}
              onNewFlow={() => setNewFlowOpen(true)}
              onShareFlow={(flow) => {
                void navigator.clipboard.writeText(shareFlowText(flow))
                  .then(() => setNotice(`已复制流程「${flow.name}」，发给同事后对方在「新建流程 → 导入分享的流程」里粘贴即可。`))
                  .catch(() => setNotice("复制失败，请重试"));
              }}
            />
          </div>
        )}

        {showThread && showScrollButton && (
          <button
            onClick={() => scrollToBottom("smooth")}
            className="absolute bottom-3 right-6 z-10 inline-flex h-8 w-8 items-center justify-center rounded-full border border-border bg-background/95 text-muted-foreground shadow-md backdrop-blur-sm transition-colors hover:text-foreground"
            title="回到最新"
            aria-label="回到最新"
          >
            <ArrowDown className="h-4 w-4" />
          </button>
        )}
      </div>

      {/* 输入区：首页和任务页都有（临时需求 / 追问），运行流程页不显示 */}
      {!showRunner && (
        <div className="mx-auto flex w-full max-w-[max(640px,80%)] shrink-0 flex-col px-4 pb-4">
          {notice && <p className="mb-2 px-1 text-[12px] text-amber-600 dark:text-amber-500">{notice}</p>}
          {confirm && <ConfirmCard confirm={confirm} onAnswer={answerConfirm} />}
          <div className="relative overflow-hidden rounded-xl border border-border bg-background shadow-[0_1px_2px_rgba(0,0,0,0.04)] transition-all focus-within:ring-1 focus-within:ring-ring">
            {/* 排队中的任务：必须看得见、能撤回，否则用户会以为消息丢了再提交一遍 */}
            {queue.length > 0 && (
              <div className="border-b border-border/40 px-3 pt-2 pb-1.5">
                <div className="mb-1 text-[10px] font-medium text-muted-foreground/70">排队中（这一个做完就自动开始）</div>
                <div className="max-h-20 space-y-1 overflow-y-auto">
                  {queue.map((item) => (
                    <div key={item.id} className="flex items-center gap-2 rounded bg-muted/40 px-2 py-1 text-[12px] text-foreground/80">
                      <span className="flex-1 truncate">{item.params.request || `${item.params.files.length} 个文件`}</span>
                      <button onClick={() => removeFromQueue(item.id)} className="shrink-0 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-muted/60 hover:text-destructive" title="不做这条了">移除</button>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {files.length > 0 && (
              <div className="flex flex-wrap gap-3 px-4 pt-3 pr-12">
                {files.map((file) => (
                  <AttachmentCard key={file.path} onRemove={() => setFiles((prev) => prev.filter((f) => f.path !== file.path))} removeLabel={`移除 ${file.name}`} title={file.path} previewPath={file.path}>
                    <FileCardBody name={file.name} badge={attachmentTypeLabel({ name: file.name, kind: "file" })} />
                  </AttachmentCard>
                ))}
              </div>
            )}
            <div className="px-3 pr-10 pt-2 pb-1">
              <MentionEditor
                ref={setEditorEl}
                disabled={!connected}
                placeholder={!connected
                  ? "等待连接..."
                  : running
                    ? "可以先写下一个任务，这一个做完就接着做"
                    : showThread ? "还要调整什么？直接说" : "临时的需求直接说，比如「把这三个月的支出按类别汇总」"}
                onChange={() => setDraft(editorEl?.read().text || "")}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleSubmit();
                  }
                }}
              />
            </div>
            <div className="flex items-center justify-between gap-2 px-1.5 pb-1.5">
              <div className="flex min-w-0 items-center gap-0.5">
                <button onClick={addFreeFiles} className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground" aria-label="添加文件" title="添加文件">
                  <Plus className="h-4 w-4" />
                </button>
                {modelControls}
                {/* 只读圆环：Cowork 不出现「压缩上下文」这种概念，超限由后端自动处理 */}
                <TokenIndicator used={tokenUsage.used} max={contextMax} />
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {running && (
                  <button onClick={cancel} className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:text-foreground" aria-label="停止处理" title="停止当前任务">
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
      )}

      <CoworkHistory
        open={historyOpen}
        currentSessionId={sessionId}
        flowOfSession={flowOfSession}
        onClose={() => setHistoryOpen(false)}
        onSelect={(id) => {
          setOpenFlow(null);
          openSession(id);
          resetComposer();
        }}
      />

      {newFlowOpen && (
        <NewFlowDialog
          onDraft={(description) => {
            if (!model.trim() || !provider?.trim()) return Promise.reject(new Error("请先在下方选择一个模型"));
            return draftFromDescription(description, model, provider);
          }}
          onOpenEditor={(draft) => { setNewFlowOpen(false); setEditor({ title: "新建流程", initial: draft, thenOpen: true }); }}
          onClose={() => setNewFlowOpen(false)}
        />
      )}

      {editor && (
        <FlowEditor
          title={editor.title}
          initial={editor.initial}
          onSave={handleEditorSave}
          onClose={() => setEditor(null)}
        />
      )}

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

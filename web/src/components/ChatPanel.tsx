/**
 * ChatPanel —— 单个会话面板的 UI 壳层（多会话版）
 *
 * 会话与传输逻辑收敛在 useChatSession hook，本组件只负责：
 * 输入区编排、消息列表渲染、滚动跟随、文件/图片处理、各类弹窗。
 *
 * 多会话：每个面板有稳定的 clientId（事件总线路由 + 命令打标），由 SessionContainer 管理生命周期。
 */

import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { Send, Loader2, Copy, ImagePlus, X, Paperclip, Plus, Camera, Feather, Check, ChevronDown, ListChecks, Sparkles, Globe, ShieldAlert, Undo2, Minimize2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { ModelSelector, autoSelectModel, useModels, findModel, getModels } from "@/components/ModelSelector";
import { WorkspacePicker } from "@/components/WorkspacePicker";
import { WorkspaceGroupManager, type WorkspaceGroup } from "@/components/WorkspaceGroupManager";
import { AxonLogo } from "@/components/AxonLogo";
import { SkillStudio } from "@/components/SkillStudio";

import type { AttachedFile, ChatPanelProps, ReplyStyle, UserSegment } from "./chat/types";
import { REPLY_STYLES } from "./chat/types";
import { FILE_MAX_SIZE, isAllowedTextFile, looksBinary } from "./chat/fileUtils";
import { ReasoningBlock } from "./chat/ReasoningBlock";
import { MessageBubble } from "./chat/MessageBubble";
import { AppliedChangesBar } from "./AppliedChangesBar";
import { MentionEditor, type MentionEditorHandle } from "./chat/MentionEditor";
import { TokenIndicator } from "./chat/TokenIndicator";
import { useChatSession, type SubmitPayload } from "./chat/useChatSession";
import { useSessionEvents } from "@/hooks/useSessionEvents";
import { useSlashCommands } from "./chat/slash/useSlashCommands";
import { useSlashCommandHost } from "./chat/slash/useSlashCommandHost";
import { SlashCommandMenu } from "./chat/slash/SlashCommandMenu";
import { DEFAULT_SLASH_COMMANDS } from "./chat/slash/commands";
import { CommandApprovalContext } from "./chat/commandApprovalContext";
import { QuestionListPanel } from "./chat/QuestionListPanel";
import { VirtualMessageList, type VirtualMessageListHandle } from "./chat/VirtualMessageList";

export function ChatPanel({ clientId, sessionId, mode, connected, active, send, onSessionCreated, onCompactionMigrated, onStreamingChange }: ChatPanelProps) {
  const session = useChatSession({ clientId, sessionId, mode, connected, send, onSessionCreated, onCompactionMigrated, onStreamingChange });

  // ── 输入区编排（壳层本地状态） ──────────────────────────────────────────
  const [images, setImages] = useState<string[]>([]);
  const [fileError, setFileError] = useState<string>("");
  const [composerEmpty, setComposerEmpty] = useState(true); // 编辑器是否为空（控制发送按钮可用态）
  const [replyStyle, setReplyStyle] = useState<ReplyStyle>("default");
  const [menuOpen, setMenuOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [groupManagerOpen, setGroupManagerOpen] = useState(false);
  const [skillStudioOpen, setSkillStudioOpen] = useState(false);
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  // 问题列表 Popover 受控状态
  const [questionListOpen, setQuestionListOpen] = useState(false);
  // 顶部 sticky：当前视图所属 AI 回答对应的用户提问
  const [stickyQuestion, setStickyQuestion] = useState<{ id: string; text: string } | null>(null);
  const lastStickyIdRef = useRef<string | null>(null);

  const virtualListRef = useRef<VirtualMessageListHandle>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<MentionEditorHandle>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const docInputRef = useRef<HTMLInputElement>(null);

  // ── 斜杠命令（/）：当前文件 / 搜索文件 / 搜索文件夹 / 诊断 ──────────────
  // QUEST（纯问答）模式去掉“问题/诊断”（诊断主要服务于 Agent 改代码场景），保留当前文件与文件/文件夹搜索
  const slashCommands = useMemo(
    () => (mode === "quest" ? DEFAULT_SLASH_COMMANDS.filter((c) => c.id !== "problems") : DEFAULT_SLASH_COMMANDS),
    [mode],
  );
  const slashHost = useSlashCommandHost(clientId, editorRef);
  const slashEditorBridge = useMemo(
    () => ({
      deleteBeforeCaret: (len: number) => editorRef.current?.deleteBeforeCaret(len),
      focus: () => editorRef.current?.focus(),
    }),
    [],
  );
  const slash = useSlashCommands({ host: slashHost, editor: slashEditorBridge, commands: slashCommands });

  /** 编辑器内容变化：刷新空态 + 驱动斜杠检测 */
  const handleEditorChange = useCallback((before: string) => {
    setComposerEmpty(editorRef.current?.isEmpty() ?? true);
    slash.handleTextChange(before);
  }, [slash]);

  /** 当前模型是否支持图片（含自定义 provider 模型，故走合并列表） */
  const models = useModels();
  const currentModelVision = models.find((m) => m.id === session.model)?.vision ?? false;

  // 命令审批 Context：把"按 toolCallId 索引的待审批项 + 决策回调"下发给对话流里的命令卡片
  const commandApprovalCtx = useMemo(
    () => ({ approvals: session.commandApprovals, onApprove: session.approveCommand, waitingInputIds: session.waitingInputIds }),
    [session.commandApprovals, session.approveCommand, session.waitingInputIds],
  );

  /** 用户提问文本（content 优先，回退到 userSegments 拼接），供 sticky 条展示 */
  const questionTextById = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of session.chatHistory) {
      if (m.role !== "user") continue;
      let text = (m.content || "").trim();
      if (!text && m.userSegments && m.userSegments.length > 0) {
        text = m.userSegments.map((s) => (s.type === "text" ? s.text : s.tag?.name ?? "")).join("").trim();
      }
      map.set(m.id, text);
    }
    return map;
  }, [session.chatHistory]);

  /** 点击 sticky 条：平滑滚动到对应提问处，落点刚好在 sticky 条下方一点 */
  const scrollToQuestion = useCallback((id: string) => {
    const idx = session.chatHistory.findIndex((m) => m.id === id);
    if (idx >= 0) virtualListRef.current?.scrollToIndex(idx, "smooth");
  }, [session.chatHistory]);

  // ── 自动滚动 ──────────────────────────────────────────────────────────────
  const [showScrollBtn, setShowScrollBtn] = useState(false);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "instant") => {
    autoScrollUserOverride.current = false;
    setShowScrollBtn(false);
    virtualListRef.current?.scrollToBottom(behavior);
  }, []);

  const animatedScrollToBottom = useCallback(() => {
    autoScrollUserOverride.current = false;
    setShowScrollBtn(false);
    virtualListRef.current?.scrollToBottom("smooth");
  }, []);

  // 列表滚动回调：只做 showScrollBtn（sticky 改由 onTopItemChange 驱动）
  const handleScrollRef = useRef<((scrollTopVal: number) => void) | null>(null);

  // sticky user question 检测：基于顶部可见消息 index，在数据数组里往前找最近的用户消息。
  // 不依赖 DOM（虚拟列表会移除滚出视口的元素），所以靠近底部也能稳定显示。
  const handleTopItemChange = useCallback((topIndex: number) => {
    const history = session.chatHistory;
    let current: { id: string; text: string } | null = null;
    for (let i = Math.min(topIndex, history.length - 1); i >= 0; i--) {
      const m = history[i];
      if (m.role === "user") {
        current = { id: m.id, text: questionTextById.get(m.id) || "" };
        break;
      }
    }
    const nextId = current?.id ?? null;
    if (nextId !== lastStickyIdRef.current) {
      lastStickyIdRef.current = nextId;
      setStickyQuestion(current && current.text ? current : null);
    }
  }, [session.chatHistory, questionTextById]);

  handleScrollRef.current = (scrollTopVal: number) => {
    const state = virtualListRef.current?.getScrollState();
    if (state) {
      const distanceToBottom = state.scrollHeight - scrollTopVal - state.clientHeight;
      setShowScrollBtn(distanceToBottom > 200);
    }
  };

  const stableOnScroll = useCallback((scrollTopVal: number) => {
    handleScrollRef.current?.(scrollTopVal);
  }, []);

  // 撤销失败轻提示：3 秒后自动消失
  useEffect(() => {
    if (!session.undoNotice) return;
    const t = setTimeout(() => session.setUndoNotice(null), 3000);
    return () => clearTimeout(t);
  }, [session.undoNotice, session.setUndoNotice]);

  // 会话清空时重置顶部 sticky 提问条
  useEffect(() => {
    if (session.chatHistory.length === 0) {
      lastStickyIdRef.current = null;
      setStickyQuestion(null);
    }
  }, [session.chatHistory.length]);

  // 持久化会话加载完成后滚到底部（window.reload / 切回历史会话）。
  // Virtuoso 需要时间渲染末尾消息并测量高度，多次调用确保到底。
  const prevLoadingRef = useRef(session.isLoadingSession);
  useEffect(() => {
    const wasLoading = prevLoadingRef.current;
    prevLoadingRef.current = session.isLoadingSession;
    if (!wasLoading || session.isLoadingSession || session.chatHistory.length === 0) return;
    // 多次滚动确保 virtuoso 完成渲染和测量
    const scroll = () => virtualListRef.current?.scrollToBottom("instant");
    scroll();
    requestAnimationFrame(scroll);
    setTimeout(scroll, 50);
    setTimeout(scroll, 150);
    setTimeout(scroll, 300);
  }, [session.isLoadingSession, session.chatHistory.length]);

  // 流式输出时自动跟随底部：用 wheel 事件精确判断用户意图。
  // 向上滚一次 → 停止追底；滚回底部 → 恢复追底。简单、可靠、无竞态。
  const autoScrollUserOverride = useRef(false);
  useEffect(() => {
    if (!session.isLoading) {
      autoScrollUserOverride.current = false;
      return;
    }
    // 启动时滚到底部
    virtualListRef.current?.scrollToBottom("instant");

    const container = virtualListRef.current?.getScrollContainer();
    if (!container) return;

    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) {
        // 向上滚 → 用户想离开底部
        autoScrollUserOverride.current = true;
      } else {
        // 向下滚 → 检测是否已到底部
        const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight <= 40;
        if (atBottom) autoScrollUserOverride.current = false;
      }
    };
    container.addEventListener("wheel", onWheel, { passive: true });

    // 内容高度变化追底：tool card 执行完成/输出展开/footer(思考中) 等会让内容变高，
    // 但 totalCount 不变、virtuoso 的 followOutput 不触发。直接轮询 scrollHeight，
    // 它能捕获所有高度变化（含 footer 兄弟节点）。用户未手动离开底部时保持贴底。
    // 注意：只在真正没在底部时才 scrollTo，避免频繁调用导致 reflow 打断 CSS 动画。
    let prevScrollHeight = container.scrollHeight;
    const poller = setInterval(() => {
      const sh = container.scrollHeight;
      if (sh !== prevScrollHeight) {
        prevScrollHeight = sh;
        if (!autoScrollUserOverride.current) {
          const distanceToBottom = sh - container.scrollTop - container.clientHeight;
          if (distanceToBottom > 2) {
            container.scrollTo({ top: sh, behavior: "instant" });
          }
        }
      }
    }, 60);

    return () => {
      container.removeEventListener("wheel", onWheel);
      clearInterval(poller);
    };
  }, [session.isLoading]);

  // 切回该会话（变为可见）时自动滚到底部
  useEffect(() => {
    if (!active) return;
    const id = requestAnimationFrame(() => scrollToBottom("instant"));
    return () => cancelAnimationFrame(id);
  }, [active, scrollToBottom]);

  // 连接断开时把用户最后一条问题回填到输入框
  useEffect(() => {
    if (!connected && session.isLoading) {
      const lastUserMsg = session.chatHistory.filter((m) => m.role === "user").pop();
      if (lastUserMsg?.content) {
        editorRef.current?.setText(lastUserMsg.content);
        setComposerEmpty(editorRef.current?.isEmpty() ?? false);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected]);

  // ── 发送 ──────────────────────────────────────────────────────────────────
  const doSend = (text: string, sendImgs: string[], sendFileList: AttachedFile[], segments: UserSegment[]) => {
    const sendImages = currentModelVision ? sendImgs : [];
    const sendFiles = [...sendFileList];

    let contentForModel = text;
    if (sendFiles.length > 0) {
      const fileBlocks = sendFiles
        .map((f) => {
          if (f.kind === "terminal") return `终端输出（${f.name}）：\n\`\`\`\n${f.content}\n\`\`\``;
          if (f.kind === "editor") return `代码片段（${f.name}）：\n\`\`\`\n${f.content}\n\`\`\``;
          if (f.kind === "folder") return f.content;
          if (f.kind === "diagnostics") return `诊断信息（${f.name}）：\n\`\`\`\n${f.content}\n\`\`\``;
          return `文件：${f.name}\n\`\`\`\n${f.content}\n\`\`\``;
        })
        .join("\n\n");
      contentForModel = text
        ? `${text}\n\n以下是我提供的上下文：\n\n${fileBlocks}`
        : `以下是我提供的上下文：\n\n${fileBlocks}`;
    }

    let actualModel = session.model;
    let actualProvider = findModel(session.model)?.provider;
    if (session.model === "auto") {
      const selected = autoSelectModel(contentForModel, sendImages.length > 0);
      actualModel = selected.id;
      actualProvider = selected.provider;
    }

    const payload: SubmitPayload = {
      userBubble: {
        content: text,
        images: sendImages.length > 0 ? [...sendImages] : undefined,
        attachedFiles: sendFiles.length > 0 ? sendFiles : undefined,
        segments: segments.length > 0 ? segments : undefined,
      },
      send: {
        content: contentForModel,
        displayText: text,
        attachedFiles: sendFiles.length > 0 ? sendFiles.map((f) => ({ name: f.name, size: f.size })) : undefined,
        userSegments: segments.length > 0 ? segments : undefined,
        model: actualModel,
        provider: actualProvider,
        images: sendImages.length > 0 ? sendImages : undefined,
        workspace: mode === "quest" ? undefined : (session.workspace || undefined),
        workspaces: mode === "quest" ? undefined : (session.workspaces.length > 0 ? session.workspaces : undefined),
        replyStyle,
        mode,
        quest: mode === "quest" ? { think: session.questThink, webSearch: session.questWebSearch } : undefined,
      },
    };

    const queued = session.submit(payload);
    if (!queued) {
      requestAnimationFrame(() => scrollToBottom("smooth"));
      editorRef.current?.focus();
    }
  };

  const handleSend = () => {
    if (session.isCompacting) return;
    const { text, tags, segments } = editorRef.current?.read() ?? { text: "", tags: [], segments: [] };
    if (!text && images.length === 0 && tags.length === 0) return;
    pushHistory(text);
    doSend(text, images, tags, segments);
    editorRef.current?.clear();
    setComposerEmpty(true);
    setImages([]);
    setFileError("");
  };

  // ── 输入历史栈（上下箭头切换） ────────────────────────────────────────────
  const MAX_INPUT_HISTORY = 50;
  const inputHistory = useRef<string[]>([]); // 已发送的历史消息
  const historyIndex = useRef(-1); // 当前浏览位置：-1 = 草稿（未进入历史）
  const draft = useRef(""); // 用户当前正在编辑但未发送的草稿

  /** 发送时记录历史 */
  const pushHistory = useCallback((text: string) => {
    if (!text.trim()) return;
    // 去重：连续发送相同内容不重复记录
    if (inputHistory.current[inputHistory.current.length - 1] === text) return;
    inputHistory.current.push(text);
    if (inputHistory.current.length > MAX_INPUT_HISTORY) {
      inputHistory.current.shift(); // 丢弃最旧的
    }
    historyIndex.current = -1;
    draft.current = "";
  }, []);

  /**
   * 判断光标是否位于「首行行首」（checkTop=true）或「末行行尾」（checkTop=false）。
   * 用于上下箭头切换历史的触发条件——与终端 bash/zsh 行为一致：
   *   ↑ 只有在光标已在本行最前面时才翻历史，否则让光标正常上移
   *   ↓ 只有在光标已在本行最后面时才翻历史，否则让光标正常下移
   * contentEditable 可能有多个文本节点 + tag 节点，需综合判断。
   */
  const caretAtLineEdge = useCallback((checkTop: boolean): boolean => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return false;
    const el = editorRef.current?.getEditorElement();
    if (!el || !el.contains(sel.focusNode)) return false;

    // 光标未选中范围（collapsed）才判断，有选区时不拦截
    if (!sel.isCollapsed) return false;

    if (checkTop) {
      // ── 判断「首行行首」：光标在整个编辑器内容的最前面 ──
      const range = document.createRange();
      range.selectNodeContents(el);
      range.setEnd(sel.focusNode!, sel.focusOffset);
      const before = range.toString();
      return before.length === 0;
    } else {
      // ── 判断「末行行尾」：光标在整个编辑器内容的最后面 ──
      const range = document.createRange();
      range.selectNodeContents(el);
      range.setStart(sel.focusNode!, sel.focusOffset);
      const after = range.toString();
      return after.length === 0;
    }
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
      return;
    }
    // 上下箭头切换历史：仅在「光标位于首行行首（↑）/末行行尾（↓）」时拦截，
    // 其余位置让光标正常移动（用户可在文本内自由导航）。与终端 bash/zsh 行为一致。
    const isUp = e.key === "ArrowUp";
    const isDown = e.key === "ArrowDown";
    if ((isUp || isDown) && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
      const atEdge = caretAtLineEdge(isUp); // ↑查行首，↓查行尾
      if (!atEdge) return; // 光标不在边缘 → 不拦截，光标正常移动

      const currentText = editorRef.current?.read().text || "";
      if (isUp) {
        // 首次按上：保存当前草稿
        if (historyIndex.current === -1) {
          draft.current = currentText;
        }
        const newIdx = historyIndex.current + 1;
        const histLen = inputHistory.current.length;
        if (newIdx < histLen) {
          historyIndex.current = newIdx;
          const histText = inputHistory.current[histLen - 1 - newIdx];
          editorRef.current?.setText(histText);
          e.preventDefault();
        }
      } else {
        // 按下：往新方向走
        if (historyIndex.current > 0) {
          historyIndex.current--;
          const histLen = inputHistory.current.length;
          const histText = inputHistory.current[histLen - 1 - historyIndex.current];
          editorRef.current?.setText(histText);
          e.preventDefault();
        } else if (historyIndex.current === 0) {
          // 回到草稿
          historyIndex.current = -1;
          editorRef.current?.setText(draft.current);
          e.preventDefault();
        }
      }
    }
  };

  const handleModelChange = (newModel: string, providerName?: string) => {
    const targetModel = providerName
      ? getModels().find((m) => m.id === newModel && m.provider === providerName)
      : findModel(newModel);
    if (images.length > 0 && targetModel && !targetModel.vision) return; // 有图片时禁止切到不支持 vision 的模型
    session.setModel(newModel, providerName);
  };

  // ── 图片/文件处理 ──────────────────────────────────────────────────────────
  const fileToBase64 = (file: File): Promise<string> => new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.readAsDataURL(file);
  });

  const addImages = async (files: FileList | File[]) => {
    if (!currentModelVision) return;
    const imageFiles = Array.from(files).filter((f) => f.type.startsWith("image/"));
    const base64List = await Promise.all(imageFiles.map(fileToBase64));
    setImages((prev) => [...prev, ...base64List]);
  };

  const captureScreenshot = async () => {
    if (!currentModelVision) {
      setFileError("当前模型不支持图片，无法使用截图");
      return;
    }
    if (navigator.mediaDevices?.getDisplayMedia) {
      let stream: MediaStream | null = null;
      try {
        stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
        const track = stream.getVideoTracks()[0];
        const video = document.createElement("video");
        video.srcObject = stream;
        await video.play();
        await new Promise((r) => requestAnimationFrame(() => r(null)));
        const canvas = document.createElement("canvas");
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext("2d");
        if (!ctx || canvas.width === 0) throw new Error("无法读取画面");
        ctx.drawImage(video, 0, 0);
        const dataUrl = canvas.toDataURL("image/png");
        track.stop();
        setImages((prev) => [...prev, dataUrl]);
        setFileError("");
        return;
      } catch (err) {
        if ((err as Error).name !== "NotAllowedError") {
          console.warn("[screenshot] getDisplayMedia 失败,尝试剪贴板降级:", err);
        } else {
          return;
        }
      } finally {
        stream?.getTracks().forEach((t) => t.stop());
      }
    }
    if (!navigator.clipboard?.read) {
      setFileError("当前环境不支持截图（需要 HTTPS 或浏览器剪贴板权限）");
      return;
    }
    try {
      const items = await navigator.clipboard.read();
      let found = false;
      for (const item of items) {
        const imageType = item.types.find((t) => t.startsWith("image/"));
        if (imageType) {
          const blob = await item.getType(imageType);
          const dataUrl = await new Promise<string>((resolve) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as string);
            reader.readAsDataURL(blob);
          });
          setImages((prev) => [...prev, dataUrl]);
          found = true;
          break;
        }
      }
      if (!found) setFileError("剪贴板中没有图片。请先用 Win+Shift+S 截图，再点此按钮");
      else setFileError("");
    } catch (err) {
      if ((err as Error).name === "NotAllowedError") {
        setFileError("浏览器拒绝了剪贴板访问权限，请在权限提示中点击「允许」");
      } else {
        setFileError(`读取剪贴板失败：${(err as Error).message}`);
      }
    }
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    if (!currentModelVision) return;
    const files = e.clipboardData.files;
    if (files.length > 0) {
      e.preventDefault();
      addImages(files);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;
    const imgs = files.filter((f) => f.type.startsWith("image/"));
    const docs = files.filter((f) => !f.type.startsWith("image/"));
    if (imgs.length > 0 && currentModelVision) addImages(imgs);
    if (docs.length > 0) addFiles(docs);
  };

  const removeImage = (index: number) => setImages((prev) => prev.filter((_, i) => i !== index));

  const readFileAsText = (file: File): Promise<string> => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve((reader.result as string) ?? "");
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });

  const addFiles = async (files: FileList | File[]) => {
    setFileError("");
    const list = Array.from(files);
    const errors: string[] = [];
    let added = 0;
    for (const file of list) {
      if (!isAllowedTextFile(file.name)) { errors.push(`${file.name}：不支持的文件类型`); continue; }
      if (file.size > FILE_MAX_SIZE) { errors.push(`${file.name}：超过 ${Math.round(FILE_MAX_SIZE / 1024)}KB 限制`); continue; }
      try {
        const content = await readFileAsText(file);
        if (looksBinary(content)) { errors.push(`${file.name}：疑似二进制文件，已跳过`); continue; }
        // 上传文件内容已在本地读到，直接作为 tag 插入编辑器（无需走扩展回灌）
        editorRef.current?.insertTag({ name: file.name, content, size: file.size, kind: "file" });
        added++;
      } catch {
        errors.push(`${file.name}：读取失败`);
      }
    }
    if (added > 0) setComposerEmpty(editorRef.current?.isEmpty() ?? false);
    if (errors.length > 0) setFileError(errors.join("；"));
  };

  // 接收外部注入的上下文 → 作为内联 tag 插入编辑器。
  // 带 contextId（斜杠命令触发，已先插入占位 tag）→ 补全该 tag；否则（终端/编辑器选区）→ 在光标处插入新 tag。
  useSessionEvents(clientId, useCallback((msg) => {
    if (msg.type !== "add_context") return;
    const text = (msg as { text?: string }).text;
    if (text === undefined) return;
    const rawSource = (msg as { source?: string }).source;
    const kind: AttachedFile["kind"] =
      rawSource === "editor" ? "editor"
        : rawSource === "file" ? "file"
          : rawSource === "folder" ? "folder"
            : rawSource === "diagnostics" ? "diagnostics"
              : "terminal";
    const fallbackLabel =
      kind === "editor" ? "代码片段"
        : kind === "file" ? "文件"
          : kind === "folder" ? "文件夹"
            : kind === "diagnostics" ? "诊断"
              : "终端选区";
    const label = (msg as { label?: string }).label || fallbackLabel;
    const sizeRaw = (msg as { size?: number }).size;
    const size = typeof sizeRaw === "number" ? sizeRaw : text.length;
    const contextId = (msg as { contextId?: string }).contextId;
    if (contextId) {
      editorRef.current?.updateTag(contextId, { name: label, content: text, size, kind });
    } else {
      editorRef.current?.insertTag({ name: label, content: text, size, kind });
    }
    setComposerEmpty(editorRef.current?.isEmpty() ?? false);

    // 一键操作：解释 / 找 bug / 写测试 / 重构
    // ⚠️ 不能用 setText()：它会 clear dataMap，导致刚插入的代码 tag 丢失
    const quickAction = (msg as { quickAction?: string }).quickAction;
    if (quickAction) {
      const prompts: Record<string, string> = {
        explain: "请解释以下代码",
        findBug: "请帮我检查以下代码是否有bug",
        test: "请为以下代码写单元测试",
        refactor: "请重构以下代码，提高可读性和可维护性",
      };
      const prompt = prompts[quickAction];
      if (prompt) {
        editorRef.current?.appendText(prompt);
        setComposerEmpty(false);
        // 等 React 渲染完 tag 后再提交
        requestAnimationFrame(() => handleSendRef.current());
      }
    }
  }, [clientId]));

  // quickAction auto-send：handleSend 在 add_context 回调外定义，用 ref 桥接
  const handleSendRef = useRef(handleSend);
  handleSendRef.current = handleSend;
  // Skill Studio 整页接管
  if (skillStudioOpen) {
    return <SkillStudio workspace={session.workspace} onBack={() => setSkillStudioOpen(false)} />;
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* 消息列表 */}
      <div className="relative flex-1 min-h-0 flex flex-col px-3">
        {/* 顶部导航条：当前视图所属 AI 回答对应的用户提问，固定在消息列表上方（不浮动、不遮盖内容） */}
        {stickyQuestion && (
          <Popover open={questionListOpen} onOpenChange={setQuestionListOpen}>
            <div className={`flex items-center gap-1 shrink-0 ${questionListOpen ? "" : "shadow-[0_2px_4px_-1px_rgba(0,0,0,0.06)]"}`}>
              <button
                onClick={() => scrollToQuestion(stickyQuestion.id)}
                title="跳转到该提问"
                className="flex-1 min-w-0 flex items-center gap-1.5 px-3 py-2 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors"
              >
                <ChevronDown className="w-3.5 h-3.5 shrink-0 text-primary/70 -rotate-90" />
                <span className="truncate text-left">{stickyQuestion.text}</span>
              </button>
              <PopoverTrigger asChild>
                <button
                  title="查看所有用户问题"
                  className="p-2 shrink-0 text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors"
                >
                  <ListChecks className="w-3.5 h-3.5" />
                </button>
              </PopoverTrigger>
            </div>
            <PopoverContent
              align="start"
              side="bottom"
              sideOffset={0}
              collisionPadding={0}
              className="!w-[var(--radix-popover-content-available-width)] p-0 max-h-[50vh] flex flex-col rounded-none border-t-0 shadow-lg origin-top data-[state=open]:animate-in data-[state=open]:slide-in-from-top-1 data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:slide-out-to-top-1 data-[state=closed]:fade-out-0 duration-150"
            >
              <QuestionListPanel
                questions={session.chatHistory.filter((m) => m.role === "user").map((m) => ({
                  id: m.id,
                  text: questionTextById.get(m.id) || "",
                  timestamp: m.timestamp,
                  hasImage: !!(m.images && m.images.length > 0),
                  files: m.attachedFiles?.map((f) => f.name),
                }))}
                onSelect={(id) => { setQuestionListOpen(false); scrollToQuestion(id); }}
              />
            </PopoverContent>
          </Popover>
        )}
        {session.chatHistory.length === 0 ? (
          <>
            {/* 空历史占位 —— 独占整个 flex-1 区域，自然居中 */}
            {session.isLoadingSession ? (
              <div className="flex-1 flex items-center justify-center">
                <div className="text-center text-muted-foreground">
                  <Loader2 className="w-8 h-8 mx-auto mb-4 animate-spin text-primary/60" />
                  <p className="text-sm">会话历史加载中...</p>
                </div>
              </div>
            ) : (
              <div className="flex-1 flex items-center justify-center">
                <div className="text-center max-w-md px-6">
                  <AxonLogo size={64} className="mx-auto mb-4" />
                  {mode === "quest" ? (
                    <>
                      <p className="text-lg font-medium text-foreground">Axon · 问答</p>
                      <p className="text-sm text-muted-foreground mt-1 mb-6">概念、方案、答疑。我不会改你的代码。</p>
                    </>
                  ) : (
                    <>
                      <p className="text-lg font-medium text-foreground">Axon</p>
                      <p className="text-sm text-muted-foreground mt-1 mb-6">读写代码、执行命令、搜索项目、联网查询。</p>
                    </>
                  )}
                  <div className="bg-muted/40 rounded-xl px-5 py-4 text-left">
                    <p className="text-xs font-medium text-foreground mb-2.5">快速上手</p>
                    <div className="space-y-2">
                      {mode === "quest" ? (
                        <>
                          <div className="flex items-start gap-2.5">
                            <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-primary/10 text-[10px] font-bold text-primary shrink-0 mt-0.5">1</span>
                            <p className="text-xs text-muted-foreground leading-relaxed">直接提问：技术方案、概念解释、代码分析、架构建议</p>
                          </div>
                          <div className="flex items-start gap-2.5">
                            <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-primary/10 text-[10px] font-bold text-primary shrink-0 mt-0.5">2</span>
                            <p className="text-xs text-muted-foreground leading-relaxed">可开启「联网搜索」获取最新信息，或开启「思考过程」查看推理链</p>
                          </div>
                          <div className="flex items-start gap-2.5">
                            <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-primary/10 text-[10px] font-bold text-primary shrink-0 mt-0.5">3</span>
                            <p className="text-xs text-muted-foreground leading-relaxed">问答模式只回答问题，不会读写文件或执行命令</p>
                          </div>
                        </>
                      ) : (
                        <>
                          <div className="flex items-start gap-2.5">
                            <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-primary/10 text-[10px] font-bold text-primary shrink-0 mt-0.5">1</span>
                            <p className="text-xs text-muted-foreground leading-relaxed">打开项目文件夹（可绑定工作区组，管理多根目录）</p>
                          </div>
                          <div className="flex items-start gap-2.5">
                            <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-primary/10 text-[10px] font-bold text-primary shrink-0 mt-0.5">2</span>
                            <p className="text-xs text-muted-foreground leading-relaxed">用自然语言描述需求：改 bug、加功能、分析代码、写脚本……</p>
                          </div>
                          <div className="flex items-start gap-2.5">
                            <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-primary/10 text-[10px] font-bold text-primary shrink-0 mt-0.5">3</span>
                            <p className="text-xs text-muted-foreground leading-relaxed">Axon 会读文件 → 改代码 → 跑命令验证，全程自动推进</p>
                          </div>
                          <div className="flex items-start gap-2.5">
                            <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-primary/10 text-[10px] font-bold text-primary shrink-0 mt-0.5">4</span>
                            <p className="text-xs text-muted-foreground leading-relaxed">输入 <code className="px-1 py-0.5 rounded bg-muted text-[10px] font-mono">/</code> 引用当前文件、终端选区或编辑器诊断</p>
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </>
        ) : (
          <VirtualMessageList
            ref={virtualListRef}
            messages={session.chatHistory}
            estimateHeight={200}
            overscan={300}
            onScroll={stableOnScroll}
            onTopItemChange={handleTopItemChange}
            followOutput={false}
            initialBottom={!session.isLoadingSession && session.chatHistory.length > 0}
            header={
              !connected && session.chatHistory.length > 0 ? (
                <div className="flex items-center justify-center gap-2 py-2 px-4 rounded-lg bg-destructive/10 text-destructive text-xs">
                  <X className="w-3.5 h-3.5" />
                  连接已断开，请稍后重试
                </div>
              ) : undefined
            }
            footer={
              <>
                {session.reasoning && session.isLoading && <ReasoningBlock content={session.reasoning} />}
                <div ref={bottomRef} />
              </>
            }
            renderMessage={(msg, _idx) => (
              <CommandApprovalContext.Provider value={commandApprovalCtx}>
                <MessageBubble
                  message={msg as any}
                  onAcceptEdit={session.acceptEdits}
                  onRejectEdit={session.rejectEdits}
                  onUndoEdit={session.undoEdits}
                  onQuoteToInput={(qMsg) => {
                    if (qMsg.userSegments && qMsg.userSegments.length > 0) {
                      editorRef.current?.appendSegments(qMsg.userSegments);
                    } else if (qMsg.content) {
                      editorRef.current?.appendText(qMsg.content);
                    }
                    if (qMsg.images && qMsg.images.length > 0) setImages((prev) => [...prev, ...qMsg.images!]);
                    setComposerEmpty(editorRef.current?.isEmpty() ?? false);
                  }}
                  onImagePreview={setPreviewImage}
                />
              </CommandApprovalContext.Provider>
            )}
          />
          )}
        {/* Loading 指示器：放在 Virtuoso 外面，DOM 始终存在，动画不被重建打断。
            用 hidden 控制可见性而非条件渲染，保证 CSS animation 不中断。 */}
        <div className={`flex items-center gap-2.5 text-muted-foreground text-sm px-3 py-1 pb-2 ${session.isLoading ? "" : "hidden"}`}>
          <svg width="28" height="28" viewBox="0 0 40 40" className="shrink-0">
            {/* 呼吸灯光晕：纯色 + opacity 动画，不依赖 gradient id 引用 */}
            <circle cx="20" cy="20" r="17" fill="#6366f1" className="breath-origin" style={{ animation: "breath 2.5s ease-in-out infinite" }} />
            <circle cx="20" cy="20" r="13" fill="white" stroke="#1e1b4b" strokeWidth="1.5" />
            <ellipse cx="15" cy="19" rx="2" ry="2.5" fill="#6366f1" style={{ transformOrigin: "15px 19px", animation: "blink 3s ease-in-out infinite" }} />
            <ellipse cx="25" cy="19" rx="2" ry="2.5" fill="#6366f1" style={{ transformOrigin: "25px 19px", animation: "blink 3s ease-in-out 0.12s infinite" }} />
          </svg>
          <span className="animate-pulse">{session.statusText}</span>
        </div>
        <button
          onClick={animatedScrollToBottom}
          className={`absolute bottom-4 left-1/2 -translate-x-1/2 z-10 w-9 h-9 rounded-full bg-background border border-border shadow-md flex items-center justify-center text-muted-foreground hover:text-foreground hover:shadow-lg transition-all duration-200 ${showScrollBtn ? "opacity-100 translate-y-0 pointer-events-auto" : "opacity-0 translate-y-2 pointer-events-none"}`}
          title="滚动到底部"
          aria-label="滚动到底部"
        >
          <ChevronDown className="w-5 h-5" />
        </button>
      </div>

      {/* 输入区域 */}
      <div className="px-3 py-4">
        {/* 改动总览 + 闪电回滚（统一面板）—— 问答模式（quest）无文件编辑，不展示 */}
        {mode !== "quest" && (
        <AppliedChangesBar
            chatHistory={session.chatHistory}
            pendingPaths={session.pendingPaths}
            pendingDiffs={session.pendingDiffs}
            onAcceptAll={session.acceptEdits}
            onRejectAll={session.rejectEdits}
            onUndo={session.undoEdits}
            onListSnapshots={session.listSnapshots}
            onRestoreSnapshot={session.restoreSnapshot}
          />
        )}
        <div className="relative">
          {/* 斜杠命令菜单（贴输入框上方，置于 overflow-hidden 容器之外避免被裁剪） */}
          {slash.open && (
            <SlashCommandMenu
              mode={slash.mode}
              breadcrumb={slash.activeCommand?.label ?? null}
              commandItems={slash.commandItems}
              fallbackResults={slash.fallbackResults}
              results={slash.results}
              loading={slash.loading}
              activeIndex={slash.activeIndex}
              onHover={slash.setActiveIndex}
              onSelect={slash.selectAt}
              onRequestClose={slash.close}
            />
          )}
        <div
          className="border border-border rounded-xl overflow-hidden focus-within:ring-2 focus-within:ring-ring focus-within:border-transparent transition-all relative"
          onDrop={handleDrop}
          onDragOver={(e) => e.preventDefault()}
        >
          {/* 图片预览区 */}
          {images.length > 0 && (
            <div className="flex gap-2 px-4 pt-3 pr-12 flex-wrap">
              {images.map((img, i) => (
                <div key={i} className="relative group">
                  <img src={img} alt="" className="w-16 h-16 object-cover rounded-lg border border-border" />
                  <button
                    onClick={() => removeImage(i)}
                    className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-destructive text-destructive-foreground rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>
          )}
          {/* 文件 / 上下文预览区已移到输入框内，与输入文字同处一行（见下方内联 tag） */}
          {fileError && <div className="px-4 pt-2 text-xs text-destructive">{fileError}</div>}
          {/* 排队消息 */}
          {session.messageQueue.length > 0 && (
            <div className="px-3 pr-12 pt-2 pb-1 border-b border-border/40">
              <div className="text-[10px] text-muted-foreground/60 font-medium mb-1">排队中（当前回复结束后自动发送）</div>
              <div className="max-h-20 overflow-y-auto space-y-1">
                {session.messageQueue.map((q) => {
                  const ub = q.payload.userBubble;
                  const label = ub.content || (ub.attachedFiles && ub.attachedFiles.length > 0 ? `[${ub.attachedFiles.length} 个文件]` : "[图片]");
                  return (
                    <div key={q.id} className="flex items-center gap-2 px-2 py-1 rounded bg-muted/40 text-xs text-foreground/80">
                      <span className="flex-1 truncate">{label}</span>
                      <button
                        onClick={() => session.removeFromQueue(q.id)}
                        className="px-1.5 py-0.5 rounded text-[10px] text-muted-foreground hover:text-red-500 hover:bg-muted/60 shrink-0"
                        title="移除此条"
                      >
                        移除
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
          {/* 工具确认条 */}
          {session.toolConfirm && (
            <div className="flex items-center gap-2 px-3 py-2 bg-primary/5 border border-primary/20 rounded-lg mb-2">
              <ListChecks className="w-4 h-4 text-primary shrink-0" />
              <span className="text-xs flex-1 min-w-0 truncate">
                {session.toolConfirm.kind === "mcp"
                  ? `AI 请求调用 MCP 工具「${session.toolConfirm.title}」`
                  : `AI 建议创建 Relay 工作流「${session.toolConfirm.title}」`}
              </span>
              <button
                onClick={() => session.confirmTool(true)}
                className="px-2.5 py-1 rounded text-xs font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
              >
                确认
              </button>
              <button
                onClick={() => session.confirmTool(false)}
                className="px-2.5 py-1 rounded text-xs text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
              >
                跳过
              </button>
            </div>
          )}
          {/* 撤销失败轻提示（保守策略：文件未被改动）。3 秒后自动消失 */}
          {session.undoNotice && (
            <div className="flex items-start gap-2 px-3 py-2 bg-amber-50 dark:bg-amber-950/20 border border-amber-300/50 rounded-lg mb-2">
              <Undo2 className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
              <p className="flex-1 min-w-0 text-[11px] text-muted-foreground">{session.undoNotice.text}</p>
              <button
                onClick={() => session.setUndoNotice(null)}
                className="p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors shrink-0"
                title="关闭"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
          {/* 压缩选择弹窗：自动压缩触发时（>=75%），给用户选择继续或新会话 */}
          {session.compactionNeeded && (
            <div className="flex flex-col gap-2 px-3 py-3 bg-primary/5 border border-primary/30 rounded-lg mb-2">
              <div className="flex items-start gap-2">
                <span className="text-sm">⚠️</span>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium text-foreground">上下文已使用 {session.compactionNeeded.percent}%</p>
                  <p className="text-[11px] text-muted-foreground mt-0.5">
                    当前会话上下文已超过模型窗口的 75%，为保证回复质量建议压缩。请选择：
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2 justify-end">
                <button
                  onClick={() => session.chooseCompaction("new_session")}
                  className="px-3 py-1.5 rounded-md text-xs border border-border hover:bg-muted/60 transition-colors"
                >
                  在新会话中继续
                </button>
                <button
                  onClick={() => session.chooseCompaction("continue")}
                  className="px-3 py-1.5 rounded-md text-xs font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
                >
                  压缩并继续
                </button>
              </div>
            </div>
          )}
          {/* 会话已迁移提示：输入框不可用，引导跳转到新会话 */}
          {session.compactionMigrated && (
            <div className="flex flex-col gap-2 px-3 py-3 bg-muted/30 border border-border rounded-lg mb-2">
              <div className="flex items-start gap-2">
                <span className="text-sm">📋</span>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium text-foreground">当前会话已压缩并迁移</p>
                  <p className="text-[11px] text-muted-foreground mt-0.5">
                    记忆已压缩并应用到新会话中，AI 将在新会话中继续回复你的问题。
                  </p>
                </div>
              </div>
              <button
                onClick={() => session.navigateToMigratedSession(session.compactionMigrated!.newSessionId)}
                className="self-end px-3 py-1.5 rounded-md text-xs font-medium bg-primary/10 text-primary hover:bg-primary/20 transition-colors inline-flex items-center gap-1.5"
              >
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M9 4l5 4-5 4M14 8H3" /></svg>
                跳转到新会话
              </button>
            </div>
          )}
          {/* 危险命令被安全策略拦截：可关闭的警告横幅。
                dangerous 模式下提供"拒绝"和"仍要执行"两个选择；
                旧版（无 requestId）仅展示关闭按钮。 */}
          {session.commandBlocked && (
            <div className="flex items-start gap-2 px-3 py-2 bg-destructive/5 border border-destructive/20 rounded-lg mb-2">
              <ShieldAlert className="w-4 h-4 text-destructive shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium text-destructive">已拦截危险命令</p>
                <p className="text-[11px] text-muted-foreground mt-0.5 break-all font-mono">
                  {session.commandBlocked.command}
                </p>
                <p className="text-[11px] text-muted-foreground mt-0.5">原因：{session.commandBlocked.reason}</p>
              </div>
              {session.commandBlocked.dangerous && session.commandBlocked.requestId ? (
                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    onClick={() => session.respondToDangerousCommand(session.commandBlocked!.requestId!, false)}
                    className="px-2.5 py-1 rounded-md text-xs text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
                  >
                    拒绝
                  </button>
                  <button
                    onClick={() => session.respondToDangerousCommand(session.commandBlocked!.requestId!, true)}
                    className="px-2.5 py-1 rounded-md text-xs font-medium bg-destructive text-destructive-foreground hover:bg-destructive/90 transition-colors"
                  >
                    仍要执行
                  </button>
                </div>
              ) : (
                <button
                  onClick={session.dismissCommandBlocked}
                  className="p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors shrink-0"
                  title="关闭"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          )}
          {/* 命令信任授权改为内联在对应命令卡片下方（无感模式），见 ToolCallItem。此处不再用模态弹窗 */}
          {/* 输入框：contentEditable 富文本，tag 内联在光标处（MentionEditor） */}
          <div className="px-3 pr-10 pt-2 pb-1">
            <MentionEditor
              ref={editorRef}
              disabled={!connected}
              placeholder={connected ? (currentModelVision ? "给 Axon 发消息...（可粘贴或拖拽图片）" : "给 Axon 发消息...") : "等待连接..."}
              onChange={handleEditorChange}
              onKeyDown={(e) => {
                // 斜杠菜单优先消费方向键/回车/Esc，未消费时再走默认发送逻辑
                if (slash.handleKeyDown(e)) return;
                handleKeyDown(e);
              }}
              onPaste={handlePaste}
            />
          </div>
          {/* 底部工具栏 */}
          <div className="flex items-center justify-between px-2 pb-1.5">
            <div className="flex items-center gap-1">
              <ModelSelector
                value={session.model}
                onChange={handleModelChange}
                disabledModels={images.length > 0 ? models.filter((m) => !m.vision).map((m) => m.id) : []}
                disabled={session.isCompacting}
                disabledTooltip="压缩期间不可切换模型"
              />

              <Popover open={menuOpen} onOpenChange={setMenuOpen}>
                <PopoverTrigger asChild>
                  <button
                    className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
                    title="更多"
                  >
                    <Plus className="w-4 h-4" />
                  </button>
                </PopoverTrigger>
                <PopoverContent align="start" side="top" className="w-52 p-1 gap-0">
                  <button
                    onClick={() => { docInputRef.current?.click(); setMenuOpen(false); }}
                    className="flex items-center gap-2 w-full px-2 py-1.5 rounded-md text-xs hover:bg-muted/60 transition-colors text-left"
                  >
                    <Paperclip className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
                    <span className="flex-1">上传文件</span>
                    <span className="text-[10px] text-muted-foreground/60">≤256KB</span>
                  </button>
                  <button
                    onClick={() => { fileInputRef.current?.click(); setMenuOpen(false); }}
                    disabled={!currentModelVision}
                    className="flex items-center gap-2 w-full px-2 py-1.5 rounded-md text-xs hover:bg-muted/60 transition-colors text-left disabled:opacity-40 disabled:cursor-not-allowed"
                    title={currentModelVision ? "" : "当前模型不支持图片"}
                  >
                    <ImagePlus className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
                    <span className="flex-1">上传图片</span>
                  </button>
                  <button
                    onClick={() => { captureScreenshot(); setMenuOpen(false); }}
                    disabled={!currentModelVision}
                    className="flex items-center gap-2 w-full px-2 py-1.5 rounded-md text-xs hover:bg-muted/60 transition-colors text-left disabled:opacity-40 disabled:cursor-not-allowed"
                    title={currentModelVision ? "" : "当前模型不支持图片"}
                  >
                    <Camera className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
                    <span className="flex-1">截图</span>
                  </button>

                  <div className="my-0.5 border-t border-border" />

                  <div className="px-2 pt-1 pb-0.5 flex items-center gap-1.5 text-[10px] text-muted-foreground">
                    <Feather className="w-3 h-3" />
                    回复风格
                  </div>
                  {REPLY_STYLES.map((s) => (
                    <button
                      key={s.id}
                      onClick={() => { setReplyStyle(s.id); setMenuOpen(false); }}
                      className="flex items-center gap-2 w-full px-2 py-1 rounded-md text-xs hover:bg-muted/60 transition-colors text-left"
                    >
                      <span className="w-3.5 shrink-0 flex justify-center">
                        {replyStyle === s.id && <Check className="w-3 h-3 text-primary" />}
                      </span>
                      <span className="flex-1">{s.label}</span>
                      <span className="text-[10px] text-muted-foreground/60">{s.hint}</span>
                    </button>
                  ))}
                </PopoverContent>
              </Popover>

              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(e) => { if (e.target.files) addImages(e.target.files); e.target.value = ""; }}
              />
              <input
                ref={docInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={(e) => { if (e.target.files) addFiles(e.target.files); e.target.value = ""; }}
              />

              {replyStyle !== "default" && (
                <span className="ml-1 px-2 py-0.5 rounded-full bg-muted text-xs text-muted-foreground">
                  {REPLY_STYLES.find((s) => s.id === replyStyle)?.label}
                </span>
              )}
            </div>
            <div className="flex items-center gap-3">
              {mode === "quest" ? (
                <>
                  {/* Quest：思考开关 */}
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          onClick={() => session.setQuestThink(!session.questThink)}
                          className={`flex items-center gap-1.5 px-2 py-1 rounded-md text-xs transition-colors ${session.questThink ? "bg-primary/10 text-primary" : "text-muted-foreground hover:text-foreground hover:bg-muted/50"}`}
                        >
                          <Sparkles className="w-3.5 h-3.5" />
                          思考
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="top" align="end" className="max-w-[220px]">
                        <p className="text-xs text-muted-foreground">开启后展示模型的思考过程（reasoning）。</p>
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                  {/* Quest：联网搜索开关 */}
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          onClick={() => session.setQuestWebSearch(!session.questWebSearch)}
                          className={`flex items-center gap-1.5 px-2 py-1 rounded-md text-xs transition-colors ${session.questWebSearch ? "bg-primary/10 text-primary" : "text-muted-foreground hover:text-foreground hover:bg-muted/50"}`}
                        >
                          <Globe className="w-3.5 h-3.5" />
                          联网
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="top" align="end" className="max-w-[220px]">
                        <p className="text-xs text-muted-foreground">开启后允许联网搜索与抓取网页；关闭时仅基于模型知识作答。</p>
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                </>
              ) : (
                /* Agent：编辑模式开关 */
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        onClick={session.toggleEditMode}
                        className="flex items-center gap-1.5 px-2 py-1 rounded-md text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
                      >
                        <span className={`w-1.5 h-1.5 rounded-full ${session.editMode === "manual" ? "bg-amber-500" : "bg-green-500"}`} />
                        {session.editMode === "manual" ? "手动确认" : "自动应用"}
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="top" align="end" className="max-w-[240px] border-zinc-700 bg-zinc-900 text-white shadow-xl">
                      <p className="font-medium mb-0.5 text-white">代码改动应用方式</p>
                      <p className="text-xs text-zinc-200">
                        {session.editMode === "manual"
                          ? "当前：手动确认。AI 修改/创建文件后不会立即写入磁盘，需你点「接受」才生效。点击切换为自动应用。"
                          : "当前：自动应用。AI 修改/创建文件后立即写入磁盘。点击切换为手动确认。"}
                      </p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              )}
              <TokenIndicator used={session.tokenUsage.used} max={session.tokenUsage.max} cumulative={session.tokenUsage.cumulative} />
              {/* 压缩上下文按钮 */}
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      onClick={() => session.compactSession()}
                      disabled={session.isCompacting || session.isLoading || session.chatHistory.length < 6 || (session.tokenUsage.max > 0 && session.tokenUsage.used < session.tokenUsage.max * 0.35)}
                      className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                    >
                      <Minimize2 className="w-3.5 h-3.5" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top" align="end" className="max-w-[200px] border-zinc-700 bg-zinc-900 text-white shadow-xl">
                    <p className="text-xs text-zinc-200">{session.isCompacting ? "压缩进行中，不可操作" : session.tokenUsage.max > 0 && session.tokenUsage.used < session.tokenUsage.max * 0.35 ? "上下文未超过 35%，禁止手动压缩" : "压缩上下文"}</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
              {session.isLoading ? (
                <Button
                  size="sm"
                  onClick={() => session.cancelTurn(session.model)}
                  disabled={session.isCompacting}
                  className="h-7 w-7 rounded-full bg-destructive hover:bg-destructive/90 shrink-0 disabled:opacity-40"
                >
                  <X className="w-3.5 h-3.5" />
                </Button>
              ) : (
                <Button
                  size="sm"
                  onClick={handleSend}
                  disabled={!connected || (composerEmpty && images.length === 0) || !!session.compactionMigrated || session.isCompacting}
                  className="h-7 w-7 rounded-full shrink-0"
                >
                  <Send className="w-3.5 h-3.5" />
                </Button>
              )}
            </div>
          </div>
        </div>
        </div>
      </div>

      {/* 工作区选择弹窗 */}
      <WorkspacePicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        initialPath={session.workspace || undefined}
        onSelect={session.selectWorkspace}
      />

      {/* 工作区组管理弹窗 */}
      <WorkspaceGroupManager
        open={groupManagerOpen}
        onOpenChange={setGroupManagerOpen}
        onSelect={(group: WorkspaceGroup) => session.selectGroup(group)}
        onGroupUpdated={(group: WorkspaceGroup) => session.groupUpdated(group)}
      />

      {/* 图片预览 Modal */}
      <Dialog open={!!previewImage} onOpenChange={(open) => !open && setPreviewImage(null)}>
        <DialogContent className="max-w-[90vw] max-h-[90vh] p-2 bg-background/95 border-border shadow-xl flex flex-col items-center gap-2" showCloseButton={false}>
          {previewImage && (
            <>
              <img src={previewImage} alt="" className="max-w-full max-h-[80vh] object-contain rounded-lg" />
              <div className="flex items-center gap-2">
                <button
                  onClick={async (e) => {
                    const btn = e.currentTarget;
                    const setStatus = (text: string, ok: boolean) => {
                      btn.dataset.status = ok ? "ok" : "err";
                      const label = btn.querySelector("span");
                      if (label) label.textContent = text;
                      setTimeout(() => {
                        delete btn.dataset.status;
                        if (label) label.textContent = "复制图片";
                      }, 1800);
                    };
                    try {
                      const res = await fetch(previewImage);
                      const blob = await res.blob();
                      await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
                      setStatus("已复制", true);
                    } catch {
                      try {
                        const parts = previewImage.split(",");
                        const mime = parts[0].match(/:(.*?);/)?.[1] || "image/png";
                        const binary = atob(parts[1]);
                        const bytes = new Uint8Array(binary.length);
                        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
                        const blob = new Blob([bytes], { type: mime });
                        await navigator.clipboard.write([new ClipboardItem({ [mime]: blob })]);
                        setStatus("已复制", true);
                      } catch (err) {
                        setStatus("复制失败", false);
                        console.warn("[axon] 复制图片失败:", err);
                      }
                    }
                  }}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs bg-muted hover:bg-muted/80 text-foreground transition-colors data-[status=ok]:bg-green-500/15 data-[status=ok]:text-green-600 dark:data-[status=ok]:text-green-400 data-[status=err]:bg-red-500/15 data-[status=err]:text-red-600 dark:data-[status=err]:text-red-400"
                  title="复制图片到剪贴板"
                >
                  <Copy className="w-3.5 h-3.5" />
                  <span>复制图片</span>
                </button>
                <button
                  onClick={() => setPreviewImage(null)}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs bg-muted hover:bg-muted/80 text-muted-foreground transition-colors"
                >
                  <X className="w-3.5 h-3.5" />
                  关闭
                </button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

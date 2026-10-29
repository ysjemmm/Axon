/**
 * AskUserCard —— ask_user 工具的可交互问答卡片（内部排版参考 Claude 的选项卡片）
 *
 * - 独立卡片，渲染在输入框【上方】（不塞进输入框，避免"框套框"的圆角弧线）。
 * - 一次可含 1~N 个问题：顶部用「‹ 第 n / N 题 ›」步进器逐题作答，右上角 ✕ 可整体跳过。
 * - 选项行：左侧柔和编号徽标（多选时为勾选框），行间细分割线；
 *   选中行升级为"描边小卡 + 轻底 + 右侧箭头"，与未选中行拉开层级。
 * - 最后一行是铅笔图标的「其他（自己输入）」，底部提供「提交 / 跳过」。
 */

import { useEffect, useState } from "react";
import { ArrowRight, Check, ChevronLeft, ChevronRight, Pencil } from "lucide-react";

export interface AskUserQuestionData {
  question: string;
  options: { id: string; label: string; description?: string }[];
  /** true=多选（checkbox），false=单选（radio） */
  multi: boolean;
  /** 是否允许用户自己输入「其他」 */
  allowOther: boolean;
}

export interface AskUserRequestData {
  toolCallId: string;
  questions: AskUserQuestionData[];
}

export interface AskUserAnswerData {
  selected: string[];
  other?: string;
  skipped?: boolean;
}

export interface AskUserCardProps {
  request: AskUserRequestData;
  onAnswer: (answers: AskUserAnswerData[]) => void;
}

export function AskUserCard({ request, onAnswer }: AskUserCardProps) {
  const questions = request.questions;
  const total = questions.length;
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState<AskUserAnswerData[]>(() => questions.map(() => ({ selected: [] })));

  // 换了一次提问（新的 toolCallId）就重置步进与作答，避免残留上一次的选择。
  useEffect(() => {
    setStep(0);
    setAnswers(questions.map(() => ({ selected: [] })));
  }, [request.toolCallId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (total === 0) return null;
  const q = questions[Math.min(step, total - 1)];
  const ans = answers[step] ?? { selected: [] };
  const isOtherOn = ans.other !== undefined;

  const patchCurrent = (patch: Partial<AskUserAnswerData>) => {
    setAnswers((prev) => prev.map((a, i) => (i === step ? { ...a, ...patch } : a)));
  };

  const toggle = (id: string) => {
    if (q.multi) {
      const selected = ans.selected.includes(id) ? ans.selected.filter((x) => x !== id) : [...ans.selected, id];
      patchCurrent({ selected, skipped: false });
    } else {
      // 单选：选中已有选项就取消「自己输入」，两者只能留一个
      patchCurrent({ selected: [id], other: undefined, skipped: false });
      // 单选：选完自动进入下一题（最后一题则停留，等用户点提交）
      if (step < total - 1) {
        const from = step;
        setTimeout(() => setStep((s) => (s === from ? from + 1 : s)), 160);
      }
    }
  };

  const goto = (n: number) => setStep(Math.max(0, Math.min(total - 1, n)));

  const skipCurrent = () => {
    patchCurrent({ selected: [], other: undefined, skipped: true });
    if (step < total - 1) setStep(step + 1);
  };

  const submit = () => {
    // 未作答的问题一律按「跳过，由你决定」处理，保证每题都有明确交代。
    onAnswer(
      answers.map((a) => {
        const hasContent = a.selected.length > 0 || !!(a.other && a.other.trim());
        return hasContent ? a : { selected: [], skipped: true };
      }),
    );
  };

  // 选项最后一行的下标：用于决定是否还画底部分隔线
  const lastOptionIndex = q.options.length - 1;

  return (
    <div className="mb-2 rounded-xl border border-border bg-popover overflow-hidden">
      {/* 头部：问题 + 步进器 + 关闭 */}
      <div className="flex items-center gap-2 px-3.5 pt-2.5 pb-1.5">
        <span className="text-[13px] font-medium text-foreground flex-1 min-w-0 leading-4">{q.question}</span>
        {total > 1 && (
          <div className="flex items-center gap-0.5 shrink-0 text-muted-foreground">
            <button
              onClick={() => goto(step - 1)}
              disabled={step === 0}
              className="p-0.5 rounded hover:bg-muted/60 disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
              title="上一题"
            >
              <ChevronLeft className="w-3.5 h-3.5" />
            </button>
            <span className="text-[11px] tabular-nums px-0.5">{step + 1} of {total}</span>
            <button
              onClick={() => goto(step + 1)}
              disabled={step === total - 1}
              className="p-0.5 rounded hover:bg-muted/60 disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
              title="下一题"
            >
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
      </div>

      {/* 选项：未选中行之间用细分割线分隔；选中行升级为描边小卡 */}
      <div className="px-1.5 pb-1">
        {q.options.map((o, i) => {
          const on = ans.selected.includes(o.id);
          return (
            <button
              key={o.id}
              onClick={() => toggle(o.id)}
              className={`group w-full flex items-center gap-2.5 text-left px-2 py-1.5 transition-colors ${
                on
                  ? "rounded-lg border border-primary bg-primary/5"
                  : `border-b border-border/40 hover:bg-muted/40 ${i === lastOptionIndex ? "border-b-0" : ""}`
              }`}
            >
              {q.multi ? (
                <span
                  className={`shrink-0 w-6 h-6 rounded-md flex items-center justify-center transition-colors ${
                    on ? "bg-primary" : "bg-muted/70"
                  }`}
                >
                  <Check className={`w-3.5 h-3.5 ${on ? "text-primary-foreground" : "text-muted-foreground/30"}`} strokeWidth={3} />
                </span>
              ) : (
                <span
                  className={`shrink-0 w-6 h-6 rounded-md flex items-center justify-center text-[11px] font-medium transition-colors ${
                    on ? "bg-primary/15 text-primary" : "bg-muted/70 text-muted-foreground/70"
                  }`}
                >
                  {i + 1}
                </span>
              )}
              <span className="min-w-0 flex-1">
                <span className={`block text-xs leading-4 ${on ? "text-foreground" : "text-foreground/80"}`}>{o.label}</span>
                {o.description && (
                  <span className="block text-[11px] leading-4 text-muted-foreground/60">{o.description}</span>
                )}
              </span>
              {on && <ArrowRight className="w-3.5 h-3.5 text-muted-foreground/60 shrink-0" />}
            </button>
          );
        })}

        {/* 其他（自己输入） */}
        {q.allowOther && (
          <div
            className={`w-full flex items-center gap-2.5 px-2 py-1.5 transition-colors ${
              isOtherOn ? "rounded-lg border border-primary bg-primary/5" : "hover:bg-muted/40"
            }`}
          >
            <span className={`shrink-0 w-6 h-6 rounded-md flex items-center justify-center ${isOtherOn ? "bg-primary/15" : "bg-muted/70"}`}>
              <Pencil className={`w-3 h-3 ${isOtherOn ? "text-primary" : "text-muted-foreground/70"}`} />
            </span>
            {isOtherOn ? (
              <input
                autoFocus
                type="text"
                value={ans.other ?? ""}
                onChange={(e) => patchCurrent({ other: e.target.value, skipped: false })}
                placeholder="自己输入…"
                className="flex-1 min-w-0 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground/50"
                onKeyDown={(e) => {
                  // 中文输入法用 Enter 上屏候选词，这时 keydown 同样带 Enter。
                  // 不排掉它，轻则误跳题、重则把半句话直接提交出去。
                  if (e.nativeEvent.isComposing) return;
                  if (e.key !== "Enter") return;
                  e.preventDefault();
                  // 多题场景先逐题前进；已经到最后一题就等同于点「提交」——
                  // 省掉"打完字还要抬手去点按钮"这一步。submit 本身能处理未作答项
                  // （底部已注明"未作答的按「跳过」处理"），所以这里不必再判空。
                  if (step < total - 1) setStep(step + 1);
                  else submit();
                }}
              />
            ) : (
              <button
                // 单选时改为自己输入，就取消已选的选项
                onClick={() => patchCurrent(q.multi ? { other: "", skipped: false } : { other: "", selected: [], skipped: false })}
                className="flex-1 min-w-0 text-left text-xs text-muted-foreground/70 hover:text-foreground/80 transition-colors"
              >
                其他（自己输入）
              </button>
            )}
          </div>
        )}
      </div>

      {/* 底部操作 */}
      <div className="flex items-center gap-1.5 px-3.5 py-1.5 border-t border-border/40">
        <button
          onClick={submit}
          className="px-2 py-0.5 rounded text-[11px] font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
        >
          提交
        </button>
        <button
          onClick={skipCurrent}
          className="px-1.5 py-0.5 rounded text-[11px] text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
        >
          跳过
        </button>
        {total > 1 && (
          <span className="ml-auto text-[10px] text-muted-foreground/50">未作答的按「跳过」处理</span>
        )}
      </div>
    </div>
  );
}

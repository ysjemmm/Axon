/**
 * useMascotMood —— 把输入框的交互事件收敛成吉祥物的一个 mood。
 *
 * 为什么单独抽一个 hook：这些状态（有没有焦点、刚敲了什么键、静默多久）在 ChatPanel 里
 * 本来并不存在，混进那个已经很大的组件只会让它更难读；而 mood 的优先级判定是一处纯逻辑，
 * 抽出来还能单独测。
 *
 * 事件来源刻意选了最省侵入的一组：
 *  · focus / blur —— 挂在输入框外层容器上。React 的 onFocus/onBlur 底层是 focusin/focusout，
 *    会冒泡，所以不需要给 MentionEditor 加新的 props。
 *  · 键盘 —— 复用 ChatPanel 已经传给 MentionEditor 的 onKeyDown，只多读一次 e.key。
 *  · busy —— 直接用 session.isLoading。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { MascotMood } from "@/components/AxonMascot";

/** 一次按键之后，"正在打字/删除"这个状态保持多久（ms）。
 *  取 850ms：比正常连续击键的间隔长（不会打字打一半就切回 idle），又短到松手后很快平静下来。 */
const ACTIVITY_MS = 850;

/** 多久没有任何交互就打瞌睡（ms）。45s 足够长，正常阅读回复时不会误触发。 */
const SLEEP_MS = 45_000;

export type KeyActivity = "typing" | "deleting";

export interface MascotController {
  mood: MascotMood;
  /** 挂到输入框容器的 onFocus */
  onFocus: () => void;
  /** 挂到输入框容器的 onBlur */
  onBlur: () => void;
  /** 在 onKeyDown 里调用，传入按键事件即可（内部自行判定打字/删除/忽略） */
  noteKey: (key: string) => void;
}

/**
 * @param busy AI 是否正在生成（session.isLoading）
 */
export function useMascotMood(busy: boolean): MascotController {
  const [focused, setFocused] = useState(false);
  const [activity, setActivity] = useState<KeyActivity | null>(null);
  const [asleep, setAsleep] = useState(false);

  const activityTimer = useRef<number | null>(null);
  const sleepTimer = useRef<number | null>(null);

  /** 有交互 → 醒过来，并把打瞌睡的倒计时重新开始 */
  const wake = useCallback(() => {
    setAsleep(false);
    if (sleepTimer.current !== null) window.clearTimeout(sleepTimer.current);
    sleepTimer.current = window.setTimeout(() => setAsleep(true), SLEEP_MS);
  }, []);

  const noteKey = useCallback((key: string) => {
    // 只对"真的在改内容"的按键反应。
    // · length === 1 命中所有可打印字符，同时天然排除掉 Shift/Control/ArrowLeft 这些名字更长的键
    // · "Process" 是中文等 IME 组字期间浏览器给出的 key，漏掉它输入中文时吉祥物就不动了
    const kind: KeyActivity | null =
      key === "Backspace" || key === "Delete" ? "deleting"
      : key.length === 1 || key === "Process" || key === "Enter" ? "typing"
      : null;
    if (!kind) return;

    wake();
    setActivity(kind);
    if (activityTimer.current !== null) window.clearTimeout(activityTimer.current);
    activityTimer.current = window.setTimeout(() => setActivity(null), ACTIVITY_MS);
  }, [wake]);

  const onFocus = useCallback(() => {
    setFocused(true);
    wake();
  }, [wake]);

  const onBlur = useCallback(() => setFocused(false), []);

  // 首次挂载就开始倒计时；卸载时清掉两个 timer（否则切换会话/卸载后仍会 setState）
  useEffect(() => {
    sleepTimer.current = window.setTimeout(() => setAsleep(true), SLEEP_MS);
    return () => {
      if (sleepTimer.current !== null) window.clearTimeout(sleepTimer.current);
      if (activityTimer.current !== null) window.clearTimeout(activityTimer.current);
    };
  }, []);

  // AI 开始干活也算"有动静"：否则一个长任务跑完，吉祥物已经睡着了
  useEffect(() => {
    if (busy) wake();
  }, [busy, wake]);

  // 优先级：AI 在干活 > 手上正在改字 > 焦点在输入框 > 打瞌睡 > 空闲。
  // busy 放最前是因为它是"整个界面此刻在做什么"，比局部的输入状态更值得表达。
  const mood: MascotMood =
    busy ? "thinking"
    : activity === "deleting" ? "deleting"
    : activity === "typing" ? "typing"
    : focused ? "focused"
    : asleep ? "sleeping"
    : "idle";

  return { mood, onFocus, onBlur, noteKey };
}

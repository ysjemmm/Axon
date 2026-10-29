/**
 * 语音输入按钮：点一下开始录音，输入框右侧变成「✕ 波形 时长 ✓」的录音条；
 * 点 ✓ 停止并识别，文字插到光标处；点 ✕ 或按 Esc 丢弃。
 *
 * 录音在扩展进程里做（VS Code 的 webview 拿不到麦克风），这里只轮询音量画波形。
 * 只在 IDE 形态显示：浏览器形态的服务端没有录音接口。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Loader2, Mic, X } from "lucide-react";
import { startVoice, stopVoice, voiceLevels } from "@/lib/apiClient";

/** 波形显示多少根竖条（最新的在最右） */
const BARS = 28;
/** 轮询音量的间隔 */
const POLL_MS = 100;

type Phase = "idle" | "starting" | "recording" | "transcribing";

function formatSeconds(s: number): string {
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function openProviderSettings() {
  (window as { __axonVSCode?: { postMessage: (m: unknown) => void } }).__axonVSCode?.postMessage({ type: "open_provider" });
}

export function VoiceInputButton({ onText, onError, disabled }: {
  /** 识别出的文字 */
  onText: (text: string) => void;
  onError: (message: string) => void;
  disabled?: boolean;
}) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [levels, setLevels] = useState<number[]>(() => Array(BARS).fill(0));
  const [seconds, setSeconds] = useState(0);
  const phaseRef = useRef<Phase>("idle");
  phaseRef.current = phase;

  // 录音中轮询音量；扩展那边自动停了（到时长上限）就当作点了 ✓
  useEffect(() => {
    if (phase !== "recording") return;
    let stopped = false;
    const timer = setInterval(async () => {
      try {
        const r = await voiceLevels();
        if (stopped) return;
        if (!r.recording) { void finish(false); return; }
        setSeconds(r.seconds);
        if (r.levels.length) setLevels((prev) => [...prev, ...r.levels].slice(-BARS));
      } catch { /* 偶发失败不打断录音 */ }
    }, POLL_MS);
    return () => { stopped = true; clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  const start = useCallback(async () => {
    if (phaseRef.current !== "idle") return;
    setPhase("starting");
    setLevels(Array(BARS).fill(0));
    setSeconds(0);
    try {
      const r = await startVoice();
      if (r.needsConfig) {
        setPhase("idle");
        onError("先在「模型 Provider」里选一个语音识别服务，再来录音");
        openProviderSettings();
        return;
      }
      setPhase("recording");
    } catch (err) {
      setPhase("idle");
      onError((err as Error).message || "麦克风没有打开");
    }
  }, [onError]);

  const finish = useCallback(async (cancel: boolean) => {
    if (phaseRef.current !== "recording") return;
    setPhase(cancel ? "idle" : "transcribing");
    try {
      const r = await stopVoice(cancel);
      if (!cancel) {
        const text = (r.text || "").trim();
        if (text) onText(text);
        else if (r.needsConfig) onError("语音识别服务没有配置");
        else onError("没有识别出文字，再说一次试试");
      }
    } catch (err) {
      if (!cancel) onError((err as Error).message || "语音识别失败");
    } finally {
      setPhase("idle");
    }
  }, [onText, onError]);

  // Esc 丢弃录音
  useEffect(() => {
    if (phase !== "recording") return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); void finish(true); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [phase, finish]);

  // 卸载时还在录就丢掉
  useEffect(() => () => { if (phaseRef.current === "recording") void stopVoice(true).catch(() => undefined); }, []);

  if (phase === "recording" || phase === "transcribing") {
    const busy = phase === "transcribing";
    return (
      <div className="flex h-7 items-center gap-1 rounded-full bg-muted/70 pl-1 pr-1 animate-in fade-in-0 zoom-in-95 duration-150">
        <button
          type="button"
          onClick={() => void finish(true)}
          disabled={busy}
          title="丢弃录音（Esc）"
          aria-label="丢弃录音"
          className="inline-flex h-5 w-5 items-center justify-center rounded-full text-muted-foreground hover:bg-background hover:text-foreground disabled:opacity-40"
        >
          <X className="h-3.5 w-3.5" />
        </button>
        <span className="flex h-4 items-center gap-[2px] px-1" aria-hidden>
          {levels.map((lv, i) => (
            <span
              key={i}
              className={`w-[2px] rounded-full transition-[height] duration-100 ${busy ? "bg-muted-foreground/30" : "bg-foreground/60"}`}
              style={{ height: `${Math.max(2, Math.round(lv * 16))}px` }}
            />
          ))}
        </span>
        <span className="w-8 text-center text-[11px] tabular-nums text-muted-foreground">
          {busy ? "识别中" : formatSeconds(seconds)}
        </span>
        <button
          type="button"
          onClick={() => void finish(false)}
          disabled={busy}
          title="完成，转成文字"
          aria-label="完成录音"
          className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-foreground text-background hover:opacity-90 disabled:opacity-60"
        >
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
        </button>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => void start()}
      disabled={disabled || phase === "starting"}
      title="语音输入"
      aria-label="语音输入"
      className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
    >
      {phase === "starting" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Mic className="h-3.5 w-3.5" />}
    </button>
  );
}

/**
 * 语音输入按钮：点一下开始录音，输入框右侧变成「✕ 波形 时长 ✓」的录音条；
 * 说完停顿一下自动识别（也可以点 ✓ 提前结束），文字插到光标处；点 ✕ 或按 Esc 丢弃。
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
/** 每个音量点代表的时长（扩展那边 80ms 算一个点） */
const LEVEL_MS = 80;
/** 说过话之后，安静这么久就自动结束并识别 */
const END_SILENCE_MS = 1500;
/** 至少说了这么久才算「说过话」，免得咳嗽一声就触发 */
const MIN_SPEECH_MS = 300;
/** 一直没听到说话就自动放弃 */
const NO_SPEECH_GIVE_UP_MS = 10_000;

/**
 * 简单的说话检测：开头 0.5 秒估出环境底噪，比底噪明显高的算在说话。
 * 音量刻度是扩展换算好的 0~1（-55dB~-5dB），正常说话大约 0.4~0.8，安静环境 0.1 上下。
 */
interface VadState { totalMs: number; speechMs: number; silenceMs: number; floor: number; floorSamples: number }
const newVad = (): VadState => ({ totalMs: 0, speechMs: 0, silenceMs: 0, floor: 0, floorSamples: 0 });

/** 喂一个音量点，返回该做什么 */
function feedVad(v: VadState, level: number): "continue" | "finish" | "give-up" {
  v.totalMs += LEVEL_MS;
  // 底噪取开头 0.5 秒里的最小值：一开口就说话时，用平均值会把说话声也算进底噪
  if (v.totalMs <= 500) {
    v.floor = v.floorSamples === 0 ? level : Math.min(v.floor, level);
    v.floorSamples++;
  }
  // 底噪封顶 0.35：一开口就说话时，开头那 0.5 秒全是人声，不封顶会把阈值抬到说话声之上
  const threshold = Math.max(0.3, Math.min(v.floor, 0.35) + 0.15);
  if (level >= threshold) {
    v.speechMs += LEVEL_MS;
    v.silenceMs = 0;
  } else {
    v.silenceMs += LEVEL_MS;
  }
  if (v.speechMs >= MIN_SPEECH_MS && v.silenceMs >= END_SILENCE_MS) return "finish";
  if (v.speechMs < MIN_SPEECH_MS && v.totalMs >= NO_SPEECH_GIVE_UP_MS) return "give-up";
  return "continue";
}

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
  const vadRef = useRef<VadState>(newVad());
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
        // 说完停顿一下就自动识别；一直没说话就放弃
        for (const lv of r.levels) {
          const act = feedVad(vadRef.current, lv);
          if (act === "finish") { void finish(false); return; }
          if (act === "give-up") {
            void finish(true);
            onError("没有听到说话声。检查一下麦克风，或者靠近一点再试。");
            return;
          }
        }
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
    vadRef.current = newVad();
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
        <span className="min-w-8 whitespace-nowrap px-0.5 text-center text-[11px] tabular-nums text-muted-foreground">
          {busy ? "识别中" : formatSeconds(seconds)}
        </span>
        <button
          type="button"
          onClick={() => void finish(false)}
          disabled={busy}
          title="说完停顿一下会自动识别；也可以点这里提前结束"
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

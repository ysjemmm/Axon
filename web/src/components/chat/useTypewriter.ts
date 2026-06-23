/**
 * useTypewriter —— 打字机效果 hook（从 useChatSession 拆出）
 *
 * 封装流式文本的 buffer + RAF 逐帧出字逻辑。
 * buffer 积压越多出字越快（比例出字），收尾阶段（stream_end）加速排空。
 */

import { useRef, useCallback } from "react";
import type { TextSegment } from "./types";
import type { EventHandlerCtx } from "./eventHandlers/types";

export interface TypewriterApi {
  buffer: React.MutableRefObject<string>;
  raf: React.MutableRefObject<number | null>;
  streamEnding: React.MutableRefObject<{ elapsed: number; tokens: number } | null>;
  /** 启动打字机 RAF 循环（stream_start 时调用） */
  start: (ctx: EventHandlerCtx) => void;
  /** 停止 RAF + 清空 buffer（取消/暂停时调用） */
  cancel: () => void;
  /** flush buffer 中残留的内容到 text segment（stream_end 无 RAF 时调用） */
  flushRemaining: (ctx: EventHandlerCtx) => void;
}

export function useTypewriter(): TypewriterApi {
  const buffer = useRef<string>("");
  const raf = useRef<number | null>(null);
  const streamEnding = useRef<{ elapsed: number; tokens: number } | null>(null);

  const start = useCallback((ctx: EventHandlerCtx) => {
    if (raf.current) cancelAnimationFrame(raf.current);
    streamEnding.current = null;

    const typewriterTick = () => {
      if (buffer.current.length > 0) {
        const len = buffer.current.length;
        const ratio = streamEnding.current ? 0.3 : 0.15;
        let batchSize = Math.min(streamEnding.current ? 300 : 150, Math.max(1, Math.ceil(len * ratio)));
        // Unicode 安全切片：避免切断代理对（emoji 等）
        if (batchSize < buffer.current.length) {
          const lastCode = buffer.current.charCodeAt(batchSize - 1);
          if (lastCode >= 0xD800 && lastCode <= 0xDBFF) batchSize++;
        }
        const batch = buffer.current.slice(0, batchSize);
        buffer.current = buffer.current.slice(batchSize);

        ctx.setChatHistory((prev) => {
          const updated = [...prev];
          const last = updated[updated.length - 1];
          if (last?.role === "assistant" && last.segments) {
            const segs = [...last.segments];
            let textIdx = -1;
            for (let i = segs.length - 1; i >= 0; i--) {
              if (segs[i].type === "text") { textIdx = i; break; }
            }
            if (textIdx >= 0) {
              const textSeg = segs[textIdx];
              segs[textIdx] = { type: "text" as const, content: (textSeg as any).content + batch } as TextSegment;
            }
            updated[updated.length - 1] = { ...last, segments: segs };
          }
          return updated;
        });
        raf.current = requestAnimationFrame(typewriterTick);
        return;
      }

      if (streamEnding.current) {
        const stats = streamEnding.current;
        streamEnding.current = null;
        raf.current = null;
        const finalFlush = buffer.current;
        buffer.current = "";
        ctx.setChatHistory((prev) => {
          const updated = [...prev];
          const last = updated[updated.length - 1];
          if (last?.role === "assistant") {
            if (finalFlush && last.segments) {
              const segs = [...last.segments];
              let textIdx = -1;
              for (let i = segs.length - 1; i >= 0; i--) {
                if (segs[i].type === "text") { textIdx = i; break; }
              }
              if (textIdx >= 0) {
                const textSeg = segs[textIdx];
                segs[textIdx] = { type: "text" as const, content: (textSeg as any).content + finalFlush } as TextSegment;
              }
              updated[updated.length - 1] = { ...last, segments: segs, streaming: false, turnStats: stats, turnStatus: "success" };
            } else {
              updated[updated.length - 1] = { ...last, streaming: false, turnStats: stats, turnStatus: "success" };
            }
          }
          return updated;
        });
        ctx.finishLoading();
        return;
      }
      raf.current = requestAnimationFrame(typewriterTick);
    };

    raf.current = requestAnimationFrame(typewriterTick);
  }, []);

  const cancel = useCallback(() => {
    buffer.current = "";
    streamEnding.current = null;
    if (raf.current) {
      cancelAnimationFrame(raf.current);
      raf.current = null;
    }
  }, []);

  const flushRemaining = useCallback((ctx: EventHandlerCtx) => {
    const remaining = buffer.current;
    buffer.current = "";
    if (remaining) {
      ctx.setChatHistory((prev) => {
        const updated = [...prev];
        const last = updated[updated.length - 1];
        if (last?.role === "assistant" && last.segments) {
          const segs = [...last.segments];
          // 反向查找最后一个 text segment（stream_pause 到达时末尾可能是 tool segment）
          let textIdx = -1;
          for (let i = segs.length - 1; i >= 0; i--) {
            if (segs[i].type === "text") { textIdx = i; break; }
          }
          if (textIdx >= 0) {
            const textSeg = segs[textIdx];
            segs[textIdx] = { type: "text" as const, content: (textSeg as any).content + remaining } as TextSegment;
          }
          updated[updated.length - 1] = { ...last, segments: segs };
        }
        return updated;
      });
    }
  }, []);

  return { buffer, raf, streamEnding, start, cancel, flushRemaining };
}

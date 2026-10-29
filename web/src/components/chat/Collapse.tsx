/**
 * 展开 / 收起的内容区（工具折叠组、思考过程、命令详情等共用）。
 *
 * 早先用 grid-template-rows 0fr → 1fr 做高度动画：每一帧都要重新排版整块内容
 * （一个折叠组里常有几十张工具卡片，收起时也全部挂着），消息列表的虚拟滚动还要每帧重新量高、
 * 校正位置——展开收起一下就明显卡顿。
 *
 * 现在：
 *   · 内容在浏览器空闲时提前挂好（隐藏着）：不拖慢消息首屏，点开时也不用当场渲染几十张卡片；
 *     挂载后收起只是隐藏，卡片自己的展开状态保留
 *   · 高度一步到位，只给内容做一次淡入 + 轻微下移（只动 opacity / transform，不触发逐帧排版）
 *   · 收起立即生效
 */

import { useEffect, useState, type ReactNode } from "react";

type IdleWindow = Window & { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number; cancelIdleCallback?: (id: number) => void };

export function Collapse({ open, children }: { open: boolean; children: ReactNode }) {
  const [mounted, setMounted] = useState(open);
  // 渲染期调整状态：还没预挂好就被点开，当场挂载
  if (open && !mounted) setMounted(true);
  useEffect(() => {
    if (mounted) return;
    const w = window as IdleWindow;
    if (w.requestIdleCallback) {
      const id = w.requestIdleCallback(() => setMounted(true), { timeout: 3000 });
      return () => w.cancelIdleCallback?.(id);
    }
    const timer = setTimeout(() => setMounted(true), 300);
    return () => clearTimeout(timer);
  }, [mounted]);
  if (!mounted) return null;
  return (
    <div hidden={!open} aria-hidden={!open} className={open ? "animate-collapse-in" : undefined}>
      {children}
    </div>
  );
}

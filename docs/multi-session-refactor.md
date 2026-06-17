# 多会话并发重构方案

## 一、问题描述

当前 Axon 侧栏 webview 只有一个 `ChatPanel` 实例，切换会话时整个组件被销毁重建。导致：
- 正在流式输出的会话切走后，前端打字机状态丢失
- 切回时只能从持久化快照恢复（不包含未 commit 的流式内容），表现为"回复消失"
- 即使后端 agent loop 继续运行并 persist 了完整结果，前端也无法实时衔接

## 二、目标

- **切走不中断**：后台会话的 agent loop 和流式输出完全不受影响
- **切回无缝恢复**：RUNNING 的会话切回后，打字机继续跑（跟从没切走一样）
- **内存可控**：已完成的会话销毁组件实例，切回时从持久化重建

## 三、整体架构

```
App.tsx
├── TabBar（会话 tab 栏，已有）
└── SessionContainer（新增：管理多个 ChatPanel 实例的生命周期）
    ├── ChatPanel[session-A]  visible=true   ← 当前展示
    ├── ChatPanel[session-B]  visible=false  ← RUNNING，display:none 保留实例
    └── （session-C 已完成，无实例，切回时从持久化重建）
```

### 核心原则

1. **per-session 事件分发**：后端所有 AgentEvent 携带 `sessionId`，前端 ws handler 按 sessionId 路由到对应 ChatPanel
2. **RUNNING 实例保活**：只要 session 处于 streaming/tool-executing 状态，其 ChatPanel 实例不 unmount，仅 CSS 隐藏
3. **IDLE 实例按需销毁**：session 完成后（stream_end + 无 pending tool），延迟一段时间后 unmount 释放内存
4. **切回已完成会话**：重新 mount ChatPanel + load_session 从持久化恢复

## 四、工作区与文件位置

| 工作区 | 路径 | 说明 |
|--------|------|------|
| Axon monorepo | `d:\projects\Axon` | Agent 内核 + Web 前端 + VS Code 扩展 |
| axon-ide-shell | `d:\projects\axon-ide-shell` | VS Code fork（IDE shell） |

### 需要改动的文件

| 文件 | 工作区 | 改动类型 |
|------|--------|----------|
| `packages/core/src/channel/events.ts` | Axon | 修改：AgentEvent 增加 sessionId |
| `packages/core/src/session/sessionHub.ts` | Axon | 修改：SessionChannel emit 时注入 sessionId |
| `web/src/App.tsx` | Axon | 修改：引入 SessionContainer 替代直接渲染 ChatPanel |
| `web/src/components/SessionContainer.tsx` | Axon | **新增**：多实例管理器 |
| `web/src/components/ChatPanel.tsx` | Axon | 修改：接收 per-session 事件流，不再自己持有 ws |
| `web/src/hooks/useWebSocket.ts` | Axon | 修改：提升到 App 级别，提供 subscribe(sessionId) 能力 |
| `web/src/hooks/useSessionEvents.ts` | Axon | **新增**：per-session 事件订阅 hook |

## 五、详细设计

### 5.1 协议层：AgentEvent 增加 sessionId

```typescript
// packages/core/src/channel/events.ts
// 所有 AgentEvent 联合类型的每个分支增加可选 sessionId：
export type AgentEvent =
  | { type: "stream_start"; sessionId?: string }
  | { type: "stream_delta"; content: string; sessionId?: string }
  // ... 所有类型同理
```

### 5.2 后端：SessionChannel 注入 sessionId

```typescript
// packages/core/src/session/sessionHub.ts
class SessionChannel implements AgentChannel {
  emit(event: AgentEvent): void {
    // 每个事件打上 sessionId 标签后转发给真实 channel
    const tagged = { ...event, sessionId: this.sessionId };
    this.realChannel.emit(tagged as AgentEvent);
  }
}
```

不再做 event buffer / drainBuffer / replay —— 所有事件实时转发，前端按 sessionId 分发。

### 5.3 前端：事件分发总线

```typescript
// web/src/hooks/useSessionEvents.ts
import { useEffect, useRef } from "react";
import type { WsMessage } from "./useWebSocket";

type Handler = (msg: WsMessage) => void;

/** 全局事件总线：按 sessionId 分发 ws 消息 */
class SessionEventBus {
  private handlers = new Map<string, Set<Handler>>();
  
  subscribe(sessionId: string, handler: Handler): () => void {
    let set = this.handlers.get(sessionId);
    if (!set) {
      set = new Set();
      this.handlers.set(sessionId, set);
    }
    set.add(handler);
    return () => { set!.delete(handler); };
  }

  dispatch(msg: WsMessage): void {
    const sid = (msg as any).sessionId as string | undefined;
    if (!sid) {
      // 无 sessionId 的全局事件（token_usage、workspace_set 等）广播给所有
      for (const handlers of this.handlers.values()) {
        handlers.forEach(h => h(msg));
      }
      return;
    }
    const handlers = this.handlers.get(sid);
    if (handlers) {
      handlers.forEach(h => h(msg));
    }
  }
}

export const sessionEventBus = new SessionEventBus();

/** Hook：订阅指定 sessionId 的事件流 */
export function useSessionEvents(sessionId: string | null, handler: Handler): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  
  useEffect(() => {
    if (!sessionId) return;
    return sessionEventBus.subscribe(sessionId, (msg) => handlerRef.current(msg));
  }, [sessionId]);
}
```

### 5.4 前端：SessionContainer 组件

```typescript
// web/src/components/SessionContainer.tsx
interface ManagedSession {
  sessionId: string | null;
  status: "running" | "idle";
  /** idle 后的销毁计时器 */
  idleTimer?: ReturnType<typeof setTimeout>;
}

/**
 * 管理多个 ChatPanel 实例的生命周期：
 * - 当前 tab 的 ChatPanel 始终存在且 visible
 * - RUNNING 状态的其他 session 的 ChatPanel 保留（display:none）
 * - IDLE 状态的 session 延迟 30s 后 unmount
 */
export function SessionContainer({ tabs, activeIndex, onSessionCreated }) {
  const [managedSessions, setManagedSessions] = useState<Map<string, ManagedSession>>();
  
  // 渲染逻辑：
  // 1. 当前 activeIndex 对应的 tab → visible ChatPanel
  // 2. managedSessions 中 status=running 且不是当前 tab → hidden ChatPanel
  // 3. 其余不渲染
  
  return (
    <>
      {Array.from(instances).map(([key, session]) => (
        <div
          key={key}
          style={{ display: key === currentKey ? "block" : "none" }}
          className="absolute inset-0"
        >
          <ChatPanel
            sessionId={session.sessionId}
            onSessionCreated={...}
            onStreamingChange={(streaming) => updateSessionStatus(key, streaming)}
          />
        </div>
      ))}
    </>
  );
}
```

### 5.5 ChatPanel 改造

关键改动：
1. 不再自己调 `useWebSocket` —— 改为通过 `useSessionEvents(sessionId, handler)` 订阅
2. 新增 `onStreamingChange: (streaming: boolean) => void` prop，通知 SessionContainer 自己的流式状态
3. `send` 方法从 props 或 context 传入（App 级别持有 ws 连接）
4. 移除 `useEffect([connected, sessionId])` 中的 load_session 逻辑 —— 改为 mount 时发一次

### 5.6 App.tsx 改造

```typescript
function App() {
  // ws 连接提升到 App 级别（所有 ChatPanel 共享）
  const { connected, send } = useWebSocket(WS_BASE, (msg) => {
    sessionEventBus.dispatch(msg); // 统一分发
  });
  
  return (
    <div>
      <TabBar ... />
      <SessionContainer
        tabs={tabs}
        activeIndex={activeIndex}
        connected={connected}
        send={send}
        onSessionCreated={handleSessionCreated}
      />
    </div>
  );
}
```

## 六、后端 SessionHub 改动

当前 `SessionHub` 已支持多会话并发（`activeSessions` Map）。需要的改动：

1. **移除 SessionChannel 的 event buffer / drainBuffer 逻辑** —— 不再缓冲，所有事件实时转发
2. **SessionChannel.emit 注入 sessionId** —— 前端按此路由
3. **移除 `isStreaming` / `streamedContent` 等 session_loaded 补丁字段** —— 不再需要，因为 RUNNING session 的 ChatPanel 实例根本没销毁

`load_session` 仍然需要：用于从持久化恢复已完成会话的历史（IDLE session 切回时）。

## 七、状态流转

```
[新建 tab] → mount ChatPanel → send("load_session" 或等用户输入) → IDLE
     ↓ 用户发消息
[stream_start 到达] → status = RUNNING
     ↓ 用户切走
[ChatPanel display:none] → 打字机继续跑（DOM 在但不可见）
     ↓ 用户切回
[ChatPanel display:block] → 用户看到实时进度（跟没切走一样）
     ↓ stream_end 到达
[status = IDLE] → 延迟 30s → unmount ChatPanel（释放内存）
     ↓ 用户再次切回
[重新 mount] → send("load_session") → 从持久化恢复完整历史
```

## 八、构建与部署

### 8.1 构建顺序

```bash
# 1. 构建 @axon/core（TypeScript → dist/）
cd d:\projects\Axon\packages\core
pnpm run build

# 2. 构建前端 webview（Vite build → dist/）并拷贝到扩展 media
cd d:\projects\axon-ide-shell\extensions\axon-ide
node scripts/copy-web.mjs

# 3. 构建扩展 JS bundle（esbuild → dist/extension.js）
cd d:\projects\axon-ide-shell\extensions\axon-ide
pnpm run build
```

### 8.2 验证

重启 VS Code（axon-ide-shell），打开 Axon 侧栏面板：
1. Tab A 问长问题（1000 字作文）
2. 回复流式输出到一半时，点 + 新建 Tab B
3. 在 B 中问个短问题
4. 切回 Tab A → 应该看到 A 还在打字（从切走那刻继续）
5. 等 A 完成 → 30s 后 A 的 ChatPanel 实例被静默 unmount（用户无感）
6. 再切回 A → 从持久化快照恢复完整历史

### 8.3 关键注意事项

- `extensions/axon-ide` 是 symlink → `d:\projects\Axon\apps\vscode-extension`
- `@axon/core` 通过 pnpm workspace link 被扩展和 web 引用
- webview 的 CSP 限制：前端只能通过 postMessage 与 extension host 通信
- VS Code webview 形态下 `useWebSocket` 的底层是 `postMessage`，不是真 ws

## 九、回滚清理

实施前需要回滚当前临时修复：
- `SessionHub` 中的 `SessionChannel` event buffer/drainBuffer 逻辑 → 改为纯注入 sessionId 转发
- `ChatPanel` 中的 `isStreaming`/`streamedContent` 处理 → 删除（RUNNING 实例不销毁，无需恢复）
- `ChatPanel` 的 `useEffect([connected, sessionId])` → 改为 mount 时一次性 load

## 十、性能与边界

- **内存**：最多同时保留 N 个 RUNNING ChatPanel（实际上用户很少同时跑 3+ 个并行 agent）
- **DOM 开销**：hidden 的 ChatPanel 不触发布局/重绘（`display: none`），但 React 虚拟 DOM 仍在
- **边界**：如果用户关闭一个 RUNNING tab → 应该 cancel 该 session 的 agent loop（现有 cancel 逻辑）
- **ws 断线重连**：已有机制，重连后所有 managed ChatPanel 需重新 load_session（RUNNING 的从 cache 恢复，IDLE 的从持久化恢复）

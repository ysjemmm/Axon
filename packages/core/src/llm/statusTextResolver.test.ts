import { describe, expect, it } from "vitest";
import {
  ExplicitTextResolver,
  ActionStatusResolver,
  RenderStatusResolver,
  DefaultStatusResolver,
  FallbackStatusResolver,
  resolveStatusText,
  buildStatusEvent,
  type StatusResolveContext,
} from "./index.js";

/** 构造一个最小合法的状态解析上下文，测试时按需覆盖字段。 */
function ctx(partial: Partial<StatusResolveContext>): StatusResolveContext {
  return {
    requestId: "req-1",
    phase: "acting",
    code: "thinking",
    ...partial,
  };
}

describe("ExplicitTextResolver", () => {
  it("显式 text 存在时应命中并终止链路", () => {
    const r = new ExplicitTextResolver().resolve(ctx({ text: "自定义文案" }));
    expect(r).toEqual({ matched: true, resolver: "explicit", text: "自定义文案", stop: true });
  });

  it("显式 text 为空白时应放行给下一节点", () => {
    const r = new ExplicitTextResolver().resolve(ctx({ text: "   " }));
    expect(r).toEqual({ matched: false, resolver: "explicit" });
  });

  it("未提供 text 时应放行", () => {
    const r = new ExplicitTextResolver().resolve(ctx({}));
    expect(r.matched).toBe(false);
  });
});

describe("ActionStatusResolver", () => {
  it("search_workspace 应给出固定文案", () => {
    const r = new ActionStatusResolver().resolve(ctx({ code: "search_workspace" }));
    expect(r).toMatchObject({ matched: true, resolver: "action", text: "搜索工作区" });
  });

  it("read_file 带 target 时应拼上目标", () => {
    const r = new ActionStatusResolver().resolve(ctx({ code: "read_file", target: "a.ts" }));
    expect(r).toMatchObject({ matched: true, text: "读取 a.ts" });
  });

  it("read_file 无 target 时应回退到通用文案", () => {
    const r = new ActionStatusResolver().resolve(ctx({ code: "read_file" }));
    expect(r).toMatchObject({ matched: true, text: "读取文件" });
  });

  it("edit_file 与 apply_patch 都应走编辑文案", () => {
    const edit = new ActionStatusResolver().resolve(ctx({ code: "edit_file", target: "b.ts" }));
    const patch = new ActionStatusResolver().resolve(ctx({ code: "apply_patch", target: "b.ts" }));
    expect(edit).toMatchObject({ matched: true, text: "编辑 b.ts" });
    expect(patch).toMatchObject({ matched: true, text: "编辑 b.ts" });
  });

  it("非动作类 code 应放行", () => {
    const r = new ActionStatusResolver().resolve(ctx({ code: "thinking" }));
    expect(r.matched).toBe(false);
  });
});

describe("RenderStatusResolver", () => {
  it("render_mermaid 应给出绘制节点文案", () => {
    const r = new RenderStatusResolver().resolve(ctx({ code: "render_mermaid" }));
    expect(r).toMatchObject({ matched: true, resolver: "render", text: "正在绘制节点..." });
  });

  it("summarizing 应给出整理结论文案", () => {
    const r = new RenderStatusResolver().resolve(ctx({ code: "summarizing" }));
    expect(r).toMatchObject({ matched: true, text: "正在整理最终结论..." });
  });

  it("非渲染类 code 应放行", () => {
    const r = new RenderStatusResolver().resolve(ctx({ code: "read_file" }));
    expect(r.matched).toBe(false);
  });
});

describe("DefaultStatusResolver", () => {
  it("thinking 应给出思考文案", () => {
    const r = new DefaultStatusResolver().resolve(ctx({ code: "thinking" }));
    expect(r).toMatchObject({ matched: true, resolver: "default", text: "思考中..." });
  });

  it("completed / error / cancelled 都应命中", () => {
    expect(new DefaultStatusResolver().resolve(ctx({ code: "completed" }))).toMatchObject({ matched: true, text: "已完成" });
    expect(new DefaultStatusResolver().resolve(ctx({ code: "error" }))).toMatchObject({ matched: true, text: "执行出错" });
    expect(new DefaultStatusResolver().resolve(ctx({ code: "cancelled" }))).toMatchObject({ matched: true, text: "已取消" });
  });

  it("未覆盖 code 应放行", () => {
    const r = new DefaultStatusResolver().resolve(ctx({ code: "search_workspace" }));
    expect(r.matched).toBe(false);
  });
});

describe("FallbackStatusResolver", () => {
  it("任何上下文都应兜底命中", () => {
    const r = new FallbackStatusResolver().resolve(ctx({ code: "search_workspace" }));
    expect(r).toEqual({ matched: true, resolver: "fallback", text: "处理中...", stop: true });
  });
});

describe("resolveStatusText 责任链", () => {
  it("显式 text 优先级最高", () => {
    expect(resolveStatusText(ctx({ text: "显式", code: "read_file", target: "a.ts" }))).toBe("显式");
  });

  it("动作类优先于通用默认", () => {
    expect(resolveStatusText(ctx({ code: "search_workspace" }))).toBe("搜索工作区");
  });

  it("渲染类能被正确解析", () => {
    expect(resolveStatusText(ctx({ code: "render_mermaid" }))).toBe("正在绘制节点...");
  });

  it("通用状态走默认解析", () => {
    expect(resolveStatusText(ctx({ code: "reasoning" }))).toBe("正在推理...");
  });

  it("完全未知的状态走最终兜底", () => {
    expect(resolveStatusText(ctx({ code: "browser_interact" }))).toBe("操作浏览器页面");
  });
});

describe("buildStatusEvent", () => {
  it("应补齐 type/source/text 等字段", () => {
    const ev = buildStatusEvent(ctx({ code: "read_file", target: "a.ts", phase: "acting" }));
    expect(ev.type).toBe("status");
    expect(ev.source).toBe("system");
    expect(ev.text).toBe("读取 a.ts");
    expect(ev.phase).toBe("acting");
    expect(ev.code).toBe("read_file");
  });

  it("运行中状态 stage 应为 runtime", () => {
    const ev = buildStatusEvent(ctx({ code: "thinking" }));
    expect(ev.stage).toBe("runtime");
  });

  it("终态状态 stage 应为 committed", () => {
    expect(buildStatusEvent(ctx({ code: "completed" })).stage).toBe("committed");
    expect(buildStatusEvent(ctx({ code: "error" })).stage).toBe("committed");
    expect(buildStatusEvent(ctx({ code: "cancelled" })).stage).toBe("committed");
  });
});

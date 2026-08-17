import { describe, expect, it } from "vitest";
import { parseDsmlToolCalls, looksLikeDsmlStart } from "./dsmlParser.js";

describe("parseDsmlToolCalls", () => {
  it("解析半角竖线的 DSML 块", () => {
    const text = `<|DSML|tool_calls>
<|DSML|invoke name="search">
<|DSML|parameter name="query" string="true">hello world</|DSML|parameter>
<|DSML|parameter name="mode" string="true">content</|DSML|parameter>
</|DSML|invoke>
</|DSML|tool_calls>`;
    const r = parseDsmlToolCalls(text);
    expect(r).not.toBeNull();
    expect(r!.calls).toHaveLength(1);
    expect(r!.calls[0].name).toBe("search");
    expect(JSON.parse(r!.calls[0].arguments)).toEqual({ query: "hello world", mode: "content" });
    expect(r!.cleanText).toBe("");
  });

  it("解析全角竖线 ｜ 的 DSML 块", () => {
    const text = `<｜DSML｜tool_calls>
<｜DSML｜invoke name="execute_command">
<｜DSML｜parameter name="command" string="true">node -v</｜DSML｜parameter>
</｜DSML｜invoke>
</｜DSML｜tool_calls>`;
    const r = parseDsmlToolCalls(text);
    expect(r).not.toBeNull();
    expect(r!.calls[0].name).toBe("execute_command");
    expect(JSON.parse(r!.calls[0].arguments)).toEqual({ command: "node -v" });
  });

  it("string=false 参数按 JSON 解析（数字/布尔）", () => {
    const text = `<|DSML|tool_calls>
<|DSML|invoke name="foo">
<|DSML|parameter name="count" string="false">5</|DSML|parameter>
<|DSML|parameter name="flag" string="false">true</|DSML|parameter>
<|DSML|parameter name="obj" string="false">{"a":1}</|DSML|parameter>
</|DSML|invoke>
</|DSML|tool_calls>`;
    const r = parseDsmlToolCalls(text);
    expect(r).not.toBeNull();
    const args = JSON.parse(r!.calls[0].arguments);
    expect(args.count).toBe(5);
    expect(args.flag).toBe(true);
    expect(args.obj).toEqual({ a: 1 });
  });

  it("解析多个 invoke，并剥离前置正文", () => {
    const text = `我先执行两个命令。
<|DSML|tool_calls>
<|DSML|invoke name="execute_command">
<|DSML|parameter name="command" string="true">node -v</|DSML|parameter>
</|DSML|invoke>
<|DSML|invoke name="execute_command">
<|DSML|parameter name="command" string="true">npm -v</|DSML|parameter>
</|DSML|invoke>
</|DSML|tool_calls>`;
    const r = parseDsmlToolCalls(text);
    expect(r).not.toBeNull();
    expect(r!.calls).toHaveLength(2);
    expect(r!.calls[0].name).toBe("execute_command");
    expect(r!.calls[1].name).toBe("execute_command");
    expect(r!.cleanText).toBe("我先执行两个命令。");
  });

  it("参数值含多行与引号时仍能正确截断", () => {
    const code = `const r = await Promise.all([\n  tools.exec.command({"cmd":"npx eslint"})\n]);`;
    const text = `<|DSML|tool_calls>
<|DSML|invoke name="exec">
<|DSML|parameter name="input" string="true">${code}</|DSML|parameter>
</|DSML|invoke>
</|DSML|tool_calls>`;
    const r = parseDsmlToolCalls(text);
    expect(r).not.toBeNull();
    expect(JSON.parse(r!.calls[0].arguments).input).toBe(code);
  });

  it("无 DSML 块时返回 null", () => {
    expect(parseDsmlToolCalls("这是一段普通正文")).toBeNull();
  });

  it("DSML 块内无合法 invoke 时返回 null", () => {
    const text = `<|DSML|tool_calls></|DSML|tool_calls>`;
    expect(parseDsmlToolCalls(text)).toBeNull();
  });
});

describe("looksLikeDsmlStart", () => {
  it("识别 DSML 开始标记的前缀", () => {
    expect(looksLikeDsmlStart("<|D")).toBe(true);
    expect(looksLikeDsmlStart("<|DSML|")).toBe(true);
    expect(looksLikeDsmlStart("<|DSML|tool_calls")).toBe(true);
  });

  it("识别完整开始标记及后续内容", () => {
    expect(looksLikeDsmlStart("<|DSML|tool_calls>")).toBe(true);
    expect(looksLikeDsmlStart("<|DSML|tool_calls><|DSML|invoke")).toBe(true);
  });

  it("过短或非 DSML 前缀不误判", () => {
    expect(looksLikeDsmlStart("<")).toBe(false);
    expect(looksLikeDsmlStart("<|")).toBe(false);
    expect(looksLikeDsmlStart("<div>")).toBe(false);
    expect(looksLikeDsmlStart("你好")).toBe(false);
  });
});

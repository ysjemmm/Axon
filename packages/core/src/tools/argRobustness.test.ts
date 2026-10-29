import { describe, expect, it } from "vitest";
import { parseToolArguments } from "../agentGuards.js";
import { coerceToolArgs } from "./argCoercion.js";
import { preNormalizeArgs } from "./argPreNormalize.js";
import { AskUserToolExecutor } from "../session/askUserToolExecutor.js";
import { normalizeFormSpec } from "../session/formSchema.js";

describe("参数 JSON 修复", () => {
  it("代码块包裹、尾随逗号、二次编码都能解析", () => {
    expect(parseToolArguments('```json\n{"path": "a.ts"}\n```')).toEqual({ path: "a.ts" });
    expect(parseToolArguments('{"paths": ["a", "b",],}')).toEqual({ paths: ["a", "b"] });
    expect(parseToolArguments(JSON.stringify(JSON.stringify({ path: "a.ts" })))).toEqual({ path: "a.ts" });
  });

  it("截断的参数给出「拆小再调」的提示；数组参数明确报错", () => {
    expect(() => parseToolArguments('{"path": "a.ts", "content": "很长很长')).toThrow(/截断/);
    expect(() => parseToolArguments('["a"]')).toThrow(/JSON 对象/);
  });
});

describe("按工具定义纠正参数", () => {
  const schema = {
    type: "object",
    properties: {
      path: { type: "string", description: "文件路径" },
      oldStr: { type: "string" },
      paths: { type: "array", items: { type: "string" } },
      recursive: { type: "boolean" },
      depth: { type: "number" },
      questions: { type: "array", items: { type: "object", properties: { question: { type: "string" }, multi: { type: "boolean" } } } },
    },
    required: ["path"],
  };

  it("字符串化的数组、布尔 / 数字字符串、单值数组、相近参数名都纠正", () => {
    const out = coerceToolArgs("t", {
      file_path: "a.ts", old_str: "x", paths: "b.ts", recursive: "true", depth: "3",
      questions: '[{"question": "Q", "multi": "false"}]',
    }, schema);
    expect(out.error).toBeUndefined();
    expect(out.args).toEqual({ path: "a.ts", oldStr: "x", paths: ["b.ts"], recursive: true, depth: 3, questions: [{ question: "Q", multi: false }] });
  });

  it("缺必填参数：说清楚缺哪个、全部参数是什么", () => {
    const out = coerceToolArgs("read_file", { file: 1, foo: 2 }, { type: "object", properties: { path: { type: "string", description: "文件路径" }, startLine: { type: "number" } }, required: ["path"] });
    expect(out.error).toMatch(/缺少必填参数 path/);
    expect(out.error).toMatch(/path（string）：文件路径 \[必填\]/);
  });
});

describe("ask_user 容错", () => {
  const run = async (args: Record<string, unknown>) => {
    let asked: any[] = [];
    const exec = new AskUserToolExecutor({ waitForUserAnswer: async (_id, qs) => { asked = qs; return qs.map(() => ({ selected: [qs[0].options[0].id] })); } });
    const out = await exec.execute({ toolName: "ask_user", toolArgs: coerceToolArgs("ask_user", preNormalizeArgs("ask_user", args), undefined).args, toolCallId: "c" });
    return { out, asked };
  };

  it("单个问题摊在顶层、选项是字符串、multiSelect 写成字符串、自带「其他」", async () => {
    const { out, asked } = await run({ question: "用哪个库？", options: ["React", "Vue", "其他"], multiSelect: "true" });
    expect(out.status).toBe("success");
    expect(asked[0]).toMatchObject({ question: "用哪个库？", multi: true, allowOther: true });
    expect(asked[0].options.map((o: any) => o.label)).toEqual(["React", "Vue"]);
  });

  it("questions 是 JSON 字符串、选项用 text / title 表示", async () => {
    const { out, asked } = await run({ questions: JSON.stringify([{ title: "部署到哪？", choices: [{ text: "测试" }, { title: "生产" }] }]) });
    expect(out.status).toBe("success");
    expect(asked[0].options.map((o: any) => o.label)).toEqual(["测试", "生产"]);
  });

  it("有一题没选项：整体打回，指出是哪题，附示例", async () => {
    const { out, asked } = await run({ questions: [{ question: "Q1", options: ["A", "B"] }, { question: "Q2" }] });
    expect(out.status).toBe("error");
    expect(out.result).toMatch(/第 2 题「Q2」只有 0 个有效选项/);
    expect(out.result).toMatch(/正确示例/);
    expect(asked).toEqual([]);
  });
});

describe("ask_form 容错", () => {
  it("漏了外层 form、类型用别名、缺 name、选项是字符串", () => {
    const args = preNormalizeArgs("ask_form", { title: "参数", fields: [{ type: "input", label: "Host" }, { type: "dropdown", name: "env", options: ["dev", "prod"] }, { type: "boolean", key: "dry" }] });
    const { spec, error } = normalizeFormSpec(args.form);
    expect(error).toBeUndefined();
    expect(spec!.fields.map((f) => [f.type, f.name])).toEqual([["text", "host"], ["select", "env"], ["switch", "dry"]]);
  });

  it("有字段渲染不了：整张打回并说明原因", () => {
    const { spec, error } = normalizeFormSpec({ fields: [{ type: "text", name: "a" }, { type: "select", name: "b" }, { type: "wizard", name: "c" }] });
    expect(spec).toBeNull();
    expect(error).toMatch(/第 2 个字段「b」是 select，但没有 options/);
    expect(error).toMatch(/第 3 个字段的 type「wizard」不支持/);
  });
});

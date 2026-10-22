import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const extensionRequire = createRequire(new URL("../../apps/vscode-extension/package.json", import.meta.url));
const { build } = extensionRequire("esbuild");

const result = await build({
  entryPoints: [fileURLToPath(new URL("../src/components/cowork/restoreOutputs.ts", import.meta.url))],
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
  alias: { "@": fileURLToPath(new URL("../src", import.meta.url)) },
});
const { restoreOutputs } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString("base64")}`);

function call(id, name, args) {
  return { role: "assistant", tool_calls: [{ id, function: { name, arguments: JSON.stringify(args) } }] };
}

function outcome(id, name, status, content, reportedOutputs) {
  return { role: "tool", tool_call_id: id, _toolName: name, status, content, reportedOutputs };
}

test("旧会话中成功登记的 DOCX 可恢复，失败和脚本不能冒充产出", () => {
  const docx = "C:\\Documents\\结果.docx";
  assert.deepEqual(restoreOutputs([
    call("script", "create_file", { path: "C:\\Documents\\work.py" }),
    outcome("script", "create_file", "success", "已创建"),
    call("failed", "report_outputs", { files: [{ path: "C:\\Documents\\不存在.docx" }] }),
    outcome("failed", "report_outputs", "error", "未登记"),
    call("saved", "report_outputs", { files: [{ path: docx }] }),
    outcome("saved", "report_outputs", "success", "已登记 1 个产出文件，已显示给用户。"),
  ]), [{ path: docx }]);
});

test("新会话部分成功时只恢复磁盘校验通过的路径", () => {
  const docx = "C:\\Documents\\结果.docx";
  assert.deepEqual(restoreOutputs([
    call("saved", "report_outputs", { files: [{ path: docx }, { path: "C:\\Documents\\missing.pdf" }] }),
    outcome("saved", "report_outputs", "error", "部分登记失败", [docx]),
  ]), [{ path: docx }]);
});

test("新会话分别还原 AI 登记的创建与编辑类型，仅展示校验通过的文件", () => {
  const created = "C:\\Documents\\新建.xlsx";
  const edited = "C:\\Documents\\原稿.docx";
  const missing = "C:\\Documents\\不存在.pdf";
  assert.deepEqual(restoreOutputs([
    call("saved", "report_outputs", {
      files: [
        { path: created, kind: "created" },
        { path: edited, kind: "edited" },
        { path: missing, kind: "created" },
      ],
    }),
    {
      ...outcome("saved", "report_outputs", "success", "已登记 2 个产出文件。", [created, edited]),
      reportedOutputItems: [{ path: created, kind: "created" }, { path: edited, kind: "edited" }],
    },
  ]), [{ path: created, kind: "created" }, { path: edited, kind: "edited" }]);
});

test("旧会话部分成功无法确定具体文件时不猜路径", () => {
  assert.deepEqual(restoreOutputs([
    call("saved", "report_outputs", { files: [{ path: "C:\\Documents\\a.pdf" }, { path: "C:\\Documents\\b.pdf" }] }),
    outcome("saved", "report_outputs", "success", "已登记 1 个产出文件。以下路径在磁盘上不存在，未登记：\n- C:\\Documents\\b.pdf\n请确认文件确实已写入"),
  ]), [{ path: "C:\\Documents\\a.pdf" }]);
  assert.deepEqual(restoreOutputs([
    call("saved", "report_outputs", { files: [{ path: "C:\\Documents\\a.pdf" }, { path: "C:\\Documents\\b.pdf" }] }),
    outcome("saved", "report_outputs", "success", "已登记 1 个产出文件。"),
  ]), []);
});

test("实际旧会话可恢复文件修改产出（仅在指定样本时运行）", async (t) => {
  const path = process.env.AXON_COWORK_HISTORY_SAMPLE;
  if (!path) return t.skip("未指定本机旧会话样本");
  const session = JSON.parse(await readFile(path, "utf8"));
  const messages = session.messages;
  const lastUserIndex = messages.findLastIndex((message) => message.role === "user" && message.displayText?.includes("DOCX"));
  assert.ok(lastUserIndex >= 0);
  assert.ok(restoreOutputs(messages.slice(lastUserIndex)).some((file) => file.path.toLowerCase().endsWith(".docx") && !file.kind));
});

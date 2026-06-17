/**
 * CodeEditor - 基于 Monaco 的代码编辑器封装
 *
 * 设计：
 * - 本地化 Monaco（worker 走本地 bundle，不依赖外网 CDN，内网可用）
 * - 按文件扩展名自动推断语言，提供行号 + 语法高亮
 * - 跟随应用暗色主题（监听 <html> 的 dark class）
 * - Ctrl/Cmd + S 触发 onSave 回调
 */

import { useEffect, useRef, useState } from "react";
import Editor, { loader, type OnMount } from "@monaco-editor/react";

/**
 * Monaco 环境初始化（延迟到首次组件挂载时执行,避免模块加载顺序引发
 * "Cannot access '_' before initialization" —— rolldown/vite8 打包时
 * 顶层副作用求值顺序与 Monaco 内部 worker 初始化冲突的已知问题）。
 */
let monacoReady = false;
async function ensureMonacoReady() {
  if (monacoReady) return;
  monacoReady = true;
  const monaco = await import("monaco-editor");
  const editorWorker = await import("monaco-editor/esm/vs/editor/editor.worker?worker");
  const jsonWorker = await import("monaco-editor/esm/vs/language/json/json.worker?worker");
  const cssWorker = await import("monaco-editor/esm/vs/language/css/css.worker?worker");
  const htmlWorker = await import("monaco-editor/esm/vs/language/html/html.worker?worker");
  const tsWorker = await import("monaco-editor/esm/vs/language/typescript/ts.worker?worker");
  self.MonacoEnvironment = {
    getWorker(_workerId: string, label: string) {
      if (label === "json") return new jsonWorker.default();
      if (label === "css" || label === "scss" || label === "less") return new cssWorker.default();
      if (label === "html" || label === "handlebars" || label === "razor") return new htmlWorker.default();
      if (label === "typescript" || label === "javascript") return new tsWorker.default();
      return new editorWorker.default();
    },
  };
  loader.config({ monaco });
}

/** 按扩展名映射到 Monaco 语言 id */
function languageFromName(name: string): string {
  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  const map: Record<string, string> = {
    md: "markdown", markdown: "markdown",
    py: "python",
    js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
    ts: "typescript", tsx: "typescript",
    json: "json", json5: "json",
    yaml: "yaml", yml: "yaml",
    sh: "shell", bash: "shell", zsh: "shell",
    html: "html", htm: "html",
    css: "css", scss: "scss", less: "less",
    xml: "xml", toml: "ini", ini: "ini", cfg: "ini", conf: "ini",
    sql: "sql", go: "go", rs: "rust", java: "java", kt: "kotlin",
    c: "c", h: "c", cpp: "cpp", cc: "cpp", hpp: "cpp",
    rb: "ruby", php: "php", txt: "plaintext", log: "plaintext",
  };
  return map[ext] || "plaintext";
}

/** 监听 <html> 的 dark class，返回当前是否暗色 */
function useIsDark(): boolean {
  const [isDark, setIsDark] = useState(() =>
    typeof document !== "undefined" && document.documentElement.classList.contains("dark"),
  );
  useEffect(() => {
    const el = document.documentElement;
    const obs = new MutationObserver(() => setIsDark(el.classList.contains("dark")));
    obs.observe(el, { attributes: true, attributeFilter: ["class"] });
    return () => obs.disconnect();
  }, []);
  return isDark;
}

interface CodeEditorProps {
  /** 文件名（用于推断语言高亮） */
  fileName: string;
  /** 文件内容 */
  value: string;
  /** 内容变化回调 */
  onChange: (value: string) => void;
  /** Ctrl/Cmd + S 保存回调 */
  onSave?: () => void;
}

export function CodeEditor({ fileName, value, onChange, onSave }: CodeEditorProps) {
  const isDark = useIsDark();
  const [ready, setReady] = useState(monacoReady);
  // 用 ref 保存最新 onSave，避免重复注册命令
  const saveRef = useRef(onSave);
  saveRef.current = onSave;

  // 延迟初始化 Monaco（首次挂载时触发）
  useEffect(() => {
    if (!ready) {
      ensureMonacoReady().then(() => setReady(true));
    }
  }, [ready]);

  const handleMount: OnMount = (editor, monacoApi) => {
    editor.addCommand(monacoApi.KeyMod.CtrlCmd | monacoApi.KeyCode.KeyS, () => {
      saveRef.current?.();
    });
  };

  if (!ready) {
    return <div className="flex items-center justify-center h-full text-xs text-muted-foreground">加载编辑器...</div>;
  }

  return (
    <Editor
      height="100%"
      path={fileName}
      language={languageFromName(fileName)}
      value={value}
      theme={isDark ? "vs-dark" : "light"}
      onChange={(v) => onChange(v ?? "")}
      onMount={handleMount}
      options={{
        fontSize: 13,
        fontFamily: "'JetBrains Mono Variable', 'JetBrains Mono', ui-monospace, monospace",
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        automaticLayout: true,
        tabSize: 2,
        wordWrap: "on",
        renderWhitespace: "selection",
        smoothScrolling: true,
        padding: { top: 12, bottom: 12 },
      }}
    />
  );
}

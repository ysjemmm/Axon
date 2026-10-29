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
  // 只加载编辑器核心 + 常用语言的语法高亮（Monarch）+ JSON 语言服务。
  // 整包 "monaco-editor" 会注册 TS / CSS / HTML 的完整语言服务，各自要一个 worker（合计近 9MB，
  // ts.worker 一个就 6.6MB）；这里编辑的是技能、配置这类小文件，用不上补全和类型检查。
  // @ts-expect-error 深路径没有单独的类型声明，形状与 "monaco-editor" 一致
  const monaco = (await import("monaco-editor/esm/vs/editor/edcore.main.js")) as typeof import("monaco-editor");
  await Promise.all([
    import("monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution.js"),
    import("monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution.js"),
    import("monaco-editor/esm/vs/basic-languages/python/python.contribution.js"),
    import("monaco-editor/esm/vs/basic-languages/java/java.contribution.js"),
    import("monaco-editor/esm/vs/basic-languages/go/go.contribution.js"),
    import("monaco-editor/esm/vs/basic-languages/rust/rust.contribution.js"),
    import("monaco-editor/esm/vs/basic-languages/cpp/cpp.contribution.js"),
    import("monaco-editor/esm/vs/basic-languages/csharp/csharp.contribution.js"),
    import("monaco-editor/esm/vs/basic-languages/shell/shell.contribution.js"),
    import("monaco-editor/esm/vs/basic-languages/powershell/powershell.contribution.js"),
    import("monaco-editor/esm/vs/basic-languages/bat/bat.contribution.js"),
    import("monaco-editor/esm/vs/basic-languages/yaml/yaml.contribution.js"),
    import("monaco-editor/esm/vs/basic-languages/xml/xml.contribution.js"),
    import("monaco-editor/esm/vs/basic-languages/html/html.contribution.js"),
    import("monaco-editor/esm/vs/basic-languages/css/css.contribution.js"),
    import("monaco-editor/esm/vs/basic-languages/scss/scss.contribution.js"),
    import("monaco-editor/esm/vs/basic-languages/less/less.contribution.js"),
    import("monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution.js"),
    import("monaco-editor/esm/vs/basic-languages/sql/sql.contribution.js"),
    import("monaco-editor/esm/vs/basic-languages/ini/ini.contribution.js"),
    import("monaco-editor/esm/vs/basic-languages/dockerfile/dockerfile.contribution.js"),
    import("monaco-editor/esm/vs/basic-languages/php/php.contribution.js"),
    import("monaco-editor/esm/vs/basic-languages/ruby/ruby.contribution.js"),
    import("monaco-editor/esm/vs/basic-languages/kotlin/kotlin.contribution.js"),
    import("monaco-editor/esm/vs/basic-languages/swift/swift.contribution.js"),
    import("monaco-editor/esm/vs/language/json/monaco.contribution.js"),
  ]);
  // 只带通用 worker 和 JSON worker（配置文件要校验）。TS / CSS / HTML 的语言服务 worker 合计近 9MB
  // （ts.worker 一个就 6.6MB），这里编辑的是技能、配置这类小文件，语法高亮由 Monarch 负责，用不上完整语言服务。
  const editorWorker = await import("monaco-editor/esm/vs/editor/editor.worker?worker");
  const jsonWorker = await import("monaco-editor/esm/vs/language/json/json.worker?worker");
  self.MonacoEnvironment = {
    getWorker(_workerId: string, label: string) {
      if (label === "json") return new jsonWorker.default();
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

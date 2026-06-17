/**
 * 文件类型图标 - 统一徽章样式。
 *
 * 设计原则：所有文件类型用【完全相同的形状】（圆角徽章），只用底色和类型字母区分。
 * 这样不同文件的图标视觉重量完全一致，并排展示时不会出现"有的大有的小、有的有图形有的只有字"
 * 的不协调感（对齐 VS Code Seti 图标主题的思路）。
 */

type FileIconStyle = {
  /** 徽章内显示的类型字母（1~4 个字符） */
  label: string;
  /** 徽章底色 */
  color: string;
};

const FILE_ICON_STYLES: Record<string, FileIconStyle> = {
  tsx: { label: "TS", color: "#3178c6" },
  jsx: { label: "JS", color: "#d6a916" },
  ts: { label: "TS", color: "#3178c6" },
  js: { label: "JS", color: "#d6a916" },
  mjs: { label: "JS", color: "#d6a916" },
  cjs: { label: "JS", color: "#d6a916" },
  json: { label: "{}", color: "#e8821a" },
  css: { label: "CSS", color: "#2563eb" },
  scss: { label: "SC", color: "#cf649a" },
  html: { label: "<>", color: "#e34f26" },
  md: { label: "MD", color: "#64748b" },
  markdown: { label: "MD", color: "#64748b" },
  py: { label: "PY", color: "#3776ab" },
  java: { label: "JV", color: "#ef4444" },
  kt: { label: "KT", color: "#7c3aed" },
  go: { label: "GO", color: "#00acd7" },
  rs: { label: "RS", color: "#b45309" },
  vue: { label: "VUE", color: "#42b883" },
  svelte: { label: "SV", color: "#ff3e00" },
  sql: { label: "SQL", color: "#0ea5e9" },
  yml: { label: "YML", color: "#dc2626" },
  yaml: { label: "YML", color: "#dc2626" },
  xml: { label: "XML", color: "#e8821a" },
  svg: { label: "SVG", color: "#f59e0b" },
  png: { label: "IMG", color: "#10b981" },
  jpg: { label: "IMG", color: "#10b981" },
  jpeg: { label: "IMG", color: "#10b981" },
  gif: { label: "IMG", color: "#10b981" },
  webp: { label: "IMG", color: "#10b981" },
  sh: { label: "SH", color: "#16a34a" },
  bash: { label: "SH", color: "#16a34a" },
  ps1: { label: "PS", color: "#2563eb" },
};

const SPECIAL_FILE_ICON_STYLES: Record<string, FileIconStyle> = {
  dockerfile: { label: "DK", color: "#2496ed" },
  makefile: { label: "MK", color: "#475569" },
  package: { label: "NPM", color: "#cb3837" },
};

function getFileIconStyle(fileName: string): FileIconStyle {
  const normalizedName = fileName.split(/[\\/]/).pop()?.toLowerCase() || fileName.toLowerCase();
  const specialKey = Object.keys(SPECIAL_FILE_ICON_STYLES).find((key) => normalizedName === key || normalizedName.startsWith(`${key}.`));
  if (specialKey) return SPECIAL_FILE_ICON_STYLES[specialKey];

  const ext = normalizedName.includes(".") ? normalizedName.split(".").pop() || "" : normalizedName;
  return FILE_ICON_STYLES[ext] || { label: ext ? ext.slice(0, 2).toUpperCase() : "?", color: "#94a3b8" };
}

/**
 * 统一徽章：所有文件类型共用同一个圆角矩形 + 居中类型字母。
 * 形状、尺寸、字重完全一致，仅底色和字母不同。
 */
export function FileTypeIcon({ fileName, className = "" }: { fileName: string; className?: string }) {
  const style = getFileIconStyle(fileName);
  // 字母多时缩小字号，保证在徽章内不溢出
  const fontSize = style.label.length >= 3 ? 10.5 : 12.5;

  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={`w-4 h-4 shrink-0 ${className}`}>
      <rect x="2" y="2" width="20" height="20" rx="5" fill={style.color} />
      <text
        x="12"
        y="12"
        textAnchor="middle"
        dominantBaseline="central"
        fontSize={fontSize}
        fontWeight="700"
        fill="#ffffff"
        fontFamily="ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace"
      >
        {style.label}
      </text>
    </svg>
  );
}

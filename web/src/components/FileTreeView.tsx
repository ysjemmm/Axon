/**
 * FileTreeView —— Skill 与 Power 共用的文件树浏览/选择组件。
 *
 * 从 SkillStudio 抽出来：Power 的文件管理用的是同一套交互（目录可展开、文件可点选、
 * 可选删除按钮）。两边各写一份很容易走形，也会出现「改了一边忘了另一边」。
 *
 * 与业务无关：只负责渲染 `SkillFileNode[]` 与抛出选择/删除回调，
 * 数据从哪来、能不能删由调用方决定（onDelete 不传即只读）。
 */

import { useMemo, useState } from "react";
import {
  ChevronRight,
  ChevronDown,
  File as FileIcon,
  FileCode,
  FileJson,
  FileText,
  Folder,
  FolderOpen,
  Trash2,
} from "lucide-react";
import type { SkillFileNode } from "@/lib/apiClient";

/** 根据文件扩展名返回匹配的图标组件 */
export function fileIconFor(name: string) {
  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  if (ext === "md" || ext === "markdown" || ext === "txt") return FileText;
  if (ext === "json") return FileJson;
  if (["py", "js", "ts", "tsx", "jsx", "sh", "bash"].includes(ext)) return FileCode;
  return FileIcon;
}

export function FileTree({
  nodes,
  selectedPath,
  onSelectFile,
  onDelete,
  expandDepth = 0,
  depth = 0,
}: {
  nodes: SkillFileNode[];
  selectedPath: string | null;
  onSelectFile: (path: string) => void;
  /** 不传则不显示删除按钮（只读浏览） */
  onDelete?: (node: SkillFileNode) => void;
  /**
   * 到哪一层默认展开。默认 0 = 顶层目录展开（Skill 包通常只有 SKILL.md + scripts/）。
   * Power 传 -1：它的顶层可能是 styles/ 这种装了几十个子目录的容器，全展开会刷屏。
   */
  expandDepth?: number;
  depth?: number;
}) {
  return (
    <div className="space-y-0.5">
      {nodes.map((node) => (
        <TreeItem
          key={node.path}
          node={node}
          selectedPath={selectedPath}
          onSelectFile={onSelectFile}
          onDelete={onDelete}
          expandDepth={expandDepth}
          depth={depth}
        />
      ))}
    </div>
  );
}

/** 单个树节点（文件或可展开目录） */
function TreeItem({
  node,
  selectedPath,
  onSelectFile,
  onDelete,
  expandDepth,
  depth,
}: {
  node: SkillFileNode;
  selectedPath: string | null;
  onSelectFile: (path: string) => void;
  onDelete?: (node: SkillFileNode) => void;
  expandDepth: number;
  depth: number;
}) {
  const [expanded, setExpanded] = useState(depth <= expandDepth);
  const Icon = useMemo(() => fileIconFor(node.name), [node.name]);
  const isSelected = node.type === "file" && selectedPath === node.path;

  if (node.type === "directory") {
    return (
      <div>
        <div
          className="group flex items-center gap-1 py-1 px-1 rounded cursor-pointer hover:bg-muted/50 text-sm"
          style={{ paddingLeft: `${depth * 12 + 4}px` }}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? <ChevronDown className="w-3.5 h-3.5 shrink-0" /> : <ChevronRight className="w-3.5 h-3.5 shrink-0" />}
          {expanded ? <FolderOpen className="w-4 h-4 shrink-0 text-sky-500" /> : <Folder className="w-4 h-4 shrink-0 text-sky-500" />}
          <span className="truncate flex-1">{node.name}</span>
          {onDelete && (
            <button
              onClick={(e) => { e.stopPropagation(); onDelete(node); }}
              className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-muted-foreground hover:text-red-500 shrink-0"
              title="删除目录"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
        {expanded && node.children && node.children.length > 0 && (
          <FileTree
            nodes={node.children}
            selectedPath={selectedPath}
            onSelectFile={onSelectFile}
            onDelete={onDelete}
            expandDepth={expandDepth}
            depth={depth + 1}
          />
        )}
      </div>
    );
  }

  return (
    <div
      className={`group flex items-center gap-1 py-1 px-1 rounded cursor-pointer text-sm ${isSelected ? "bg-muted font-medium" : "hover:bg-muted/50"}`}
      style={{ paddingLeft: `${depth * 12 + 4 + 18}px` }}
      onClick={() => onSelectFile(node.path)}
    >
      <Icon className="w-4 h-4 shrink-0 text-muted-foreground" />
      <span className="truncate flex-1">{node.name}</span>
      {onDelete && (
        <button
          onClick={(e) => { e.stopPropagation(); onDelete(node); }}
          className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-muted-foreground hover:text-red-500 shrink-0"
          title="删除文件"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  );
}

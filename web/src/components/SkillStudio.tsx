/**
 * Skill Studio - 整页 Skill 管理（对齐 Claude 的 Directory 设计）
 *
 * 两级视图：
 * 1. Directory（默认）：左侧导航 + 中间卡片网格（搜索 / 排序 / 新建）
 *    卡片内容为本地已安装的 skill（~/.axon/skills 与工作区级），数据真实，不造假。
 * 2. 文件管理：点卡片进入，左侧目录树 + 右侧 Monaco 编辑器。
 *
 * 所有文件读写经 apiClient，path 为相对 skill 目录的 "/" 分隔路径。
 * 安全由后端保证（防路径穿越）。
 */

import { useState, useEffect, useCallback, useMemo } from "react";
import {
  ChevronRight,
  ChevronDown,
  File as FileIcon,
  FileCode,
  FileJson,
  FileText,
  Folder,
  FolderOpen,
  ArrowLeft,
  FilePlus,
  FolderPlus,
  Trash2,
  Save,
  Loader2,
  Boxes,
  Plus,
  Search,
  Plug,
  Puzzle,
  Settings2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CodeEditor } from "@/components/CodeEditor";
import { SkillCreateDialog } from "@/components/SkillCreateDialog";
import {
  listSkills,
  getSkillTree,
  readSkillFile,
  writeSkillFile,
  createSkillFile,
  deleteSkillFile,
  deleteSkill,
  toggleSkill,
  type SkillInfo,
  type SkillFileNode,
} from "@/lib/apiClient";

interface SkillStudioProps {
  /** 当前工作区路径（用于定位工作区级 skill） */
  workspace?: string;
  /** 返回聊天界面 */
  onBack: () => void;
}

type SortKey = "name" | "source";
type FilterSource = "all" | "global" | "workspace" | "builtin";

/** 根据文件扩展名返回匹配的图标组件 */
function fileIconFor(name: string) {
  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  if (ext === "md" || ext === "markdown" || ext === "txt") return FileText;
  if (ext === "json") return FileJson;
  if (["py", "js", "ts", "tsx", "jsx", "sh", "bash"].includes(ext)) return FileCode;
  return FileIcon;
}

export function SkillStudio({ workspace, onBack }: SkillStudioProps) {
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [loadingSkills, setLoadingSkills] = useState(false);
  // 进入文件管理视图的 skill（null = 停留在 Directory 网格）
  const [activeSkill, setActiveSkill] = useState<SkillInfo | null>(null);
  // 新建 Skill 对话框
  const [createOpen, setCreateOpen] = useState(false);
  // Directory 搜索 / 排序 / 筛选
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [filterSource, setFilterSource] = useState<FilterSource>("all");

  // 加载 skill 列表
  const loadSkills = useCallback(async () => {
    setLoadingSkills(true);
    try {
      const data = await listSkills();
      setSkills(data.skills || []);
    } catch { /* ignore */ }
    setLoadingSkills(false);
  }, []);

  useEffect(() => {
    loadSkills();
  }, [loadSkills]);

  /** 新建 Skill 成功：刷新列表（停留在 Directory，不强行进入） */
  const handleSkillCreated = useCallback(async () => {
    setCreateOpen(false);
    await loadSkills();
  }, [loadSkills]);

  /** 切换 skill 启用/禁用状态 */
  const handleToggleSkill = useCallback(async (skill: SkillInfo, disabled: boolean) => {
    try {
      await toggleSkill(skill.name, disabled);
      setSkills((prev) => prev.map((s) => s.name === skill.name ? { ...s, disabled } : s));
    } catch { /* ignore */ }
  }, []);

  /** 删除整个 skill（含目录下所有文件） */
  const handleDeleteSkill = useCallback(async (skill: SkillInfo, e: React.MouseEvent) => {
    e.stopPropagation();
    const ok = window.confirm(`确认删除整个 Skill "${skill.name}"？其目录下所有文件都将被删除，且不可撤销。`);
    if (!ok) return;
    try {
      await deleteSkill(skill.name);
      await loadSkills();
    } catch { /* ignore */ }
  }, [loadSkills]);

  // 过滤 + 排序后的 skill 列表
  const visibleSkills = useMemo(() => {
    const q = query.trim().toLowerCase();
    let filtered = skills;
    // 来源筛选
    if (filterSource !== "all") {
      filtered = filtered.filter((s) => s.source === filterSource);
    }
    // 搜索
    if (q) {
      filtered = filtered.filter((s) => s.name.toLowerCase().includes(q) || (s.description || "").toLowerCase().includes(q));
    }
    return [...filtered].sort((a, b) =>
      // 禁用的统一沉底；同状态内再按 name/source 排
      (Number(!!a.disabled) - Number(!!b.disabled)) || (
        sortKey === "name"
          ? a.name.localeCompare(b.name)
          : a.source.localeCompare(b.source) || a.name.localeCompare(b.name)
      ),
    );
  }, [skills, query, sortKey, filterSource]);

  // 进入文件管理视图
  if (activeSkill) {
    return (
      <SkillFileManager
        skill={activeSkill}
        workspace={workspace}
        onBackToDirectory={() => setActiveSkill(null)}
      />
    );
  }

  // Directory 网格视图
  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* 顶部栏 */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border shrink-0">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft className="w-4 h-4" />
          返回
        </Button>
        <span className="text-lg font-semibold">Directory</span>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* 左侧导航 */}
        <nav className="w-52 shrink-0 border-r border-border p-2 space-y-0.5">
          <button className="flex items-center gap-2.5 w-full px-2.5 py-2 rounded-md text-sm bg-muted font-medium text-left">
            <Boxes className="w-4 h-4 shrink-0" />
            Skills
          </button>
          <button
            disabled
            className="flex items-center gap-2.5 w-full px-2.5 py-2 rounded-md text-sm text-muted-foreground/50 cursor-not-allowed text-left"
            title="即将支持"
          >
            <Plug className="w-4 h-4 shrink-0" />
            Connectors
          </button>
          <button
            disabled
            className="flex items-center gap-2.5 w-full px-2.5 py-2 rounded-md text-sm text-muted-foreground/50 cursor-not-allowed text-left"
            title="即将支持"
          >
            <Puzzle className="w-4 h-4 shrink-0" />
            Plugins
          </button>
        </nav>

        {/* 右侧内容区 */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* 工具条：搜索 + 排序 + 新建 */}
          <div className="flex items-center gap-2 px-6 py-4 shrink-0">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜索 Skills..."
                className="h-9 pl-9"
              />
            </div>
            <Select value={sortKey} onValueChange={(v) => setSortKey(v as SortKey)}>
              <SelectTrigger className="h-9 w-32 shrink-0">
                <SelectValue placeholder="排序" />
              </SelectTrigger>
              <SelectContent position="popper" align="start" sideOffset={6} className="min-w-(--radix-select-trigger-width)">
                <SelectItem value="name">按名称</SelectItem>
                <SelectItem value="source">按来源</SelectItem>
              </SelectContent>
            </Select>
            <Button size="lg" className="h-9 shrink-0" onClick={() => setCreateOpen(true)}>
              <Plus className="w-4 h-4" />
              新建 Skill
            </Button>
          </div>

          {/* 筛选标签 */}
          <div className="flex items-center gap-2 px-6 pb-3 shrink-0">
            {(["all", "global", "workspace", "builtin"] as const).map((f) => {
              const labels: Record<FilterSource, string> = { all: "全部", global: "全局", workspace: "项目级", builtin: "内置" };
              const active = filterSource === f;
              return (
                <button
                  key={f}
                  onClick={() => setFilterSource(f)}
                  className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${active ? "bg-foreground text-background" : "bg-muted text-muted-foreground hover:bg-muted/80"}`}
                >
                  {labels[f]}
                </button>
              );
            })}
          </div>

          {/* 卡片网格 */}
          <div className="flex-1 overflow-y-auto px-6 pb-6">
            {loadingSkills && (
              <div className="flex justify-center py-10"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>
            )}
            {!loadingSkills && visibleSkills.length === 0 && (
              <div className="text-center text-sm text-muted-foreground py-16">
                {query ? "没有匹配的 Skill" : "还没有安装任何 Skill"}
                {!query && (
                  <div className="mt-2">
                    <button onClick={() => setCreateOpen(true)} className="text-primary hover:underline">+ 新建一个</button>
                  </div>
                )}
              </div>
            )}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
              {visibleSkills.map((s) => (
                <SkillCard
                  key={`${s.source}-${s.name}`}
                  skill={s}
                  onOpen={() => setActiveSkill(s)}
                  onDelete={(e) => handleDeleteSkill(s, e)}
                  onToggle={(disabled) => handleToggleSkill(s, disabled)}
                />
              ))}
            </div>
          </div>
        </div>
      </div>

      <SkillCreateDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        workspace={workspace}
        onCreated={handleSkillCreated}
      />
    </div>
  );
}

/** Directory 单张 skill 卡片 */
function SkillCard({ skill, onOpen, onDelete, onToggle }: {
  skill: SkillInfo;
  onOpen: () => void;
  onDelete: (e: React.MouseEvent) => void;
  onToggle: (disabled: boolean) => void;
}) {
  return (
    <div
      onClick={onOpen}
      className={`group relative rounded-xl border border-border p-4 cursor-pointer hover:border-primary/50 hover:bg-muted/30 transition-colors ${skill.disabled ? "opacity-50" : ""}`}
    >
      <div className="flex items-start gap-2">
        <Boxes className="w-4 h-4 mt-0.5 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <div className={`font-medium text-sm truncate ${skill.disabled ? "line-through text-muted-foreground" : ""}`}>{skill.name}</div>
          <div className="text-xs text-muted-foreground/70 mt-0.5">
            {skill.source === "global" ? "全局" : skill.source === "builtin" ? "内置" : "工作区"}
            {skill.disabled && <span className="ml-1.5 text-amber-500">已禁用</span>}
          </div>
        </div>
        {/* 操作区 */}
        <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
          {/* 启用/禁用开关 */}
          <button
            onClick={() => onToggle(!skill.disabled)}
            className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${skill.disabled ? "bg-muted-foreground/30" : "bg-primary"}`}
            title={skill.disabled ? "点击启用" : "点击禁用"}
          >
            <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow-sm transition-transform ${skill.disabled ? "translate-x-0.5" : "translate-x-[18px]"}`} />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); onOpen(); }}
            className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted opacity-0 group-hover:opacity-100 transition-opacity"
            title="管理文件"
          >
            <Settings2 className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={onDelete}
            className="p-1 rounded text-muted-foreground hover:text-red-500 hover:bg-muted opacity-0 group-hover:opacity-100 transition-opacity"
            title="删除整个 Skill"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
      {skill.description && (
        <p className="text-xs text-muted-foreground mt-2 line-clamp-2 leading-relaxed">{skill.description}</p>
      )}
    </div>
  );
}

/** 文件管理视图：左侧目录树 + 右侧 Monaco 编辑器 */
function SkillFileManager({ skill, workspace, onBackToDirectory }: {
  skill: SkillInfo;
  workspace?: string;
  onBackToDirectory: () => void;
}) {
  // 仅工作区级 skill 需要带 workspace
  const skillWorkspace = skill.source === "workspace" ? workspace : undefined;

  const [tree, setTree] = useState<SkillFileNode[]>([]);
  const [loadingTree, setLoadingTree] = useState(false);
  const [treeError, setTreeError] = useState("");

  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [loadingFile, setLoadingFile] = useState(false);
  const [saving, setSaving] = useState(false);
  const [fileError, setFileError] = useState("");

  const dirty = content !== savedContent;
  const selectedName = selectedPath ? selectedPath.split("/").pop() || selectedPath : "";

  const loadTree = useCallback(async () => {
    setLoadingTree(true);
    setTreeError("");
    try {
      const data = await getSkillTree(skill.name, skillWorkspace);
      setTree(data.tree || []);
    } catch (err) {
      setTreeError((err as Error).message);
      setTree([]);
    }
    setLoadingTree(false);
  }, [skill.name, skillWorkspace]);

  useEffect(() => {
    loadTree();
  }, [loadTree]);

  const openFile = useCallback(async (path: string) => {
    setSelectedPath(path);
    setLoadingFile(true);
    setFileError("");
    try {
      const data = await readSkillFile(skill.name, path, skillWorkspace);
      setContent(data.content);
      setSavedContent(data.content);
    } catch (err) {
      setFileError((err as Error).message);
      setContent("");
      setSavedContent("");
    }
    setLoadingFile(false);
  }, [skill.name, skillWorkspace]);

  const handleSave = useCallback(async () => {
    if (!selectedPath || saving) return;
    setSaving(true);
    setFileError("");
    try {
      await writeSkillFile(skill.name, selectedPath, content, skillWorkspace);
      setSavedContent(content);
    } catch (err) {
      setFileError((err as Error).message);
    }
    setSaving(false);
  }, [selectedPath, saving, content, skill.name, skillWorkspace]);

  const handleCreate = async (isDir: boolean) => {
    const input = window.prompt(isDir ? "新建目录（相对 skill 根目录的路径）" : "新建文件（相对 skill 根目录的路径）");
    if (!input || !input.trim()) return;
    let rel = input.trim().replace(/\\/g, "/");
    if (isDir && !rel.endsWith("/")) rel += "/";
    try {
      await createSkillFile(skill.name, rel, "", skillWorkspace);
      await loadTree();
      if (!isDir) openFile(rel.replace(/\/$/, ""));
    } catch (err) {
      setTreeError((err as Error).message);
    }
  };

  const handleDelete = async (node: SkillFileNode) => {
    const ok = window.confirm(`确认删除 ${node.type === "directory" ? "目录" : "文件"} "${node.path}"？此操作不可撤销。`);
    if (!ok) return;
    try {
      await deleteSkillFile(skill.name, node.path, skillWorkspace);
      if (selectedPath === node.path || (node.type === "directory" && selectedPath?.startsWith(node.path + "/"))) {
        setSelectedPath(null);
        setContent("");
        setSavedContent("");
      }
      await loadTree();
    } catch (err) {
      setTreeError((err as Error).message);
    }
  };

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* 顶部栏 */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-border shrink-0">
        <Button variant="ghost" size="sm" onClick={onBackToDirectory}>
          <ArrowLeft className="w-4 h-4" />
          Directory
        </Button>
        <div className="text-sm font-medium flex items-center gap-1.5">
          <Boxes className="w-4 h-4 text-primary" />
          <span>{skill.name}</span>
        </div>
        {selectedName && (
          <>
            <span className="text-muted-foreground">/</span>
            <span className="text-sm font-mono text-muted-foreground">{selectedName}</span>
            {dirty && <span className="text-xs text-amber-500">●</span>}
          </>
        )}
        <div className="flex-1" />
        {selectedPath && (
          <Button size="sm" onClick={handleSave} disabled={saving || !dirty}>
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
            保存
          </Button>
        )}
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* 左侧：文件树 */}
        <div className="w-64 shrink-0 border-r border-border flex flex-col overflow-hidden">
          <div className="flex items-center justify-between px-3 py-2 border-b border-border">
            <span className="text-xs font-medium text-muted-foreground">文件</span>
            <div className="flex items-center gap-0.5">
              <button onClick={() => handleCreate(false)} className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted/50" title="新建文件">
                <FilePlus className="w-3.5 h-3.5" />
              </button>
              <button onClick={() => handleCreate(true)} className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted/50" title="新建目录">
                <FolderPlus className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto px-2 py-2">
            {loadingTree && (
              <div className="flex justify-center py-4"><Loader2 className="w-4 h-4 animate-spin text-muted-foreground" /></div>
            )}
            {treeError && <div className="text-xs text-red-500 p-2">{treeError}</div>}
            {!loadingTree && !treeError && tree.length === 0 && (
              <div className="text-xs text-muted-foreground p-2">目录为空</div>
            )}
            <FileTree nodes={tree} selectedPath={selectedPath} onSelectFile={openFile} onDelete={handleDelete} />
          </div>
        </div>

        {/* 右侧：编辑器 */}
        <div className="flex-1 flex flex-col overflow-hidden bg-background">
          {fileError && <div className="text-xs text-red-500 px-4 py-2 border-b border-border">{fileError}</div>}
          {!selectedPath && (
            <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
              从左侧选择一个文件进行查看或编辑
            </div>
          )}
          {selectedPath && (
            loadingFile ? (
              <div className="flex-1 flex items-center justify-center">
                <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <CodeEditor fileName={selectedName} value={content} onChange={setContent} onSave={handleSave} />
            )
          )}
        </div>
      </div>
    </div>
  );
}

/** 递归渲染目录树 */
function FileTree({
  nodes,
  selectedPath,
  onSelectFile,
  onDelete,
  depth = 0,
}: {
  nodes: SkillFileNode[];
  selectedPath: string | null;
  onSelectFile: (path: string) => void;
  onDelete: (node: SkillFileNode) => void;
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
  depth,
}: {
  node: SkillFileNode;
  selectedPath: string | null;
  onSelectFile: (path: string) => void;
  onDelete: (node: SkillFileNode) => void;
  depth: number;
}) {
  const [expanded, setExpanded] = useState(depth === 0);
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
          <button
            onClick={(e) => { e.stopPropagation(); onDelete(node); }}
            className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-muted-foreground hover:text-red-500 shrink-0"
            title="删除目录"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
        {expanded && node.children && node.children.length > 0 && (
          <FileTree
            nodes={node.children}
            selectedPath={selectedPath}
            onSelectFile={onSelectFile}
            onDelete={onDelete}
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
      <button
        onClick={(e) => { e.stopPropagation(); onDelete(node); }}
        className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-muted-foreground hover:text-red-500 shrink-0"
        title="删除文件"
      >
        <Trash2 className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

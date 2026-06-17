/**
 * PowerStudio —— Power 能力套件编辑器（编辑器 Tab WebView）
 *
 * 展示和编辑一个 Power 的全部内容：
 *   - 概览：POWER.md 文档、启用/禁用
 *   - MCP 服务器：列表、增删、编辑配置
 *   - Skills：捆绑的 Skill 列表、增删、编辑 SKILL.md
 *   - Steering：工作流引导文件列表
 */

import { useState, useEffect, useCallback } from "react";
import {
  Loader2,
  Plug,
  Package,
  FileText,
  Save,
  Zap,
  BookOpen,
  Plus,
  Trash2,
  Check,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CodeEditor } from "@/components/CodeEditor";
import {
  getPower,
  togglePower,
  savePowerMcpConfig,
  addPowerSkill,
  removePowerSkill,
  addPowerMcpServer,
  removePowerMcpServer,
  getMcpConfig,
  openFileInEditor,
  type RawMcpServer,
  type PowerDetail,
} from "@/lib/apiClient";

/** 运行时判断是否在 VS Code webview 中 */
function isInVSCodeEnv(): boolean {
  return typeof window !== "undefined" && !!(window as any).__axonVSCode;
}

interface PowerStudioProps {
  workspace: string;
  powerName: string;
}

type Tab = "overview" | "mcp" | "skills" | "steering";

export function PowerStudio({ workspace, powerName }: PowerStudioProps) {
  const [power, setPower] = useState<PowerDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("overview");

  const loadPower = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getPower(powerName, workspace);
      setPower(data);
    } catch (e) {
      setError((e as Error).message || "加载失败");
    } finally {
      setLoading(false);
    }
  }, [powerName, workspace]);

  useEffect(() => {
    loadPower();
  }, [loadPower]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground">
        <Loader2 className="w-5 h-5 animate-spin mr-2" />
        加载中...
      </div>
    );
  }

  if (error || !power) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
        {error || `未找到 Power: ${powerName}`}
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* 头部 */}
      <div className="px-5 pt-4 pb-3 border-b border-border">
        <div className="flex items-center gap-3">
          <Zap className="w-5 h-5 text-primary shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="font-medium text-base">{power.displayName || power.name}</div>
            <div className="text-xs text-muted-foreground mt-0.5">{power.description}</div>
          </div>
          <PowerToggle power={power} workspace={workspace} onToggled={loadPower} />
        </div>
        {/* 统计标签 */}
        <div className="flex items-center gap-3 mt-2.5">
          {power.mcpServerCount > 0 && (
            <span className="flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-600 dark:text-blue-400">
              <Plug className="w-3 h-3" />
              {power.mcpServerCount} MCP
            </span>
          )}
          {power.skillCount > 0 && (
            <span className="flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full bg-violet-500/10 text-violet-600 dark:text-violet-400">
              <Package className="w-3 h-3" />
              {power.skillCount} Skills
            </span>
          )}
          {power.steeringFiles.length > 0 && (
            <span className="flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-600 dark:text-amber-400">
              <BookOpen className="w-3 h-3" />
              {power.steeringFiles.length} Steering
            </span>
          )}
          <span className="text-[11px] text-muted-foreground ml-auto">
            {power.source === "workspace" ? "项目级" : "全局"}
          </span>
        </div>
      </div>

      {/* Tab 切换 */}
      <div className="flex items-center gap-1 px-4 py-2 border-b border-border text-xs">
        <TabBtn active={tab === "overview"} onClick={() => setTab("overview")} icon={<FileText className="w-3 h-3" />} label="概览" />
        <TabBtn active={tab === "mcp"} onClick={() => setTab("mcp")} icon={<Plug className="w-3 h-3" />} label={`MCP${power.mcpServerCount ? ` (${power.mcpServerCount})` : ""}`} />
        <TabBtn active={tab === "skills"} onClick={() => setTab("skills")} icon={<Package className="w-3 h-3" />} label={`Skills${power.skillCount ? ` (${power.skillCount})` : ""}`} />
        <TabBtn active={tab === "steering"} onClick={() => setTab("steering")} icon={<BookOpen className="w-3 h-3" />} label={`Steering${power.steeringFiles.length ? ` (${power.steeringFiles.length})` : ""}`} />
      </div>

      {/* Tab 内容 */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {tab === "overview" && <OverviewTab power={power} />}
        {tab === "mcp" && <McpTab power={power} workspace={workspace} onSaved={loadPower} />}
        {tab === "skills" && <SkillsTab power={power} workspace={workspace} onChanged={loadPower} />}
        {tab === "steering" && <SteeringTab power={power} workspace={workspace} onChanged={loadPower} />}
      </div>
    </div>
  );
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 子组件
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function TabBtn({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1 px-2.5 py-1.5 rounded transition-colors ${active ? "bg-primary/10 text-primary font-medium" : "text-muted-foreground hover:text-foreground hover:bg-muted/50"}`}
    >
      {icon}
      {label}
    </button>
  );
}

/**
 * 删除确认按钮：webview sandbox 下 confirm()/alert() 被禁用，改用内联二次确认。
 * 第一次点击进入「确认?」状态，再次点击才触发 onConfirm；3 秒无操作自动复位。
 */
function ConfirmIconButton({ onConfirm, title, className }: { onConfirm: () => void; title: string; className?: string }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        if (armed) {
          onConfirm();
          setArmed(false);
        } else {
          setArmed(true);
        }
      }}
      className={className ?? `p-1 rounded transition-colors shrink-0 ${armed ? "text-red-500 bg-red-500/10" : "text-muted-foreground hover:text-red-500 hover:bg-muted"}`}
      title={armed ? "再次点击确认删除" : title}
    >
      {armed ? <span className="text-[10px] font-medium px-0.5">确认?</span> : <Trash2 className="w-3.5 h-3.5" />}
    </button>
  );
}

/** 启用/禁用切换 */
function PowerToggle({ power, workspace, onToggled }: { power: PowerDetail; workspace: string; onToggled: () => void }) {
  const [toggling, setToggling] = useState(false);

  const handleToggle = async () => {
    setToggling(true);
    try {
      await togglePower(power.name, !power.enabled, workspace);
      onToggled();
    } catch { /* 忽略 */ }
    setToggling(false);
  };

  return (
    <button
      onClick={handleToggle}
      disabled={toggling}
      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors shrink-0 ${power.enabled ? "bg-primary" : "bg-muted-foreground/30"}`}
      title={power.enabled ? "点击禁用" : "点击启用"}
    >
      {toggling ? (
        <Loader2 className="w-3.5 h-3.5 animate-spin absolute left-1/2 -translate-x-1/2 text-white" />
      ) : (
        <span className={`inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${power.enabled ? "translate-x-6" : "translate-x-1"}`} />
      )}
    </button>
  );
}

// ── 概览 Tab ──

function OverviewTab({ power }: { power: PowerDetail }) {
  /** 请求 VS Code 打开 POWER.md 文件编辑 */
  const handleEdit = () => {
    const vs = (window as any).__axonVSCode;
    if (vs) {
      vs.postMessage({ type: "open_file", filePath: power.powerFile });
    }
  };

  return (
    <div className="p-5 space-y-4">
      {/* 关键词 */}
      {power.keywords.length > 0 && (
        <div>
          <div className="text-xs font-medium text-muted-foreground mb-1.5">关键词</div>
          <div className="flex flex-wrap gap-1.5">
            {power.keywords.map((k) => (
              <span key={k} className="text-xs px-2 py-0.5 rounded-full bg-muted text-muted-foreground">{k}</span>
            ))}
          </div>
        </div>
      )}
      {/* POWER.md 正文 */}
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-xs font-medium text-muted-foreground">文档 (POWER.md)</span>
          <Button size="sm" variant="ghost" onClick={handleEdit} className="h-6 text-xs">
            <FileText className="w-3 h-3 mr-1" />
            编辑
          </Button>
        </div>
        <div className="rounded-lg border border-border p-4 text-sm whitespace-pre-wrap leading-relaxed">
          {power.body || <span className="text-muted-foreground italic">暂无文档内容。点击「编辑」打开文件。</span>}
        </div>
      </div>
      {/* 目录信息 */}
      <div className="text-xs text-muted-foreground">
        目录：<code className="bg-muted px-1 py-0.5 rounded">{power.dir}</code>
      </div>
    </div>
  );
}

// ── MCP Tab ──

function McpTab({ power, workspace, onSaved }: { power: PowerDetail; workspace: string; onSaved: () => void }) {
  const servers = power.mcpConfig?.mcpServers || {};
  const entries = Object.entries(servers);
  const [jsonContent, setJsonContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);
  const [newServerName, setNewServerName] = useState("");
  const [newCommand, setNewCommand] = useState("");
  const [newArgs, setNewArgs] = useState("");
  const [adding, setAdding] = useState(false);
  // 便捷操作：从系统已有 MCP（用户级/工作区级 .axon/settings/mcp.json）导入到本 Power
  const [available, setAvailable] = useState<{ name: string; server: RawMcpServer; level: string }[]>([]);
  const [showImport, setShowImport] = useState(false);

  // 初始化编辑内容
  useEffect(() => {
    if (power.mcpConfig) {
      setJsonContent(JSON.stringify(power.mcpConfig, null, 2));
    } else {
      setJsonContent(JSON.stringify({ mcpServers: {} }, null, 2));
    }
  }, [power.mcpConfig]);

  // 加载系统已有 MCP，供"从已有导入"选择
  useEffect(() => {
    getMcpConfig(workspace || undefined).then((cfg) => {
      const list: { name: string; server: RawMcpServer; level: string }[] = [];
      for (const [n, s] of Object.entries(cfg.user.mcpServers || {})) list.push({ name: n, server: s, level: "用户级" });
      for (const [n, s] of Object.entries(cfg.workspace.mcpServers || {})) list.push({ name: n, server: s, level: "工作区级" });
      setAvailable(list);
    }).catch(() => { /* 拉取失败不影响手动添加 */ });
  }, [workspace]);

  /** 从系统已有 MCP 导入一个 server 到本 Power（整对象拷贝，兼容 stdio/http） */
  const handleImport = async (name: string, server: RawMcpServer) => {
    try {
      const merged = { mcpServers: { ...(power.mcpConfig?.mcpServers || {}), [name]: server } };
      await savePowerMcpConfig(power.name, merged, workspace);
      setShowImport(false);
      onSaved();
    } catch (e) {
      alert(`导入失败: ${(e as Error).message}`);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const config = JSON.parse(jsonContent);
      await savePowerMcpConfig(power.name, config, workspace);
      onSaved();
    } catch (e) {
      alert(`保存失败: ${(e as Error).message}`);
    }
    setSaving(false);
  };

  const handleAdd = async () => {
    if (!newServerName.trim() || !newCommand.trim()) return;
    setAdding(true);
    try {
      const args = newArgs.trim() ? newArgs.trim().split(/\s+/) : undefined;
      await addPowerMcpServer(power.name, newServerName.trim(), { command: newCommand.trim(), args }, workspace);
      setNewServerName("");
      setNewCommand("");
      setNewArgs("");
      setShowAddForm(false);
      onSaved();
    } catch (e) {
      alert(`添加失败: ${(e as Error).message}`);
    }
    setAdding(false);
  };

  const handleRemove = async (name: string) => {
    try {
      await removePowerMcpServer(power.name, name, workspace);
      onSaved();
    } catch (e) {
      alert(`移除失败: ${(e as Error).message}`);
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* MCP 列表 */}
      <div className="px-5 pt-4 pb-2">
        <div className="flex items-center justify-between mb-3">
          <span className="text-sm font-medium">MCP 服务器</span>
          <div className="flex gap-2">
            {available.length > 0 && (
              <Button size="sm" variant="outline" onClick={() => setShowImport(!showImport)}>
                <Plug className="w-3.5 h-3.5" />
                从已有导入
              </Button>
            )}
            <Button size="sm" variant="outline" onClick={() => setShowAddForm(!showAddForm)}>
              <Plus className="w-3.5 h-3.5" />
              添加
            </Button>
          </div>
        </div>

        {/* 从系统已有 MCP 导入（便捷操作） */}
        {showImport && (
          <div className="mb-3 p-2 rounded-lg border border-border bg-muted/20">
            <div className="text-xs text-muted-foreground px-1 pb-2">选择系统已配置的 MCP 服务器，一键加入本 Power：</div>
            <div className="space-y-1 max-h-48 overflow-auto">
              {available
                .filter((a) => !(a.name in servers))
                .map((a) => (
                  <button
                    key={`${a.level}-${a.name}`}
                    onClick={() => handleImport(a.name, a.server)}
                    className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-left hover:bg-muted transition-colors"
                  >
                    <Plug className="w-3.5 h-3.5 text-blue-500 shrink-0" />
                    <span className="text-sm truncate flex-1">{a.name}</span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground shrink-0">{a.level}</span>
                  </button>
                ))}
              {available.filter((a) => !(a.name in servers)).length === 0 && (
                <div className="text-xs text-muted-foreground px-1 py-2">系统已有的 MCP 都已加入本 Power。</div>
              )}
            </div>
          </div>
        )}

        {/* 添加表单 */}
        {showAddForm && (
          <div className="mb-3 p-3 rounded-lg border border-border bg-muted/20 space-y-2">
            <Input
              placeholder="服务器名称，如 my-mcp"
              value={newServerName}
              onChange={(e) => setNewServerName(e.target.value)}
              className="h-8 text-sm"
            />
            <Input
              placeholder="命令，如 uvx 或 node"
              value={newCommand}
              onChange={(e) => setNewCommand(e.target.value)}
              className="h-8 text-sm"
            />
            <Input
              placeholder="参数（空格分隔），如 my-server@latest --flag"
              value={newArgs}
              onChange={(e) => setNewArgs(e.target.value)}
              className="h-8 text-sm"
            />
            <div className="flex gap-2">
              <Button size="sm" onClick={handleAdd} disabled={adding || !newServerName.trim() || !newCommand.trim()}>
                {adding ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "确认添加"}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setShowAddForm(false)}>取消</Button>
            </div>
          </div>
        )}

        {entries.length === 0 && !showAddForm && (
          <div className="text-sm text-muted-foreground py-4 text-center border border-dashed border-border rounded-lg">
            暂未配置 MCP 服务器。点击上方「添加」按钮。
          </div>
        )}
        {entries.length > 0 && (
          <div className="space-y-2 mb-3">
            {entries.map(([name, server]) => (
              <div key={name} className="group flex items-center gap-2 px-3 py-2 rounded-lg border border-border bg-muted/20">
                <Plug className="w-4 h-4 text-blue-500 shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium truncate">{name}</div>
                  <div className="text-xs text-muted-foreground truncate">
                    {server.command} {(server.args || []).join(" ")}
                  </div>
                </div>
                {server.disabled && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">禁用</span>
                )}
                <ConfirmIconButton
                  onConfirm={() => handleRemove(name)}
                  title="移除"
                  className="opacity-0 group-hover:opacity-100 p-1 rounded text-muted-foreground hover:text-red-500 hover:bg-muted transition-opacity"
                />
              </div>
            ))}
          </div>
        )}
      </div>
      {/* JSON 编辑：VS Code 用原生编辑器打开，浏览器用内嵌 CodeEditor */}
      <div className="flex items-center justify-between px-5 py-2 border-t border-border">
        <span className="text-xs text-muted-foreground">高级：直接编辑 mcp.json</span>
        {isInVSCodeEnv() ? (
          <Button size="sm" onClick={() => openFileInEditor(`${power.dir}/mcp.json`)}>
            在编辑器中打开
          </Button>
        ) : (
          <Button size="sm" onClick={handleSave} disabled={saving}>
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
            保存
          </Button>
        )}
      </div>
      {!isInVSCodeEnv() && (
        <div className="flex-1 min-h-0 border-t border-border">
          <CodeEditor fileName="mcp.json" value={jsonContent} onChange={setJsonContent} onSave={handleSave} />
        </div>
      )}
    </div>
  );
}

// ── Skills Tab ──

function SkillsTab({ power, workspace, onChanged }: { power: PowerDetail; workspace: string; onChanged: () => void }) {
  const skills = power.skills || [];
  const [addMode, setAddMode] = useState<null | "create" | "select" | "import">(null);
  const [newSkillName, setNewSkillName] = useState("");
  const [newSkillDesc, setNewSkillDesc] = useState("");
  const [adding, setAdding] = useState(false);
  // 可选的现有 Skill 列表
  const [availableSkills, setAvailableSkills] = useState<{ name: string; description: string; source: string }[]>([]);
  const [loadingSkills, setLoadingSkills] = useState(false);
  const [searchFilter, setSearchFilter] = useState("");
  // 「选择现有」多选：已勾选的 Skill 名称集合
  const [selectedNames, setSelectedNames] = useState<Set<string>>(new Set());

  // 监听导入成功的消息（VS Code Extension Host 发回）
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data;
      if (msg && msg.type === "skill_imported" && msg.powerName === power.name) {
        onChanged();
        setAddMode(null);
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [power.name, onChanged]);

  // 加载可选的 Skill 列表
  const loadAvailableSkills = useCallback(async () => {
    setLoadingSkills(true);
    setSelectedNames(new Set());
    try {
      const { listSkills } = await import("@/lib/apiClient");
      const data = await listSkills();
      // 过滤掉已经在 power 里的
      const existing = new Set(skills.map((s) => s.name));
      const filtered = (data.skills || []).filter((s) => !existing.has(s.name) && !s.disabled);
      setAvailableSkills(filtered.map((s) => ({ name: s.name, description: s.description, source: s.source })));
    } catch { setAvailableSkills([]); }
    setLoadingSkills(false);
  }, [skills]);

  // 切到 select 模式时加载
  useEffect(() => {
    if (addMode === "select") loadAvailableSkills();
  }, [addMode, loadAvailableSkills]);

  const handleCreate = async () => {
    if (!newSkillName.trim()) return;
    setAdding(true);
    try {
      await addPowerSkill(power.name, newSkillName.trim(), newSkillDesc.trim() || undefined, workspace);
      setNewSkillName("");
      setNewSkillDesc("");
      setAddMode(null);
      onChanged();
    } catch (e) {
      alert(`添加失败: ${(e as Error).message}`);
    }
    setAdding(false);
  };

  /** 把一个现有 Skill 复制进 Power（读取完整 SKILL.md 内容覆盖写入），返回是否成功。 */
  const addOneExisting = async (skillName: string): Promise<boolean> => {
    try {
      const { readSkillFile, savePowerSkillContent } = await import("@/lib/apiClient");
      let content = "";
      try {
        const data = await readSkillFile(skillName, "SKILL.md", workspace);
        content = data.content;
      } catch {
        // 读不到完整内容就用简单描述创建
        const skill = availableSkills.find((s) => s.name === skillName);
        await addPowerSkill(power.name, skillName, skill?.description, workspace);
        return true;
      }
      await addPowerSkill(power.name, skillName, undefined, workspace);
      await savePowerSkillContent(power.name, skillName, content, workspace);
      return true;
    } catch {
      return false;
    }
  };

  /** 批量添加所有已勾选的现有 Skill。 */
  const handleAddSelected = async () => {
    if (selectedNames.size === 0) return;
    setAdding(true);
    let ok = 0;
    const failed: string[] = [];
    for (const name of selectedNames) {
      const success = await addOneExisting(name);
      if (success) ok++;
      else failed.push(name);
    }
    setAdding(false);
    setSelectedNames(new Set());
    setAddMode(null);
    onChanged();
    if (failed.length > 0) {
      alert(`${ok} 个 Skill 添加成功，${failed.length} 个失败：${failed.join("、")}`);
    }
  };

  /** 切换单个 Skill 的勾选状态。 */
  const toggleSelect = (name: string) => {
    setSelectedNames((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const handleRemove = async (skillName: string) => {
    try {
      await removePowerSkill(power.name, skillName, workspace);
      onChanged();
    } catch (e) {
      alert(`移除失败: ${(e as Error).message}`);
    }
  };

  const filteredAvailable = searchFilter
    ? availableSkills.filter((s) => s.name.includes(searchFilter.toLowerCase()) || s.description.toLowerCase().includes(searchFilter.toLowerCase()))
    : availableSkills;

  // 当前筛选结果是否已全部勾选
  const allFilteredSelected = filteredAvailable.length > 0 && filteredAvailable.every((s) => selectedNames.has(s.name));

  /** 全选 / 取消全选当前筛选结果。 */
  const toggleSelectAll = () => {
    setSelectedNames((prev) => {
      const next = new Set(prev);
      if (allFilteredSelected) {
        filteredAvailable.forEach((s) => next.delete(s.name));
      } else {
        filteredAvailable.forEach((s) => next.add(s.name));
      }
      return next;
    });
  };

  return (
    <div className="p-5">
      <div className="flex items-center justify-between mb-3">
        <span className="text-sm font-medium">捆绑的 Skills</span>
        <Button size="sm" variant="outline" onClick={() => setAddMode(addMode ? null : "select")}>
          <Plus className="w-3.5 h-3.5" />
          添加 Skill
        </Button>
      </div>

      {/* 添加面板 */}
      {addMode && (
        <div className="mb-4 rounded-lg border border-border overflow-hidden">
          {/* 模式切换 Tab */}
          <div className="flex border-b border-border bg-muted/30">
            <button
              onClick={() => setAddMode("select")}
              className={`flex-1 px-3 py-2 text-xs font-medium transition-colors ${addMode === "select" ? "bg-background text-foreground border-b-2 border-primary" : "text-muted-foreground hover:text-foreground"}`}
            >
              选择现有
            </button>
            <button
              onClick={() => setAddMode("create")}
              className={`flex-1 px-3 py-2 text-xs font-medium transition-colors ${addMode === "create" ? "bg-background text-foreground border-b-2 border-primary" : "text-muted-foreground hover:text-foreground"}`}
            >
              新建
            </button>
            <button
              onClick={() => setAddMode("import")}
              className={`flex-1 px-3 py-2 text-xs font-medium transition-colors ${addMode === "import" ? "bg-background text-foreground border-b-2 border-primary" : "text-muted-foreground hover:text-foreground"}`}
            >
              导入
            </button>
          </div>

          <div className="p-3">
            {/* 选择现有 Skill（多选） */}
            {addMode === "select" && (
              <div className="space-y-2">
                <Input
                  placeholder="搜索可用的 Skill..."
                  value={searchFilter}
                  onChange={(e) => setSearchFilter(e.target.value)}
                  className="h-8 text-sm"
                />
                {loadingSkills && (
                  <div className="flex justify-center py-3"><Loader2 className="w-4 h-4 animate-spin text-muted-foreground" /></div>
                )}
                {!loadingSkills && filteredAvailable.length === 0 && (
                  <div className="text-xs text-muted-foreground text-center py-3">
                    {searchFilter ? "没有匹配的 Skill" : "没有可选的 Skill（全部已添加或无可用 Skill）"}
                  </div>
                )}
                {!loadingSkills && filteredAvailable.length > 0 && (
                  <div className="flex items-center justify-between px-1">
                    <button
                      onClick={toggleSelectAll}
                      className="text-xs text-primary hover:underline"
                    >
                      {allFilteredSelected ? "取消全选" : `全选（${filteredAvailable.length}）`}
                    </button>
                    <span className="text-[10px] text-muted-foreground">已选 {selectedNames.size}</span>
                  </div>
                )}
                <div className="max-h-48 overflow-y-auto space-y-1">
                  {filteredAvailable.map((s) => {
                    const checked = selectedNames.has(s.name);
                    return (
                      <button
                        key={s.name}
                        onClick={() => toggleSelect(s.name)}
                        disabled={adding}
                        className={`w-full text-left flex items-center gap-2 px-3 py-2 rounded-md transition-colors disabled:opacity-50 ${checked ? "bg-primary/10" : "hover:bg-muted/50"}`}
                      >
                        <span className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 ${checked ? "bg-primary border-primary text-primary-foreground" : "border-muted-foreground/40"}`}>
                          {checked && <Check className="w-3 h-3" />}
                        </span>
                        <Package className="w-3.5 h-3.5 text-violet-500 shrink-0" />
                        <div className="min-w-0 flex-1">
                          <div className="text-sm font-medium truncate">{s.name}</div>
                          {s.description && <div className="text-xs text-muted-foreground truncate">{s.description}</div>}
                        </div>
                        <span className="text-[10px] text-muted-foreground shrink-0">{s.source === "workspace" ? "项目" : s.source === "global" ? "全局" : "内置"}</span>
                      </button>
                    );
                  })}
                </div>
                <div className="flex gap-2 pt-1">
                  <Button size="sm" onClick={handleAddSelected} disabled={adding || selectedNames.size === 0}>
                    {adding ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : `添加选中（${selectedNames.size}）`}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setAddMode(null)}>取消</Button>
                </div>
              </div>
            )}

            {/* 新建 Skill */}
            {addMode === "create" && (
              <div className="space-y-2">
                <Input
                  placeholder="Skill 名称（英文短横线），如 query-log"
                  value={newSkillName}
                  onChange={(e) => setNewSkillName(e.target.value)}
                  className="h-8 text-sm"
                />
                <Input
                  placeholder="描述（可选），如 查询 SLS 日志"
                  value={newSkillDesc}
                  onChange={(e) => setNewSkillDesc(e.target.value)}
                  className="h-8 text-sm"
                />
                <div className="flex gap-2">
                  <Button size="sm" onClick={handleCreate} disabled={adding || !newSkillName.trim()}>
                    {adding ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "确认创建"}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setAddMode(null)}>取消</Button>
                </div>
              </div>
            )}

            {/* 导入 Skill */}
            {addMode === "import" && (
              <div className="space-y-3">
                <div className="text-xs text-muted-foreground">
                  从本地目录导入一个 Skill（目录应包含 SKILL.md）。
                </div>
                <Button
                  size="sm"
                  onClick={async () => {
                    // 通过 VS Code Extension Host 打开目录选择器
                    const vs = (window as any).__axonVSCode;
                    if (vs) {
                      vs.postMessage({ type: "import_skill_to_power", powerName: power.name, workspace });
                    } else {
                      alert("导入功能仅在 VS Code 中可用。请使用命令面板「Axon: 导入 Skill 到 Power」。");
                    }
                  }}
                >
                  选择目录导入
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setAddMode(null)}>取消</Button>
              </div>
            )}
          </div>
        </div>
      )}

      {skills.length === 0 && !addMode && (
        <div className="text-sm text-muted-foreground py-8 text-center border border-dashed border-border rounded-lg">
          暂无捆绑 Skill。点击上方「添加 Skill」选择或创建。
        </div>
      )}
      {skills.length > 0 && (
        <div className="space-y-2">
          {skills.map((s) => (
            <div key={s.name} className="group flex items-start gap-2 px-3 py-2.5 rounded-lg border border-border bg-muted/20">
              <Package className="w-4 h-4 text-violet-500 shrink-0 mt-0.5" />
              <button
                className="min-w-0 flex-1 text-left"
                onClick={() => {
                  // 打开 SKILL.md 编辑
                  const vs = (window as any).__axonVSCode;
                  if (vs) {
                    const path = `${s.dir}/SKILL.md`;
                    vs.postMessage({ type: "open_file", filePath: path });
                  }
                }}
              >
                <div className="text-sm font-medium hover:text-primary transition-colors">{s.name}</div>
                {s.description && (
                  <div className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{s.description}</div>
                )}
              </button>
              <ConfirmIconButton
                onConfirm={() => handleRemove(s.name)}
                title="移除"
                className="opacity-0 group-hover:opacity-100 p-1 rounded text-muted-foreground hover:text-red-500 hover:bg-muted transition-opacity shrink-0"
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Steering Tab ──

function SteeringTab({ power, workspace, onChanged }: { power: PowerDetail; workspace: string; onChanged: () => void }) {
  const files = power.steeringFiles || [];
  const [creating, setCreating] = useState(false);
  const [newFileName, setNewFileName] = useState("");

  /** 点击文件名 → 在 VS Code 编辑器打开 */
  const handleOpen = (fileName: string) => {
    const vs = (window as any).__axonVSCode;
    if (vs) {
      const path = `${power.dir}/steering/${fileName}`;
      vs.postMessage({ type: "open_file", filePath: path });
    }
  };

  /** 新建 steering 文件 */
  const handleCreate = async () => {
    if (!newFileName.trim()) return;
    let name = newFileName.trim();
    if (!name.endsWith(".md")) name += ".md";
    // 重名校验
    if (files.includes(name)) {
      alert(`Steering 文件「${name}」已存在`);
      return;
    }
    const vs = (window as any).__axonVSCode;
    if (vs) {
      vs.postMessage({ type: "create_steering_file", powerName: power.name, fileName: name, workspace });
    }
    setNewFileName("");
    setCreating(false);
    // 延迟刷新（等 Extension Host 创建完文件）
    setTimeout(onChanged, 500);
  };

  /** 导入 steering 文件 */
  const handleImport = () => {
    const vs = (window as any).__axonVSCode;
    if (vs) {
      vs.postMessage({ type: "import_steering_file", powerName: power.name, workspace });
    }
  };

  /** 删除 steering 文件 */
  const handleDelete = (fileName: string) => {
    const vs = (window as any).__axonVSCode;
    if (vs) {
      vs.postMessage({ type: "delete_steering_file", powerName: power.name, fileName, workspace });
      // 延迟刷新
      setTimeout(onChanged, 300);
    }
  };

  // 监听导入成功消息
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data;
      if (msg && msg.type === "steering_imported" && msg.powerName === power.name) {
        onChanged();
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [power.name, onChanged]);

  return (
    <div className="p-5">
      <div className="flex items-center justify-between mb-3">
        <span className="text-sm font-medium">工作流引导</span>
        <div className="flex gap-1">
          <Button size="sm" variant="outline" onClick={handleImport} title="从文件导入">
            <FileText className="w-3.5 h-3.5" />
            导入
          </Button>
          <Button size="sm" variant="outline" onClick={() => setCreating(!creating)}>
            <Plus className="w-3.5 h-3.5" />
            新建
          </Button>
        </div>
      </div>

      {/* 新建表单 */}
      {creating && (
        <div className="mb-3 p-3 rounded-lg border border-border bg-muted/20 space-y-2">
          <Input
            placeholder="文件名，如 getting-started.md"
            value={newFileName}
            onChange={(e) => setNewFileName(e.target.value)}
            className="h-8 text-sm"
          />
          <div className="flex gap-2">
            <Button size="sm" onClick={handleCreate} disabled={!newFileName.trim()}>
              确认创建
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setCreating(false)}>取消</Button>
          </div>
        </div>
      )}

      {files.length === 0 && !creating && (
        <div className="text-sm text-muted-foreground py-8 text-center border border-dashed border-border rounded-lg">
          暂无 Steering 文件。点击「新建」或「导入」添加。
        </div>
      )}
      {files.length > 0 && (
        <div className="space-y-2">
          {files.map((f) => (
            <div key={f} className="group flex items-center gap-2 px-3 py-2 rounded-lg border border-border bg-muted/20 hover:border-primary/50 hover:bg-muted/40 transition-colors">
              <button
                onClick={() => handleOpen(f)}
                className="flex items-center gap-2 flex-1 min-w-0 text-left"
              >
                <BookOpen className="w-4 h-4 text-amber-500 shrink-0" />
                <span className="text-sm flex-1 truncate">{f}</span>
                <span className="text-[10px] text-muted-foreground shrink-0">点击编辑</span>
              </button>
              <ConfirmIconButton
                onConfirm={() => handleDelete(f)}
                title="删除"
                className="opacity-0 group-hover:opacity-100 p-1 rounded text-muted-foreground hover:text-red-500 hover:bg-muted transition-opacity shrink-0"
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

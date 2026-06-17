/**
 * McpStudio —— 全局 MCP 配置管理器（编辑器 Tab WebView，view=mcp）
 *
 * 管理独立于 Power 的 .axon/settings/mcp.json：
 *   - 用户级（全局，对所有工作区生效）
 *   - 工作区级（仅当前项目）
 * 每级支持：列表 / 增删 server / 直接编辑 mcp.json（高级）。
 * 与 Power 内嵌的 MCP 配置互补，三者由 core 的 McpRegistry 聚合后供 Agent 使用。
 */

import { useState, useEffect, useCallback } from "react";
import { Loader2, Plug, Plus, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CodeEditor } from "@/components/CodeEditor";
import {
  getMcpConfig,
  saveMcpConfig,
  addMcpServer,
  removeMcpServer,
  openMcpConfigInEditor,
  type McpLevel,
  type RawMcpConfig,
} from "@/lib/apiClient";

/** 运行时判断是否在 VS Code webview 中（避免顶层 import transport 影响模块求值顺序） */
function isInVSCode(): boolean {
  return typeof window !== "undefined" && !!(window as any).__axonVSCode;
}

interface McpStudioProps {
  /** 当前工作区路径（空则只能管理用户级） */
  workspace: string;
}

const EMPTY: RawMcpConfig = { mcpServers: {} };

export function McpStudio({ workspace }: McpStudioProps) {
  const [level, setLevel] = useState<McpLevel>(workspace ? "workspace" : "user");
  const [config, setConfig] = useState<{ user: RawMcpConfig; workspace: RawMcpConfig }>({ user: EMPTY, workspace: EMPTY });
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setConfig(await getMcpConfig(workspace || undefined));
    } catch (e) {
      console.warn("加载 MCP 配置失败", e);
    }
    setLoading(false);
  }, [workspace]);

  useEffect(() => { load(); }, [load]);

  if (loading) {
    return <div className="flex items-center justify-center h-full text-muted-foreground"><Loader2 className="w-5 h-5 animate-spin" /></div>;
  }

  const current = level === "user" ? config.user : config.workspace;

  return (
    <div className="flex flex-col h-full">
      {/* 标题 + level 切换 */}
      <div className="px-5 pt-4 pb-2 border-b border-border">
        <div className="flex items-center gap-2 mb-3">
          <Plug className="w-4 h-4 text-blue-500" />
          <span className="text-sm font-medium">MCP 服务器配置</span>
        </div>
        <div className="flex gap-1">
          <LevelButton active={level === "user"} onClick={() => setLevel("user")} label="用户级（全局）" />
          <LevelButton active={level === "workspace"} onClick={() => setLevel("workspace")} label="工作区级" disabled={!workspace} />
        </div>
      </div>
      <LevelEditor key={level} level={level} config={current} workspace={workspace} onChanged={load} />
    </div>
  );
}

function LevelButton({ active, onClick, label, disabled }: { active: boolean; onClick: () => void; label: string; disabled?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`px-3 py-1.5 text-xs rounded-md transition-colors ${active ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"} disabled:opacity-40 disabled:cursor-not-allowed`}
    >
      {label}
    </button>
  );
}

/** 单个 level 的编辑区：列表 + 增删 + JSON 高级编辑 */
function LevelEditor({ level, config, workspace, onChanged }: { level: McpLevel; config: RawMcpConfig; workspace: string; onChanged: () => void }) {
  // 未禁用排前、禁用排后
  const entries = Object.entries(config.mcpServers || {}).sort(
    ([, a], [, b]) => Number(!!a.disabled) - Number(!!b.disabled),
  );
  const [jsonContent, setJsonContent] = useState(JSON.stringify(config, null, 2));
  const [saving, setSaving] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [url, setUrl] = useState("");

  useEffect(() => { setJsonContent(JSON.stringify(config, null, 2)); }, [config]);

  const wsArg = workspace || undefined;

  const handleSaveJson = async () => {
    setSaving(true);
    try {
      await saveMcpConfig(level, JSON.parse(jsonContent), wsArg);
      onChanged();
    } catch (e) {
      alert(`保存失败: ${(e as Error).message}`);
    }
    setSaving(false);
  };

  const handleAdd = async () => {
    if (!name.trim() || (!command.trim() && !url.trim())) return;
    try {
      const server = url.trim()
        ? { url: url.trim() }
        : { command: command.trim(), args: args.trim() ? args.trim().split(/\s+/) : undefined };
      await addMcpServer(level, name.trim(), server, wsArg);
      setName(""); setCommand(""); setArgs(""); setUrl(""); setShowAdd(false);
      onChanged();
    } catch (e) {
      alert(`添加失败: ${(e as Error).message}`);
    }
  };

  const handleRemove = async (serverName: string) => {
    if (!confirm(`确定移除 MCP 服务器「${serverName}」？`)) return;
    try {
      await removeMcpServer(level, serverName, wsArg);
      onChanged();
    } catch (e) {
      alert(`移除失败: ${(e as Error).message}`);
    }
  };

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="px-5 pt-4 pb-2">
        <div className="flex items-center justify-between mb-3">
          <span className="text-xs text-muted-foreground">{level === "user" ? "~/.axon/settings/mcp.json" : "<工作区>/.axon/settings/mcp.json"}</span>
          <Button size="sm" variant="outline" onClick={() => setShowAdd(!showAdd)}>
            <Plus className="w-3.5 h-3.5" />添加
          </Button>
        </div>

        {showAdd && (
          <div className="mb-3 p-3 rounded-lg border border-border bg-muted/20 space-y-2">
            <Input placeholder="服务器名称，如 github" value={name} onChange={(e) => setName(e.target.value)} className="h-8 text-sm" />
            <Input placeholder="命令（stdio），如 uvx 或 node" value={command} onChange={(e) => setCommand(e.target.value)} className="h-8 text-sm" />
            <Input placeholder="参数（空格分隔），如 my-server@latest" value={args} onChange={(e) => setArgs(e.target.value)} className="h-8 text-sm" />
            <Input placeholder="或：远程 URL（http），与命令二选一" value={url} onChange={(e) => setUrl(e.target.value)} className="h-8 text-sm" />
            <div className="flex gap-2">
              <Button size="sm" onClick={handleAdd} disabled={!name.trim() || (!command.trim() && !url.trim())}>确认添加</Button>
              <Button size="sm" variant="ghost" onClick={() => setShowAdd(false)}>取消</Button>
            </div>
          </div>
        )}

        {entries.length === 0 && !showAdd && (
          <div className="text-sm text-muted-foreground py-4 text-center border border-dashed border-border rounded-lg">
            该级别暂无 MCP 服务器。点击「添加」配置一个。
          </div>
        )}
        {entries.length > 0 && (
          <div className="space-y-2 mb-3">
            {entries.map(([sName, server]) => (
              <div key={sName} className={`group flex items-center gap-2 px-3 py-2 rounded-lg border border-border bg-muted/20 ${server.disabled ? "opacity-60" : ""}`}>
                <Plug className={`w-4 h-4 shrink-0 ${server.disabled ? "text-muted-foreground" : "text-blue-500"}`} />
                <div className="min-w-0 flex-1">
                  <div className={`text-sm font-medium truncate ${server.disabled ? "line-through text-muted-foreground" : ""}`}>{sName}</div>
                  <div className="text-xs text-muted-foreground truncate">
                    {server.url ? server.url : `${server.command || ""} ${(server.args || []).join(" ")}`}
                  </div>
                </div>
                {server.disabled && <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">禁用</span>}
                <button onClick={() => handleRemove(sName)} className="opacity-0 group-hover:opacity-100 p-1 rounded text-muted-foreground hover:text-red-500 hover:bg-muted transition-opacity" title="移除">✕</button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between px-5 py-2 border-t border-border">
        <span className="text-xs text-muted-foreground">高级：直接编辑 mcp.json</span>
        {isInVSCode() ? (
          <Button size="sm" onClick={() => openMcpConfigInEditor(level, workspace || undefined)}>
            在编辑器中打开
          </Button>
        ) : (
          <Button size="sm" onClick={handleSaveJson} disabled={saving}>
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}保存
          </Button>
        )}
      </div>
      {!isInVSCode() && (
        <div className="flex-1 min-h-0 border-t border-border">
          <CodeEditor fileName="mcp.json" value={jsonContent} onChange={setJsonContent} onSave={handleSaveJson} />
        </div>
      )}
    </div>
  );
}

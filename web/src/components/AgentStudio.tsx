/**
 * Agent Studio - 自定义 Agent 管理页
 *
 * 用户在 .axon/agents/ 创建 JSON 配置，定义专属子 Agent 的角色和系统提示词。
 * 在 ChatPanel 输入框中用 @AgentName 调用，走 delegate_task(skill="AgentName", ...)
 */

import { useState, useEffect, useCallback } from "react";
import {
  ArrowLeft, Plus, Trash2, Save, Loader2, Bot, Check, X, RotateCcw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { MarkdownRenderer } from "@/components/MarkdownRenderer";

interface AgentJSON {
  name: string;
  description: string;
  systemPrompt: string;
}

interface AgentEntry {
  name: string;
  filename: string;
  description: string;
  systemPrompt: string;
}

interface AgentStudioProps {
  /** 当前工作区路径（用于读写 .axon/agents/） */
  workspace?: string;
  /** 返回聊天界面 */
  onBack: () => void;
}

/** 默认示例 Agent 模板 */
const DEFAULT_TEMPLATE: AgentJSON = {
  name: "",
  description: "",
  systemPrompt: `你是一个专业的子 Agent，由主 Agent 委派来完成独立任务。

## 你的角色

请在这里描述你的专长领域和职责。

## 工作方式

1. 专注完成被委派的任务，不要擅自扩大范围
2. 任务完成后给出结构化的中文总结作为最终结论
3. 纯分析任务不改代码，只有明确要求修改时才动文件

## 关注要点

- 列出你特有的检查项`,
};

export function AgentStudio({ workspace, onBack }: AgentStudioProps) {
  const [agents, setAgents] = useState<AgentEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<string | null>(null); // null = list view, filename = editing
  const [form, setForm] = useState<AgentJSON>({ ...DEFAULT_TEMPLATE });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // 加载 Agent 列表
  const loadAgents = useCallback(async () => {
    setLoading(true);
    try {
      const resp = await fetch(`/api/agents?workspace=${encodeURIComponent(workspace || "")}`);
      const data = await resp.json();
      setAgents(data.agents || []);
    } catch {
      // 后端未就绪时显示空列表
    }
    setLoading(false);
  }, [workspace]);

  useEffect(() => { loadAgents(); }, [loadAgents]);

  // 新建 Agent
  const handleCreate = () => {
    const id = `new-${Date.now()}`;
    setEditing(id);
    setForm({ ...DEFAULT_TEMPLATE });
    setError("");
  };

  // 编辑 Agent
  const handleEdit = (agent: AgentEntry) => {
    setEditing(agent.filename);
    setForm({ name: agent.name, description: agent.description, systemPrompt: agent.systemPrompt });
    setError("");
  };

  // 保存 Agent
  const handleSave = async () => {
    if (!form.name.trim()) { setError("Agent 名称为必填"); return; }
    setSaving(true);
    setError("");
    try {
      const method = editing?.startsWith("new-") ? "POST" : "PUT";
      const url = editing?.startsWith("new-")
        ? "/api/agents"
        : `/api/agents/${encodeURIComponent(form.name.trim())}`;
      const resp = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, workspace, oldName: editing?.startsWith("new-") ? undefined : editing }),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: "保存失败" }));
        setError(err.error || "保存失败");
        setSaving(false);
        return;
      }
      setEditing(null);
      await loadAgents();
    } catch {
      setError("网络错误");
    }
    setSaving(false);
  };

  // 删除 Agent
  const handleDelete = async (name: string) => {
    try {
      await fetch(`/api/agents/${encodeURIComponent(name)}?workspace=${encodeURIComponent(workspace || "")}`, { method: "DELETE" });
      await loadAgents();
    } catch { /* ignore */ }
  };

  return (
    <div className="h-full flex flex-col bg-background">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-border shrink-0">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft className="w-4 h-4 mr-1" />返回
        </Button>
        <Bot className="w-4 h-4 text-primary" />
        <span className="font-semibold text-sm">自定义 Agent</span>
        <div className="flex-1" />
        {editing === null && (
          <Button size="sm" onClick={handleCreate}>
            <Plus className="w-4 h-4 mr-1" />新建 Agent
          </Button>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto p-4">
        {editing !== null ? (
          /* --- 编辑视图 --- */
          <div className="max-w-3xl mx-auto space-y-4">
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" onClick={() => setEditing(null)}>
                <ArrowLeft className="w-4 h-4 mr-1" />返回列表
              </Button>
            </div>

            <div className="space-y-3">
              <div>
                <label className="text-xs font-medium text-muted-foreground">Agent 名称 *</label>
                <Input
                  placeholder="如 code-reviewer"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  className="font-mono text-sm"
                />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground">一句话描述</label>
                <Input
                  placeholder="代码审查专家，关注安全、性能、可读性"
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                  className="text-sm"
                />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground">系统提示词</label>
                <Textarea
                  placeholder="描述 Agent 的角色、工作方式、关注要点..."
                  value={form.systemPrompt}
                  onChange={(e) => setForm({ ...form, systemPrompt: e.target.value })}
                  className="min-h-[200px] font-mono text-xs"
                />
              </div>
            </div>

            {/* 预览 */}
            {form.systemPrompt && (
              <div className="rounded-lg border border-border p-3 bg-muted/20">
                <div className="text-[11px] text-muted-foreground mb-1">预览（渲染后效果）</div>
                <MarkdownRenderer content={form.systemPrompt} />
              </div>
            )}

            {error && (
              <div className="text-xs text-red-500 bg-red-50 dark:bg-red-950/30 rounded-md px-3 py-2">{error}</div>
            )}

            <div className="flex gap-2">
              <Button onClick={handleSave} disabled={saving}>
                {saving ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Save className="w-4 h-4 mr-1" />}
                保存
              </Button>
              <Button variant="outline" onClick={() => setEditing(null)}>
                <X className="w-4 h-4 mr-1" />取消
              </Button>
              <Button variant="ghost" onClick={() => setForm({ ...DEFAULT_TEMPLATE })}>
                <RotateCcw className="w-4 h-4 mr-1" />重置为模板
              </Button>
            </div>
          </div>
        ) : (
          /* --- 列表视图 --- */
          <div className="max-w-3xl mx-auto space-y-4">
            {loading ? (
              <div className="flex items-center justify-center py-12 text-muted-foreground">
                <Loader2 className="w-5 h-5 mr-2 animate-spin" />加载中...
              </div>
            ) : agents.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-muted-foreground space-y-3">
                <Bot className="w-12 h-12 opacity-30" />
                <div className="text-sm">还没有自定义 Agent</div>
                <div className="text-xs max-w-md text-center">
                  创建专属子 Agent，在聊天框里用 <code className="bg-muted px-1 rounded">@AgentName</code> 调用。
                  <br />例如 @Code Reviewer 审查改动、@Test Generator 生成测试。
                </div>
                <Button onClick={handleCreate}><Plus className="w-4 h-4 mr-1" />新建 Agent</Button>
              </div>
            ) : (
              agents.map((agent) => (
                <div
                  key={agent.name}
                  className="flex items-start gap-3 p-4 rounded-lg border border-border hover:bg-muted/30 transition-colors cursor-pointer"
                  onClick={() => handleEdit(agent)}
                >
                  <Bot className="w-5 h-5 text-primary mt-0.5 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-sm">{agent.name}</div>
                    <div className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
                      {agent.description || "（无描述）"}
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="shrink-0 text-muted-foreground hover:text-red-500"
                    onClick={(e) => { e.stopPropagation(); handleDelete(agent.name); }}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * 新建 Skill 对话框 - 在 Skill Studio 内唤起
 *
 * 两种方式（tab 切换）：
 * - manual: 手动填写 name + description + 正文，拼成 SKILL.md
 * - ai: 描述需求 → AI 生成 SKILL.md → 预览编辑 → 保存
 *
 * 保存成功后回调 onCreated(skillName)，由 Studio 刷新列表并定位到新 skill。
 */

import { useState } from "react";
import { Bot, Plus, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { uploadSkill, generateSkill } from "@/lib/apiClient";

interface SkillCreateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 当前工作区路径（项目级 skill 存储用） */
  workspace?: string;
  /** 创建成功回调，传入新 skill 名称 */
  onCreated: (name: string) => void;
}

/** 作用域选择子组件 */
function ScopeRadio({ scope, setScope, workspace }: {
  scope: "global" | "workspace";
  setScope: (s: "global" | "workspace") => void;
  workspace?: string;
}) {
  return (
    <div className="flex gap-4">
      <label className="flex items-center gap-1.5 text-sm cursor-pointer">
        <input type="radio" checked={scope === "global"} onChange={() => setScope("global")} className="accent-primary" />
        全局（所有项目可用）
      </label>
      <label className={`flex items-center gap-1.5 text-sm ${workspace ? "cursor-pointer" : "opacity-40 cursor-not-allowed"}`}>
        <input type="radio" checked={scope === "workspace"} onChange={() => workspace && setScope("workspace")} disabled={!workspace} className="accent-primary" />
        项目级（仅当前工作区）
      </label>
    </div>
  );
}

export function SkillCreateDialog({ open, onOpenChange, workspace, onCreated }: SkillCreateDialogProps) {
  const [mode, setMode] = useState<"manual" | "ai">("manual");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[95vw] sm:max-w-2xl max-h-[85vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>新建 Skill</DialogTitle>
        </DialogHeader>

        {/* 方式切换 */}
        <div className="flex gap-1 border-b border-border pb-2 mb-1">
          <button
            onClick={() => setMode("manual")}
            className={`px-3 py-1.5 rounded-md text-sm transition-colors ${mode === "manual" ? "bg-muted font-medium" : "hover:bg-muted/50 text-muted-foreground"}`}
          >
            <Plus className="w-3.5 h-3.5 inline mr-1.5" />
            手动新建
          </button>
          <button
            onClick={() => setMode("ai")}
            className={`px-3 py-1.5 rounded-md text-sm transition-colors ${mode === "ai" ? "bg-muted font-medium" : "hover:bg-muted/50 text-muted-foreground"}`}
          >
            <Bot className="w-3.5 h-3.5 inline mr-1.5" />
            AI 生成
          </button>
        </div>

        {mode === "manual"
          ? <ManualForm workspace={workspace} onCreated={onCreated} />
          : <AiForm workspace={workspace} onCreated={onCreated} />}
      </DialogContent>
    </Dialog>
  );
}

/** 手动新建表单 */
function ManualForm({ workspace, onCreated }: { workspace?: string; onCreated: (name: string) => void }) {
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [body, setBody] = useState("");
  const [scope, setScope] = useState<"global" | "workspace">("global");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const handleSave = async () => {
    if (!name.trim()) { setError("名称必填"); return; }
    if (scope === "workspace" && !workspace) { setError("当前未绑定工作区，无法创建项目级 Skill"); return; }
    setSaving(true);
    setError("");
    const content = [
      "---",
      `name: ${name.trim()}`,
      `description: "${desc.trim()}"`,
      "---",
      "",
      body,
    ].join("\n");
    try {
      await uploadSkill(content, scope === "workspace" ? workspace : undefined);
      onCreated(name.trim());
    } catch (err) {
      setError((err as Error).message);
    }
    setSaving(false);
  };

  return (
    <div className="space-y-3 overflow-y-auto flex-1">
      <div>
        <label className="text-xs text-muted-foreground mb-1 block">作用域</label>
        <ScopeRadio scope={scope} setScope={setScope} workspace={workspace} />
      </div>
      <div>
        <label className="text-xs text-muted-foreground mb-1 block">名称 *</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="如: query-deploy-info"
          className="w-full px-3 py-2 rounded-md border border-border bg-background text-sm focus:outline-none focus:border-primary"
        />
      </div>
      <div>
        <label className="text-xs text-muted-foreground mb-1 block">触发描述</label>
        <input
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
          placeholder="描述什么时候该使用这个 skill"
          className="w-full px-3 py-2 rounded-md border border-border bg-background text-sm focus:outline-none focus:border-primary"
        />
      </div>
      <div>
        <label className="text-xs text-muted-foreground mb-1 block">指令内容（Markdown）</label>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="# 这个 Skill 负责什么&#10;&#10;## 执行步骤&#10;&#10;1. ...&#10;2. ..."
          rows={10}
          className="w-full px-3 py-2 rounded-md border border-border bg-background text-sm font-mono focus:outline-none focus:border-primary resize-y"
        />
      </div>
      {error && <div className="text-xs text-red-500">{error}</div>}
      <div className="flex justify-end gap-2 pt-1">
        <Button size="sm" onClick={handleSave} disabled={saving}>
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : "保存"}
        </Button>
      </div>
    </div>
  );
}

/** AI 生成表单：描述 → 生成 → 预览编辑 → 保存 */
function AiForm({ workspace, onCreated }: { workspace?: string; onCreated: (name: string) => void }) {
  const [prompt, setPrompt] = useState("");
  const [generating, setGenerating] = useState(false);
  const [generated, setGenerated] = useState("");
  const [scope, setScope] = useState<"global" | "workspace">("global");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const handleGenerate = async () => {
    if (!prompt.trim()) { setError("请描述你想要的 Skill"); return; }
    setGenerating(true);
    setError("");
    setGenerated("");
    try {
      const data = await generateSkill(prompt.trim());
      setGenerated(data.content || "");
    } catch (err) {
      setError((err as Error).message);
    }
    setGenerating(false);
  };

  /** 从生成内容的 frontmatter 解析出 skill 名称（用于保存后定位） */
  const parseName = (content: string): string => {
    const m = content.match(/^---\s*\n([\s\S]*?)\n---/);
    if (!m) return "";
    const nameLine = m[1].split("\n").find((l) => /^name\s*:/.test(l));
    if (!nameLine) return "";
    return nameLine.replace(/^name\s*:/, "").trim().replace(/^["']|["']$/g, "");
  };

  const handleSave = async () => {
    if (!generated.trim()) return;
    setSaving(true);
    setError("");
    try {
      await uploadSkill(generated, scope === "workspace" ? workspace : undefined);
      onCreated(parseName(generated));
    } catch (err) {
      setError((err as Error).message);
    }
    setSaving(false);
  };

  return (
    <div className="flex flex-col gap-3 overflow-hidden flex-1">
      {!generated && (
        <div className="space-y-3 flex-1 flex flex-col">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Bot className="w-4 h-4" />
            <span>描述你想要的 Skill，AI 会帮你生成完整的指令文件</span>
          </div>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="例如：帮我创建一个查询应用部署信息的 skill，需要调用 poseidon 的 API，输入应用名返回所有环境的部署记录"
            className="flex-1 w-full px-4 py-3 rounded-md border border-border bg-background text-sm focus:outline-none focus:border-primary resize-none min-h-[160px]"
          />
          {error && <div className="text-xs text-red-500">{error}</div>}
          <div className="flex justify-end">
            <Button size="sm" onClick={handleGenerate} disabled={generating || !prompt.trim()}>
              {generating ? <><Loader2 className="w-4 h-4 animate-spin mr-1.5" />生成中...</> : "生成 Skill"}
            </Button>
          </div>
        </div>
      )}

      {generated && (
        <div className="flex flex-col gap-3 overflow-hidden flex-1">
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">预览与编辑（可直接修改后保存）</span>
            <button onClick={() => setGenerated("")} className="text-xs text-muted-foreground hover:text-foreground">&larr; 重新描述</button>
          </div>
          <textarea
            value={generated}
            onChange={(e) => setGenerated(e.target.value)}
            className="flex-1 w-full px-3 py-2 rounded-md border border-border bg-background text-sm font-mono focus:outline-none focus:border-primary resize-none min-h-[200px]"
          />
          <div className="flex items-center justify-between">
            <ScopeRadio scope={scope} setScope={setScope} workspace={workspace} />
            <Button size="sm" onClick={handleSave} disabled={saving}>
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : "保存 Skill"}
            </Button>
          </div>
          {error && <div className="text-xs text-red-500">{error}</div>}
        </div>
      )}
    </div>
  );
}

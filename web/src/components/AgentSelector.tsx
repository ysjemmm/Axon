/**
 * Agent 选择器组件
 *
 * 点击弹出可搜索的 Agent 列表，选择后在输入框插入 @AgentName。
 * 最多显示 20 个，超过时提示用户继续输入搜索。
 * 底部「创建新 Agent」跳转到 IDE 侧边栏 Agent 面板（搜索创建）。
 */

import { useState, useEffect, useCallback } from "react";
import { Bot, Plus, Search } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { apiRequest } from "@/lib/transport";
import type { MentionEditorHandle } from "./chat/MentionEditor";

interface AgentSelectorProps {
  editorRef: React.RefObject<MentionEditorHandle | null>;
}

interface AgentInfo {
  name: string;
  description: string;
}

const MAX_DISPLAY = 20;

export function AgentSelector({ editorRef }: AgentSelectorProps) {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);

  const loadAgents = useCallback(() => {
    apiRequest<{ agents: AgentInfo[] }>("GET", "/api/agents")
      .then((data) => setAgents(data.agents || []))
      .catch(() => {});
  }, []);

  useEffect(() => { if (open) loadAgents(); }, [open, loadAgents]);

  const filtered = agents.filter((a) =>
    a.name.toLowerCase().includes(search.toLowerCase()) ||
    a.description.toLowerCase().includes(search.toLowerCase())
  );

  const handleSelect = (name: string) => {
    editorRef.current?.insertAtCursor(`@${name} `);
    setOpen(false);
    setSearch("");
  };

  const handleCreate = () => {
    // 跳转到 IDE 侧边栏 Agent 面板进行表单编辑
    const vscode = (window as any).__axonVSCode;
    if (vscode) {
      vscode.postMessage({ type: "executeCommand", command: "workbench.view.extension.axon-agents" });
      // 延迟一下让面板打开，再触发新建
      setTimeout(() => { vscode.postMessage({ type: "executeCommand", command: "axon.agent.create" }); }, 300);
    }
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={(v) => { setOpen(v); if (!v) setSearch(""); }}>
      <PopoverTrigger asChild>
        <button
          className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
          title="选择 Agent"
        >
          <Bot className="w-4 h-4" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-2" side="top" align="start">
        <div className="space-y-2">
          <div className="relative">
            <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="搜索 Agent..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-8 h-8 text-xs"
            />
          </div>

          <div className="max-h-64 overflow-y-auto space-y-1">
            {filtered.length === 0 ? (
              <div className="text-xs text-muted-foreground text-center py-4">
                {agents.length === 0 ? "暂无 Agent" : "无匹配结果"}
              </div>
            ) : (
              <>
                {filtered.slice(0, MAX_DISPLAY).map((agent) => (
                  <button
                    key={agent.name}
                    onClick={() => handleSelect(agent.name)}
                    className="flex items-center gap-2 w-full px-2 py-1.5 rounded text-xs hover:bg-muted/60 transition-colors text-left"
                  >
                    <Bot className="w-3.5 h-3.5 shrink-0 text-primary" />
                    <div className="flex-1 min-w-0">
                      <div className="font-medium truncate">@{agent.name}</div>
                      {agent.description && (
                        <div className="text-[10px] text-muted-foreground truncate">
                          {agent.description}
                        </div>
                      )}
                    </div>
                  </button>
                ))}
                {filtered.length > MAX_DISPLAY && (
                  <div className="text-[10px] text-muted-foreground text-center py-1">
                    还有 {filtered.length - MAX_DISPLAY} 个，继续输入搜索...
                  </div>
                )}
              </>
            )}
          </div>

          <div className="border-t border-border pt-2">
            <button
              onClick={handleCreate}
              className="flex items-center gap-2 w-full px-2 py-1.5 rounded text-xs hover:bg-muted/60 transition-colors text-left text-primary"
            >
              <Plus className="w-3.5 h-3.5 shrink-0" />
              创建新 Agent
            </button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

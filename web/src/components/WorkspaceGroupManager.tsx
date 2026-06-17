/**
 * 工作区组管理弹窗 - 新建/编辑/删除工作区组
 */

import { useState, useEffect, useCallback } from "react";
import { Plus, Trash2, FolderOpen, Pencil, X, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { listWorkspaceGroups, createWorkspaceGroup, updateWorkspaceGroup, deleteWorkspaceGroup } from "@/lib/apiClient";

export interface WorkspaceGroup {
  id: string;
  name: string;
  paths: string[];
}

interface WorkspaceGroupManagerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect?: (group: WorkspaceGroup) => void;
  /** 某个组被编辑保存后回调（用于刷新正在使用该组的会话） */
  onGroupUpdated?: (group: WorkspaceGroup) => void;
}

export function WorkspaceGroupManager({ open, onOpenChange, onSelect, onGroupUpdated }: WorkspaceGroupManagerProps) {
  const [groups, setGroups] = useState<WorkspaceGroup[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editPaths, setEditPaths] = useState("");
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newPaths, setNewPaths] = useState("");

  const loadGroups = useCallback(async () => {
    try {
      const data = await listWorkspaceGroups();
      setGroups(data.groups || []);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    if (open) loadGroups();
  }, [open, loadGroups]);

  const handleCreate = async () => {
    const paths = newPaths.split("\n").map((p) => p.trim()).filter(Boolean);
    if (!newName.trim() || paths.length === 0) return;
    try {
      await createWorkspaceGroup(newName.trim(), paths);
      setNewName("");
      setNewPaths("");
      setCreating(false);
      loadGroups();
    } catch { /* ignore */ }
  };

  const handleUpdate = async (id: string) => {
    const paths = editPaths.split("\n").map((p) => p.trim()).filter(Boolean);
    if (!editName.trim() || paths.length === 0) return;
    try {
      const updated = await updateWorkspaceGroup(id, { name: editName.trim(), paths });
      setEditingId(null);
      loadGroups();
      // 通知外部：该组已更新（若正被当前会话使用，会触发重新绑定）
      onGroupUpdated?.(updated ?? { id, name: editName.trim(), paths });
    } catch { /* ignore */ }
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteWorkspaceGroup(id);
      loadGroups();
    } catch { /* ignore */ }
  };

  const startEdit = (group: WorkspaceGroup) => {
    setEditingId(group.id);
    setEditName(group.name);
    setEditPaths(group.paths.join("\n"));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="!max-w-lg w-[90vw]">
        <DialogHeader>
          <DialogTitle className="text-base">工作区组管理</DialogTitle>
        </DialogHeader>

        <div className="space-y-3 max-h-[60vh] overflow-y-auto">
          {groups.map((group) => (
            <div key={group.id} className="rounded-lg border border-border p-3">
              {editingId === group.id ? (
                <div className="space-y-2">
                  <input
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    className="w-full px-2 py-1 text-sm border border-border rounded bg-background"
                    placeholder="组名称"
                  />
                  <textarea
                    value={editPaths}
                    onChange={(e) => setEditPaths(e.target.value)}
                    className="w-full px-2 py-1 text-xs font-mono border border-border rounded bg-background resize-none"
                    rows={3}
                    placeholder="每行一个路径"
                  />
                  <div className="flex gap-1 justify-end">
                    <Button size="sm" variant="ghost" onClick={() => setEditingId(null)}>
                      <X className="w-3.5 h-3.5" />
                    </Button>
                    <Button size="sm" onClick={() => handleUpdate(group.id)}>
                      <Check className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex items-start gap-2">
                  <FolderOpen className="w-4 h-4 text-muted-foreground mt-0.5 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium">{group.name}</div>
                    <div className="text-xs text-muted-foreground font-mono mt-0.5 space-y-0.5">
                      {group.paths.map((p, i) => (
                        <div key={i} className="truncate">{p}</div>
                      ))}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    {onSelect && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs"
                        onClick={() => { onSelect(group); onOpenChange(false); }}
                      >
                        使用
                      </Button>
                    )}
                    <button onClick={() => startEdit(group)} className="p-1 rounded hover:bg-muted transition-colors">
                      <Pencil className="w-3.5 h-3.5 text-muted-foreground" />
                    </button>
                    <button onClick={() => handleDelete(group.id)} className="p-1 rounded hover:bg-destructive/10 transition-colors">
                      <Trash2 className="w-3.5 h-3.5 text-red-500" />
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}

          {groups.length === 0 && !creating && (
            <div className="text-center text-sm text-muted-foreground py-6">
              还没有工作区组，点击下方创建
            </div>
          )}

          {/* 新建表单 */}
          {creating ? (
            <div className="rounded-lg border border-primary/30 bg-primary/5 p-3 space-y-2">
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                className="w-full px-2 py-1 text-sm border border-border rounded bg-background"
                placeholder="组名称，如：Axon 全栈"
                autoFocus
              />
              <textarea
                value={newPaths}
                onChange={(e) => setNewPaths(e.target.value)}
                className="w-full px-2 py-1 text-xs font-mono border border-border rounded bg-background resize-none"
                rows={3}
                placeholder={"每行一个工作区路径，如：\nD:\\projects\\Axon\\web\nD:\\projects\\Axon\\server"}
              />
              <div className="flex gap-2 justify-end">
                <Button size="sm" variant="ghost" onClick={() => setCreating(false)}>取消</Button>
                <Button size="sm" onClick={handleCreate}>创建</Button>
              </div>
            </div>
          ) : (
            <Button
              variant="outline"
              size="sm"
              className="w-full"
              onClick={() => setCreating(true)}
            >
              <Plus className="w-3.5 h-3.5 mr-1" /> 新建工作区组
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

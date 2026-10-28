/**
 * Cowork 首页：我的流程 + 按岗位分组的模板。
 *
 * 这一屏要让人一眼明白 Cowork 的用法 —— 选一个流程、放文件、运行，而不是从空白对话框开始。
 * 自由任务的输入框仍在页面底部（由 CoworkPanel 渲染），给流程覆盖不到的临时需求用。
 */

import { useState } from "react";
import { MoreHorizontal, Pencil, Play, Repeat2, Trash2 } from "lucide-react";
import { relativeTime } from "./relativeTime";
import { FLOW_ROLES, FLOW_TEMPLATES, type FlowRole, type FlowTemplate } from "./builtinFlows";
import type { CoworkFlow } from "./flowTypes";

interface CoworkHomeProps {
  flows: CoworkFlow[];
  onRunFlow: (flow: CoworkFlow) => void;
  onEditFlow: (flow: CoworkFlow) => void;
  onDeleteFlow: (flow: CoworkFlow) => void;
  onUseTemplate: (template: FlowTemplate) => void;
}

function FlowCard({ flow, onRun, onEdit, onDelete }: { flow: CoworkFlow; onRun: () => void; onEdit: () => void; onDelete: () => void }) {
  const [menu, setMenu] = useState(false);
  const runs = flow.runs ?? [];
  const meta = runs.length > 0 ? `上次运行 ${relativeTime(runs[0].at)} · 共 ${runs.length} 次` : "还没运行过";
  return (
    <div className="group relative flex flex-col rounded-xl border border-border bg-background p-3 transition-colors hover:border-foreground/20">
      <button onClick={onRun} className="flex min-w-0 flex-1 flex-col text-left">
        <span className="flex items-center gap-1.5 text-[13px] font-medium text-foreground">
          <Repeat2 className="h-3.5 w-3.5 shrink-0 text-primary" />
          <span className="truncate">{flow.name}</span>
        </span>
        {flow.description && <span className="mt-1 line-clamp-2 text-[12px] leading-snug text-muted-foreground">{flow.description}</span>}
        <span className="mt-2 text-[11px] text-muted-foreground/80">{meta}</span>
      </button>
      <div className="absolute right-1.5 top-1.5">
        <button onClick={() => setMenu((v) => !v)} className="rounded-md p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-muted/60 hover:text-foreground focus:opacity-100 group-hover:opacity-100" aria-label="更多">
          <MoreHorizontal className="h-3.5 w-3.5" />
        </button>
        {menu && (
          <div className="absolute right-0 z-20 mt-1 w-28 overflow-hidden rounded-lg border border-border bg-background py-1 shadow-lg" onMouseLeave={() => setMenu(false)}>
            <button onClick={() => { setMenu(false); onEdit(); }} className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] hover:bg-muted/60"><Pencil className="h-3.5 w-3.5" />编辑</button>
            <button onClick={() => { setMenu(false); onDelete(); }} className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-destructive hover:bg-muted/60"><Trash2 className="h-3.5 w-3.5" />删除</button>
          </div>
        )}
      </div>
    </div>
  );
}

export function CoworkHome({ flows, onRunFlow, onEditFlow, onDeleteFlow, onUseTemplate }: CoworkHomeProps) {
  const [role, setRole] = useState<FlowRole>("finance");
  const templates = FLOW_TEMPLATES.filter((t) => t.role === role);
  return (
    <div className="mx-auto w-full max-w-[max(640px,80%)] py-6">
      <h2 className="text-[17px] font-medium text-foreground">今天要处理什么？</h2>
      <p className="mt-1 text-[13px] text-muted-foreground">选一个流程放进文件就能运行；临时的需求直接在下面说。</p>

      {flows.length > 0 && (
        <section className="mt-6">
          <h3 className="mb-2 text-[12px] font-medium text-muted-foreground">我的流程</h3>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-2">
            {flows.map((flow) => (
              <FlowCard key={flow.id} flow={flow} onRun={() => onRunFlow(flow)} onEdit={() => onEditFlow(flow)} onDelete={() => onDeleteFlow(flow)} />
            ))}
          </div>
        </section>
      )}

      <section className="mt-6">
        <div className="mb-2 flex items-center gap-3">
          <h3 className="text-[12px] font-medium text-muted-foreground">{flows.length > 0 ? "更多模板" : "从模板开始"}</h3>
          <div className="flex gap-1">
            {FLOW_ROLES.map((r) => (
              <button
                key={r.id}
                onClick={() => setRole(r.id)}
                className={`rounded-full px-2.5 py-0.5 text-[12px] transition-colors ${role === r.id ? "bg-foreground text-background" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"}`}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-2">
          {templates.map((t) => (
            <button key={t.templateId} onClick={() => onUseTemplate(t)} className="flex flex-col rounded-xl border border-dashed border-border p-3 text-left transition-colors hover:border-solid hover:border-foreground/20 hover:bg-muted/30">
              <span className="flex items-center gap-1.5 text-[13px] font-medium text-foreground">
                <Play className="h-3 w-3 shrink-0 text-muted-foreground" />{t.name}
              </span>
              <span className="mt-1 line-clamp-2 text-[12px] leading-snug text-muted-foreground">{t.description}</span>
              <span className="mt-2 text-[11px] text-muted-foreground/80">需要：{t.inputs.map((i) => i.label).join("、")}</span>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

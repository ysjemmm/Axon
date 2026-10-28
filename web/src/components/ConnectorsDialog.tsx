/**
 * 连接器：把 GitHub、邮箱、飞书、Notion 等服务接给 Axon。
 *
 * 每个连接器是一个预设好的 MCP 服务：用户只填令牌 / 授权码，保存后 Agent 下一轮对话就能用它的工具
 * （读取类自动执行，写入 / 发送类每次确认）。密钥只存在本机用户目录，列表里只显示「已保存」。
 *
 * 走会话通道（sessionHub 的 connector_* 指令），IDE 扩展和独立 server 用同一套。
 * 挂在 App 层、全局一个：从输入框「+」菜单或 IDE 命令打开。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, CheckCircle2, ExternalLink, Loader2, Plus, Trash2, X, XCircle } from "lucide-react";
import { useSessionEvents } from "@/hooks/useSessionEvents";
import type { WsMessage } from "@/hooks/useWebSocket";

/** 连接器事件走固定的路由键：全局只有一个连接器面板 */
export const CONNECTORS_CLIENT_ID = "connectors";
/** 打开连接器面板（输入框菜单、IDE 命令都派发这个事件） */
export const OPEN_CONNECTORS_EVENT = "axon:open-connectors";

interface ConnectorField {
  key: string;
  label: string;
  type: "text" | "secret" | "boolean" | "select" | "textarea";
  placeholder?: string;
  hint?: string;
  required?: boolean;
  default?: string;
  options?: { value: string; label: string }[];
}

interface ConnectorTemplate {
  id: string;
  name: string;
  category: "dev" | "mail" | "office" | "data" | "custom";
  description: string;
  icon: string;
  setup?: string;
  docsUrl?: string;
  fields: ConnectorField[];
}

interface Connector {
  id: string;
  templateId: string;
  name: string;
  enabled: boolean;
  values: Record<string, string>;
  savedSecrets: string[];
  updatedAt: number;
}

interface TestResult {
  ok: boolean;
  tools?: { name: string; description?: string }[];
  error?: string;
}

const CATEGORY_LABEL: Record<ConnectorTemplate["category"], string> = { dev: "开发", mail: "邮箱", office: "办公协作", data: "数据", custom: "自定义" };

/** 品牌色字母徽章（不复刻商标图形） */
const BADGE: Record<string, { text: string; className: string }> = {
  github: { text: "GH", className: "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900" },
  gitlab: { text: "GL", className: "bg-orange-500 text-white" },
  gmail: { text: "G", className: "bg-red-500 text-white" },
  qqmail: { text: "QQ", className: "bg-sky-500 text-white" },
  "163mail": { text: "163", className: "bg-red-600 text-white" },
  exmail: { text: "企", className: "bg-blue-600 text-white" },
  imap: { text: "@", className: "bg-slate-500 text-white" },
  feishu: { text: "飞", className: "bg-blue-500 text-white" },
  notion: { text: "N", className: "bg-zinc-800 text-white dark:bg-zinc-200 dark:text-zinc-900" },
  slack: { text: "S", className: "bg-purple-600 text-white" },
  postgres: { text: "PG", className: "bg-indigo-600 text-white" },
  "custom-remote": { text: "URL", className: "bg-muted text-foreground" },
  "custom-local": { text: ">_", className: "bg-muted text-foreground" },
};

function Badge({ templateId, size = "md" }: { templateId: string; size?: "md" | "lg" }) {
  const badge = BADGE[templateId] ?? { text: "?", className: "bg-muted text-foreground" };
  const box = size === "lg" ? "size-10 text-[13px]" : "size-8 text-[11px]";
  return <span className={`inline-flex ${box} shrink-0 items-center justify-center rounded-lg font-semibold ${badge.className}`}>{badge.text}</span>;
}

const field = "w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-[13px] outline-none focus:ring-1 focus:ring-ring";

function openExternal(url: string) {
  const host = (window as unknown as { __axonVSCode?: { postMessage: (m: unknown) => void } }).__axonVSCode;
  if (host) host.postMessage({ type: "open_external", url });
  else window.open(url, "_blank", "noopener");
}

function useConnectors(connected: boolean, send: (cmd: Record<string, unknown>) => void, open: boolean) {
  const [catalog, setCatalog] = useState<ConnectorTemplate[]>([]);
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [loaded, setLoaded] = useState(false);
  const pending = useRef(new Map<string, (data: Record<string, unknown>) => void>());

  useEffect(() => {
    if (open && connected) send({ type: "connectors_list", clientId: CONNECTORS_CLIENT_ID });
  }, [connected, open, send]);

  useSessionEvents(CONNECTORS_CLIENT_ID, (msg: WsMessage) => {
    const m = msg as WsMessage & { catalog?: ConnectorTemplate[]; connectors?: Connector[]; requestId?: string };
    if (m.type === "connectors") {
      setCatalog(m.catalog ?? []);
      setConnectors(m.connectors ?? []);
      setLoaded(true);
    } else if ((m.type === "connector_saved" || m.type === "connector_test_result") && m.requestId) {
      pending.current.get(m.requestId)?.(m as unknown as Record<string, unknown>);
      pending.current.delete(m.requestId);
    }
  });

  const request = useCallback((type: string, connector: unknown) => new Promise<Record<string, unknown>>((resolve) => {
    const requestId = `${type}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    pending.current.set(requestId, resolve);
    send({ type, clientId: CONNECTORS_CLIENT_ID, requestId, connector });
  }), [send]);

  return {
    catalog, connectors, loaded,
    save: (draft: unknown) => request("connector_save", draft),
    test: (draft: unknown) => request("connector_test", draft),
    setEnabled: (id: string, enabled: boolean) => send({ type: "connector_set_enabled", clientId: CONNECTORS_CLIENT_ID, id, enabled }),
    remove: (id: string) => send({ type: "connector_delete", clientId: CONNECTORS_CLIENT_ID, id }),
  };
}

function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)}
      className={`relative h-4 w-7 shrink-0 rounded-full transition-colors ${checked ? "bg-emerald-500" : "bg-muted-foreground/25"}`}>
      <span className={`absolute top-0.5 size-3 rounded-full bg-white shadow-sm transition-transform ${checked ? "translate-x-3.5" : "translate-x-0.5"}`} />
    </button>
  );
}

/** 添加 / 编辑一个连接器 */
function ConnectorEditor({ template, existing, onBack, save, test }: {
  template: ConnectorTemplate;
  existing?: Connector;
  onBack: () => void;
  save: (draft: unknown) => Promise<Record<string, unknown>>;
  test: (draft: unknown) => Promise<Record<string, unknown>>;
}) {
  const isSecret = (f: ConnectorField) => f.type === "secret" || f.type === "textarea";
  const [name, setName] = useState(existing?.name ?? template.name);
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(
    template.fields.filter((f) => !isSecret(f)).map((f) => [f.key, existing?.values[f.key] ?? f.default ?? ""]),
  ));
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<"" | "test" | "save">("");
  const [result, setResult] = useState<TestResult | null>(null);
  const [error, setError] = useState("");

  const draft = () => ({ id: existing?.id, templateId: template.id, name, values, secrets });

  const runTest = async () => {
    setBusy("test"); setError(""); setResult(null);
    const res = await test(draft());
    setResult({ ok: res.ok === true, tools: res.tools as TestResult["tools"], error: res.error as string | undefined });
    setBusy("");
  };

  const runSave = async () => {
    setBusy("save"); setError("");
    const res = await save(draft());
    setBusy("");
    if (res.error) { setError(res.error as string); return; }
    onBack();
  };

  return (
    <div className="mx-auto w-full max-w-[560px] px-4 py-5">
      <button onClick={onBack} className="mb-3 inline-flex items-center gap-1 text-[12px] text-muted-foreground hover:text-foreground"><ArrowLeft className="h-3.5 w-3.5" />返回</button>
      <div className="flex items-start gap-3">
        <Badge templateId={template.id} size="lg" />
        <div className="min-w-0">
          <h2 className="text-[15px] font-medium text-foreground">{existing ? `编辑 ${existing.name}` : `添加 ${template.name}`}</h2>
          <p className="mt-0.5 text-[12px] text-muted-foreground">{template.description}</p>
        </div>
      </div>
      {template.setup && (
        <div className="mt-4 rounded-lg bg-muted/40 px-3 py-2.5 text-[12px] leading-relaxed text-foreground/90">
          {template.setup}
          {template.docsUrl && (
            <button onClick={() => openExternal(template.docsUrl!)} className="ml-1 inline-flex items-center gap-0.5 text-primary hover:underline">
              去获取<ExternalLink className="h-3 w-3" />
            </button>
          )}
        </div>
      )}

      <div className="mt-4 space-y-3">
        <div>
          <label className="text-[12px] font-medium text-foreground">名称</label>
          <input value={name} onChange={(e) => setName(e.target.value)} className={`${field} mt-1`} />
        </div>
        {template.fields.map((f) => {
          const saved = existing?.savedSecrets.includes(f.key);
          if (f.type === "boolean") {
            return (
              <label key={f.key} className="flex items-center justify-between gap-3 text-[12px] text-foreground">
                <span>{f.label}</span>
                <Switch checked={values[f.key] === "true"} onChange={(v) => setValues({ ...values, [f.key]: v ? "true" : "false" })} label={f.label} />
              </label>
            );
          }
          return (
            <div key={f.key}>
              <label className="text-[12px] font-medium text-foreground">{f.label}{f.required && <span className="text-destructive"> *</span>}</label>
              {f.type === "select" ? (
                <select value={values[f.key]} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} className={`${field} mt-1`}>
                  {f.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              ) : f.type === "textarea" ? (
                <textarea rows={3} value={secrets[f.key] ?? ""} onChange={(e) => setSecrets({ ...secrets, [f.key]: e.target.value })}
                  placeholder={saved ? "已保存，留空表示不修改" : f.placeholder} className={`${field} mt-1 resize-none font-mono text-[12px]`} />
              ) : f.type === "secret" ? (
                <input type="password" autoComplete="off" value={secrets[f.key] ?? ""} onChange={(e) => setSecrets({ ...secrets, [f.key]: e.target.value })}
                  placeholder={saved ? "已保存，留空表示不修改" : f.placeholder} className={`${field} mt-1`} />
              ) : (
                <input value={values[f.key] ?? ""} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} placeholder={f.placeholder} className={`${field} mt-1`} />
              )}
              {f.hint && <p className="mt-1 text-[11px] text-muted-foreground">{f.hint}</p>}
            </div>
          );
        })}
      </div>

      {result && (
        <div className={`mt-4 rounded-lg border px-3 py-2.5 text-[12px] ${result.ok ? "border-emerald-500/30 bg-emerald-500/5" : "border-red-500/30 bg-red-500/5"}`}>
          {result.ok ? (
            <>
              <div className="flex items-center gap-1.5 font-medium text-emerald-700 dark:text-emerald-400"><CheckCircle2 className="h-4 w-4" />连接成功，提供 {result.tools?.length ?? 0} 个工具</div>
              {!!result.tools?.length && <div className="mt-1.5 flex flex-wrap gap-1">{result.tools.slice(0, 30).map((t) => <code key={t.name} title={t.description} className="rounded bg-muted px-1.5 py-0.5 text-[11px]">{t.name}</code>)}</div>}
            </>
          ) : (
            <div className="flex items-start gap-1.5 text-red-700 dark:text-red-400"><XCircle className="mt-0.5 h-4 w-4 shrink-0" /><span className="break-all">{result.error}</span></div>
          )}
        </div>
      )}
      {error && <p className="mt-3 text-[12px] text-destructive">{error}</p>}

      <div className="mt-4 flex justify-end gap-2">
        <button onClick={runTest} disabled={!!busy} className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-[12px] hover:bg-muted/50 disabled:opacity-60">
          {busy === "test" && <Loader2 className="h-3.5 w-3.5 animate-spin" />}测试连接
        </button>
        <button onClick={runSave} disabled={!!busy} className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3.5 py-1.5 text-[12px] font-medium text-primary-foreground disabled:opacity-60">
          {busy === "save" && <Loader2 className="h-3.5 w-3.5 animate-spin" />}保存
        </button>
      </div>
    </div>
  );
}

export function ConnectorsDialog({ open, onClose, connected, send }: { open: boolean; onClose: () => void; connected: boolean; send: (cmd: Record<string, unknown>) => void }) {
  const { catalog, connectors, loaded, save, test, setEnabled, remove } = useConnectors(connected, send, open);
  const [editing, setEditing] = useState<{ template: ConnectorTemplate; existing?: Connector } | null>(null);
  const [category, setCategory] = useState<ConnectorTemplate["category"] | "all">("all");
  const templateOf = useMemo(() => new Map(catalog.map((t) => [t.id, t])), [catalog]);
  const categories = useMemo(() => [...new Set(catalog.map((t) => t.category))], [catalog]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { if (editing) setEditing(null); else onClose(); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editing, onClose, open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-background">
      <header className="flex shrink-0 items-center justify-between border-b border-border px-4 py-2.5">
        <span className="text-[13px] font-medium text-foreground">连接器</span>
        <button onClick={onClose} className="rounded-md p-1 text-muted-foreground hover:bg-muted/60 hover:text-foreground" aria-label="关闭"><X className="h-4 w-4" /></button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {editing ? (
          <ConnectorEditor key={editing.existing?.id ?? editing.template.id} template={editing.template} existing={editing.existing} onBack={() => setEditing(null)} save={save} test={test} />
        ) : (
          <div className="mx-auto w-full max-w-[720px] px-4 py-5">
            <p className="text-[12px] leading-relaxed text-muted-foreground">
              把常用服务接给 Axon，对话里就能直接查 GitHub、读邮件、写飞书文档。读取类操作自动执行，修改和发送每次都会先请你确认。令牌只保存在本机用户目录，不会写进项目。
            </p>

            {!loaded && <div className="flex items-center gap-2 py-8 text-[12px] text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />{connected ? "加载中…" : "等待连接…"}</div>}

            {connectors.length > 0 && (
              <section className="mt-5">
                <h3 className="mb-2 text-[12px] font-medium text-muted-foreground">已添加</h3>
                <div className="space-y-1.5">
                  {connectors.map((c) => {
                    const template = templateOf.get(c.templateId);
                    return (
                      <div key={c.id} className="group flex items-center gap-3 rounded-xl border border-border px-3 py-2.5">
                        <Badge templateId={c.templateId} />
                        <button className="min-w-0 flex-1 text-left" onClick={() => template && setEditing({ template, existing: c })}>
                          <div className="truncate text-[13px] font-medium text-foreground">{c.name}</div>
                          <div className="truncate text-[11px] text-muted-foreground">{template?.name ?? c.templateId}{c.values.user ? ` · ${c.values.user}` : ""}{c.enabled ? "" : " · 已停用"}</div>
                        </button>
                        <button onClick={() => { if (window.confirm(`删除连接器「${c.name}」？保存的令牌会一起删除。`)) remove(c.id); }}
                          className="rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-muted/60 hover:text-destructive group-hover:opacity-100" aria-label={`删除 ${c.name}`}>
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                        <Switch checked={c.enabled} onChange={(v) => setEnabled(c.id, v)} label={`启用 ${c.name}`} />
                      </div>
                    );
                  })}
                </div>
              </section>
            )}

            {loaded && (
              <section className="mt-6">
                <div className="mb-2 flex flex-wrap items-center gap-3">
                  <h3 className="text-[12px] font-medium text-muted-foreground">添加连接器</h3>
                  <div className="flex flex-wrap gap-1">
                    {(["all", ...categories] as const).map((c) => (
                      <button key={c} onClick={() => setCategory(c)}
                        className={`rounded-full px-2.5 py-0.5 text-[12px] transition-colors ${category === c ? "bg-foreground text-background" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"}`}>
                        {c === "all" ? "全部" : CATEGORY_LABEL[c]}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-2">
                  {catalog.filter((t) => category === "all" || t.category === category).map((t) => (
                    <button key={t.id} onClick={() => setEditing({ template: t })}
                      className="flex items-start gap-2.5 rounded-xl border border-border p-3 text-left transition-colors hover:border-foreground/20 hover:bg-muted/30">
                      <Badge templateId={t.id} />
                      <span className="min-w-0">
                        <span className="flex items-center gap-1 text-[13px] font-medium text-foreground">{t.name}<Plus className="h-3 w-3 text-muted-foreground" /></span>
                        <span className="mt-0.5 line-clamp-2 block text-[11px] leading-snug text-muted-foreground">{t.description}</span>
                      </span>
                    </button>
                  ))}
                </div>
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

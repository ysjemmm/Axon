/**
 * 语音输入设置：选一个已配置的 Provider 和识别模型。
 * 识别走 OpenAI 兼容的 /audio/transcriptions，复用 Provider 的地址和 Key，不用再填一遍。
 */

import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { getVoiceConfig, setVoiceConfig, type ResolvedProviderInfo, type VoiceInputConfig } from "@/lib/apiClient";

/** 常见服务商的识别模型（第一个是默认推荐） */
function suggestedModels(baseUrl: string): string[] {
  const host = (() => { try { return new URL(baseUrl).hostname; } catch { return ""; } })();
  if (host.endsWith("openai.com")) return ["gpt-4o-mini-transcribe", "gpt-4o-transcribe", "whisper-1"];
  if (host.includes("siliconflow")) return ["FunAudioLLM/SenseVoiceSmall", "TeleAI/TeleSpeechASR"];
  if (host.endsWith("groq.com")) return ["whisper-large-v3-turbo", "whisper-large-v3"];
  return ["whisper-1"];
}

const LANGUAGES = [
  { value: "auto", label: "自动识别" },
  { value: "zh", label: "中文" },
  { value: "en", label: "English" },
  { value: "ja", label: "日本語" },
];

const NONE = "__none__";

export function VoiceInputSettings({ providers }: { providers: ResolvedProviderInfo[] }) {
  const [config, setConfig] = useState<VoiceInputConfig | null>(null);
  const [model, setModel] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [saved, setSaved] = useState(false);
  const usable = providers.filter((p) => p.configured);

  useEffect(() => {
    getVoiceConfig()
      .then((r) => { setConfig(r.config); setModel(r.config?.model ?? ""); })
      .catch(() => undefined)
      .finally(() => setLoaded(true));
  }, []);

  const save = async (next: VoiceInputConfig | null) => {
    setConfig(next);
    try {
      await setVoiceConfig(next);
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch (e) {
      console.warn("保存语音输入配置失败", e);
    }
  };

  const pickProvider = (name: string) => {
    if (name === NONE) { setModel(""); void save(null); return; }
    const p = usable.find((x) => x.name === name);
    // 换服务商时模型换成它的推荐值：上一家的模型名到这家多半不认
    const m = p ? suggestedModels(p.baseUrl)[0] : "whisper-1";
    setModel(m);
    void save({ provider: name, model: m, language: config?.language });
  };

  const current = usable.find((p) => p.name === config?.provider);
  const suggestions = current ? suggestedModels(current.baseUrl) : [];

  if (!loaded) return null;
  return (
    <div className="rounded-xl border border-border px-4 py-3">
      <p className="mb-3 text-[12px] text-muted-foreground">
        输入框右侧的麦克风：录音在本机完成，再交给这里选的服务转成文字（需要服务商支持语音识别接口，如 OpenAI、硅基流动、Groq）。
        {saved && <span className="ml-2 inline-flex items-center gap-0.5 text-emerald-600 dark:text-emerald-500"><Check className="h-3 w-3" />已保存</span>}
      </p>
      <div className="grid grid-cols-[72px_1fr] items-center gap-x-3 gap-y-2 text-[12px]">
        <span className="text-muted-foreground">服务商</span>
        <Select value={config?.provider ?? NONE} onValueChange={pickProvider}>
          <SelectTrigger className="h-8 w-full max-w-[280px] text-[12px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>不启用</SelectItem>
            {usable.map((p) => <SelectItem key={p.name} value={p.name}>{p.label || p.name}</SelectItem>)}
          </SelectContent>
        </Select>

        {config && (
          <>
            <span className="text-muted-foreground">模型</span>
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              <Input
                value={model}
                onChange={(e) => setModel(e.target.value)}
                onBlur={() => { if (model.trim() && model.trim() !== config.model) void save({ ...config, model: model.trim() }); }}
                onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                placeholder="识别模型 id，如 whisper-1"
                className="h-8 max-w-[280px] text-[12px]"
              />
              {suggestions.filter((s) => s !== config.model).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => { setModel(s); void save({ ...config, model: s }); }}
                  className="rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground hover:border-foreground/30 hover:text-foreground"
                >
                  {s}
                </button>
              ))}
            </div>

            <span className="text-muted-foreground">语言</span>
            <Select value={config.language || "auto"} onValueChange={(v) => void save({ ...config, language: v === "auto" ? undefined : v })}>
              <SelectTrigger className="h-8 w-full max-w-[160px] text-[12px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                {LANGUAGES.map((l) => <SelectItem key={l.value} value={l.value}>{l.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * taskIntent —— 把"这一轮在干什么"翻译成一句有信息量的人话
 *
 * 为什么需要这一层：后端每轮开始统一发 `status: "思考中..."`，是给开发者看的通用
 * 文案。Chat/Code 那侧配合工具卡片一起看没问题（卡片里有工具名和参数），但 Cowork
 * 刻意不展示工具调用，于是整轮只剩一句"思考中…"——用户盯着它既不知道在处理哪份
 * 文件，也不知道走到哪一步了。
 *
 * 这里把状态行拆成三段，各自回答一个问题：
 *   · 意图（这一轮的目标是什么）→ 发起时从请求文本里识别一次，整轮不变
 *   · 阶段（现在具体在做什么）  → 跟着工具调用/流式状态实时变
 *   · 耗时（跑了多久了）        → 长任务里这是用户最想知道的一件事
 *
 * 全部在前端用规则算出来，不额外调模型：状态行必须在任务刚发出的那一刻就有内容，
 * 等一次模型往返再显示就失去意义了。
 */

import { TOOL } from "@/lib/constants";

/**
 * 任务意图识别规则。
 *
 * 顺序敏感，从具体到笼统：「汇总各部门差异」应该识别成核对而不是汇总，所以
 * 核对类排在汇总类前面。命中第一条即返回。
 */
const INTENT_RULES: { re: RegExp; label: string }[] = [
  { re: /核对|对账|比对|对比|差异|不一致|有没有错|校验/, label: "核对差异" },
  { re: /去重|重复项|重复的/, label: "清理重复项" },
  { re: /拆分|分拆|拆成|分成|按.{0,8}分组/, label: "拆分数据" },
  { re: /合并|并成|并到|拼接|汇成一张/, label: "合并数据" },
  { re: /汇总|合计|求和|总计|统计|算一下|算出/, label: "汇总数据" },
  { re: /报表|报告|月报|周报|日报|台账/, label: "生成报表" },
  { re: /图表|折线|柱状|饼图|可视化|画个图/, label: "制作图表" },
  { re: /筛选|过滤|只要|只保留|排除|剔除/, label: "筛选数据" },
  { re: /排序|排名|从高到低|从低到高|最大的|最小的/, label: "整理排序" },
  { re: /转成|转为|转换|导出成|另存|改成.{0,6}格式/, label: "转换格式" },
  { re: /翻译/, label: "翻译内容" },
  { re: /提取|抽取|摘出|找出|列出|整理出/, label: "提取内容" },
  { re: /填写|填充|补全|补上/, label: "补全内容" },
  { re: /检查|有没有问题|哪里错|纠错/, label: "检查内容" },
  { re: /分析|解读|看看|结论|洞察/, label: "分析内容" },
  { re: /生成|做一份|做个|写一份/, label: "生成文档" },
];

/** 请求文本过长时作为兜底摘要的截断长度 */
const FALLBACK_MAX = 14;

/**
 * 从用户请求里识别本轮意图，返回「核对差异」这类动宾短语（不带"正在"前缀，
 * 由调用方拼接，避免和阶段文案里的"正在"重复）。
 *
 * 识别不出来时退回请求原文的前若干字——哪怕只是把用户自己的话复述一遍，也比
 * 一句放之四海而皆准的"思考中"更有信息量。
 */
export function describeIntent(request: string, fileNames: string[] = []): string {
  const text = (request || "").trim();
  for (const rule of INTENT_RULES) {
    if (rule.re.test(text)) return rule.label;
  }
  if (text) {
    // 去掉"帮我/请/麻烦"这类没有信息量的起手词，再截断
    const cleaned = text.replace(/^(帮我|帮忙|请|麻烦|能不能|可以)\s*/, "");
    const firstLine = cleaned.split(/[\n。；;]/)[0].trim() || cleaned;
    return firstLine.length > FALLBACK_MAX ? `${firstLine.slice(0, FALLBACK_MAX)}…` : firstLine;
  }
  return fileNames.length > 0 ? "处理文件" : "处理任务";
}

/** 取路径的文件名部分：绝对路径又长又会把状态行挤爆，而用户认得自己的文件名 */
function baseName(rawPath: string): string {
  return rawPath.replace(/\\/g, "/").split("/").filter(Boolean).pop() || "";
}

/**
 * 工具调用 → 阶段短语。
 *
 * 刻意不带"正在"前缀也不显示工具名：前缀由状态行统一拼，工具名对办公用户既没有
 * 信息量也显得可疑（"execute_command" 看着像要干什么坏事）。
 */
export function describeToolPhase(name: string, args: unknown): string {
  const a = (args || {}) as Record<string, unknown>;
  const rawPath = typeof a.path === "string" ? a.path : "";
  const base = rawPath ? baseName(rawPath) : "";

  switch (name) {
    case TOOL.READ_FILE:
      return base ? `读取 ${base}` : "读取文件";
    case TOOL.CREATE_FILE:
      return base ? `生成 ${base}` : "生成文件";
    case TOOL.STR_REPLACE:
    case TOOL.APPLY_PATCH:
      return base ? `修改 ${base}` : "修改内容";
    case TOOL.LIST_DIR:
      return "查看文件夹";
    case TOOL.SEARCH:
      return "查找内容";
    case TOOL.EXECUTE_COMMAND:
    case TOOL.START_PROCESS:
      // 处理 Excel/PDF 基本都落到脚本执行这一步，也是耗时最长的环节
      return "处理数据";
    case TOOL.REPORT_OUTPUTS:
      return "整理产出";
    default:
      return "处理中";
  }
}

/**
 * 后端通用 status 文案 → 阶段短语。
 *
 * 后端那套文案（"思考中..."/"正在回复..."）是面向 Chat 的，直接透传到 Cowork 就是
 * 一句没有信息量的占位。这里归一化成短语，交给状态行和意图拼在一起。
 */
const GENERIC_STATUS: { re: RegExp; label: string }[] = [
  { re: /^深度思考/, label: "深度思考" },
  { re: /^思考中/, label: "分析需求" },
  { re: /^正在回复|^正在添加细节/, label: "整理结果" },
  { re: /^整理上下文|^压缩/, label: "整理上下文" },
  { re: /^正在构思图形/, label: "构思图形" },
];

export function describeStatusPhase(content: string): string {
  const text = (content || "").trim();
  if (!text) return "";
  for (const rule of GENERIC_STATUS) {
    if (rule.re.test(text)) return rule.label;
  }
  // 非通用文案（后端为具体场景发的）本就是给人看的，去掉"正在"前缀和省略号后直接用
  return text.replace(/^正在/, "").replace(/[.。]{2,}$/, "").trim();
}

/**
 * 脚本类扩展名 —— 处理数据的手段，不是给用户的结果。
 *
 * 办公任务里 Agent 会写临时 Python 脚本来读写 Excel，那个 .py 不该作为"产出"挂给
 * 用户看（实际遇到过：真正的 xlsx 一个没列出，反而只挂了个临时脚本）。
 */
const SCRIPT_EXT = new Set([
  "py", "pyc", "js", "mjs", "cjs", "ts", "sh", "ps1", "bat", "cmd", "log", "tmp", "bak",
]);

export function isScriptFile(name: string): boolean {
  const ext = /\.([a-z0-9]{1,8})$/i.exec(name)?.[1]?.toLowerCase();
  return !!ext && SCRIPT_EXT.has(ext);
}

/** 耗时格式化：长任务里用户最关心"跑了多久"，秒级精度足够 */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return s === 0 ? `${m}分` : `${m}分${s}秒`;
}

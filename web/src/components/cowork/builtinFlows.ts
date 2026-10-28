/**
 * 内置流程模板：财务 / 会计 / 客服最常见的周期性工作。
 *
 * 作用有两个：① 第一次打开就有能直接用的东西，不用先想「我该怎么描述」；
 * ② 让用户一眼明白 Cowork 的用法 —— 放文件、点运行，而不是聊天。
 * 用户可以直接运行，也可以存一份到「我的流程」再按自己的习惯改。
 */

import type { CoworkFlowDraft } from "./flowTypes";

export type FlowRole = "finance" | "accounting" | "service";

export const FLOW_ROLES: { id: FlowRole; label: string }[] = [
  { id: "finance", label: "财务" },
  { id: "accounting", label: "会计" },
  { id: "service", label: "客服" },
];

export interface FlowTemplate extends CoworkFlowDraft {
  templateId: string;
  role: FlowRole;
}

export const FLOW_TEMPLATES: FlowTemplate[] = [
  {
    templateId: "bank-reconcile",
    role: "finance",
    name: "银行对账",
    description: "把银行流水和账簿逐笔核对，列出未达账项",
    inputs: [
      { id: "bank", label: "银行流水", hint: "网银导出的 Excel / CSV，可以放多个账户", multiple: true },
      { id: "ledger", label: "账簿明细", hint: "财务系统导出的银行存款明细账" },
    ],
    steps: [
      "读取银行流水和账簿明细，统一日期、金额格式（收入为正、支出为负）",
      "先按金额 + 日期（相差 3 天以内）逐笔匹配，再用摘要 / 对方户名辅助确认",
      "列出银行已记账而账簿未记、账簿已记而银行未记的未达账项",
      "编制银行存款余额调节表：双方余额分别加减未达账项后应相等",
      "生成一个 Excel：第一页调节表，第二页未达账项明细，第三页匹配明细",
    ],
    checks: [
      "调节后银行余额与调节后账面余额相等",
      "已匹配笔数 + 未达账项笔数 = 流水总笔数",
      "没有一笔流水被重复匹配",
    ],
    outputName: "银行对账_{本期}.xlsx",
    askEachRun: "本期是哪个月？期末余额是多少（可不填）",
  },
  {
    templateId: "expense-summary",
    role: "finance",
    name: "报销汇总",
    description: "汇总一批报销单，按部门和费用类别出统计表",
    inputs: [{ id: "claims", label: "报销单", hint: "Excel、PDF 或照片都可以，一次放一批", multiple: true }],
    steps: [
      "逐份提取报销人、部门、日期、费用类别、金额、发票号",
      "发票号重复的标出来，可能是重复报销",
      "按部门 × 费用类别汇总金额，并给出每人合计",
      "生成一个 Excel：汇总表、明细表、异常清单（重复发票、缺少字段、金额超标）各一页",
    ],
    checks: ["明细金额合计等于汇总表合计", "处理的报销单份数与放入的文件数一致", "列出所有缺少发票号或金额的单据"],
    outputName: "报销汇总_{本期}.xlsx",
  },
  {
    templateId: "invoice-extract",
    role: "accounting",
    name: "发票信息提取",
    description: "从一批发票里提取开票信息，整理成台账",
    inputs: [{ id: "invoices", label: "发票", hint: "PDF 或图片，一次放一批", multiple: true }],
    steps: [
      "逐张识别发票代码、发票号码、开票日期、销售方、购买方、税号、金额、税额、价税合计",
      "价税合计 ≠ 金额 + 税额 的标出来",
      "按开票日期排序，生成发票台账 Excel，最后一行合计",
    ],
    checks: ["每张发票的金额 + 税额 = 价税合计", "台账行数与发票张数一致", "没有重复的发票号码"],
    outputName: "发票台账_{本期}.xlsx",
  },
  {
    templateId: "voucher-check",
    role: "accounting",
    name: "凭证与明细账核对",
    description: "核对记账凭证和科目明细账是否一致",
    inputs: [
      { id: "vouchers", label: "记账凭证", hint: "凭证列表导出的 Excel" },
      { id: "ledger", label: "科目明细账", hint: "同期的明细账导出" },
    ],
    steps: [
      "按凭证号 + 科目把凭证分录和明细账逐条对应",
      "找出凭证有、明细账没有的分录，以及金额或方向不一致的分录",
      "核对每张凭证借贷是否平衡",
      "生成核对结果 Excel：差异清单在第一页，借贷不平的凭证单独一页",
    ],
    checks: ["凭证借方合计 = 贷方合计", "差异清单中的每一条都注明了差异原因（缺失 / 金额 / 方向）"],
    outputName: "凭证核对_{本期}.xlsx",
  },
  {
    templateId: "ticket-weekly",
    role: "service",
    name: "工单周报",
    description: "把一周的工单导出整理成周报",
    inputs: [{ id: "tickets", label: "工单导出", hint: "客服系统导出的 Excel / CSV，可以多个", multiple: true }],
    steps: [
      "合并所有工单，按工单号去重",
      "按问题类别统计数量和占比，列出数量最多的前 5 类",
      "统计平均首次响应时长、平均解决时长、超时未解决的工单",
      "从工单内容里归纳本周用户反映最集中的 3 个问题，每个附 2 条典型原话",
      "生成周报 Word 文档，附一个统计 Excel",
    ],
    checks: ["去重后的工单数与各类别数量之和一致", "超时工单清单里的每一条确实超过了时限"],
    outputName: "客服周报_{本期}.docx",
    askEachRun: "这是哪一周？响应时限是多少（默认 24 小时）",
  },
  {
    templateId: "faq-from-chats",
    role: "service",
    name: "整理常见问题",
    description: "从聊天记录或工单里整理出常见问题和标准回复",
    inputs: [{ id: "records", label: "聊天记录 / 工单", hint: "导出的 Excel、TXT 或 Word", multiple: true }],
    steps: [
      "通读记录，把同一类问题归在一起（不同说法算同一类）",
      "按出现次数从多到少排序，每类写一个标准问法",
      "参考记录里客服给过的有效回答，为每类写一段标准回复，语气礼貌简洁",
      "生成 Word 文档：问题、出现次数、标准回复、原始示例",
    ],
    checks: ["每个问题都至少有一条原始记录作为依据", "没有两个问题实际说的是同一件事"],
    outputName: "常见问题_{本期}.docx",
  },
];

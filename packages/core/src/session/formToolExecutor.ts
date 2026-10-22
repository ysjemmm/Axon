/**
 * FormToolExecutor —— ask_form 工具：把「需要用户填一套参数」变成一张声明式表单
 *
 * 与 AskUserToolExecutor 同构：解析模型给的 form → 走挂起门等用户提交 → 把提交结果整形成
 * 模型能读的文本。区别只在载荷：ask_user 回传的是选项 id 列表，这里回传的是字段值（可含表格）。
 */

import { ToolName } from "../tools/index.js";
import { normalizeFormSpec, formatFormSubmission, type FormSpec, type FormSubmitPayload } from "./formSchema.js";

/** ask_form 工具执行请求。 */
export interface FormToolExecuteRequest {
  toolName: string;
  toolArgs: Record<string, unknown>;
  toolCallId: string;
}

/** ask_form 工具执行结果。 */
export interface FormToolExecuteResult {
  result: string;
  status: "success" | "error";
}

/** 依赖注入：把挂起门从 AgentSession 注入（与 AskUserToolExecutor 同一套做法）。 */
export interface FormToolExecutorDeps {
  waitForFormSubmit: (toolCallId: string, spec: FormSpec) => Promise<FormSubmitPayload | null>;
}

export class FormToolExecutor {
  constructor(private readonly deps: FormToolExecutorDeps) {}

  async execute(req: FormToolExecuteRequest): Promise<FormToolExecuteResult> {
    if (req.toolName !== ToolName.AskForm) {
      return { result: `未知的表单工具 ${req.toolName}`, status: "error" };
    }

    const normalized = normalizeFormSpec(req.toolArgs.form);
    if (!normalized.spec) {
      // 规格不合法时不弹门，直接把原因回给模型让它自己改——弹一张空表单只会浪费用户一次点击。
      return { result: `ask_form 调用失败：${normalized.error ?? "form 规格无效"}`, status: "error" };
    }

    const payload = await this.deps.waitForFormSubmit(req.toolCallId, normalized.spec);

    if (!payload) {
      return {
        result:
          "本次表单已被取消（会话结束或用户中止），没有拿到用户填写的内容。" +
          "请基于已有信息自行继续，或说明你的假设，不要重复抛同一张表单。",
        status: "error",
      };
    }

    return { result: formatFormSubmission(normalized.spec, payload), status: "success" };
  }
}

/** 与 core/cowork/flows.ts、core/cowork/checks.ts 同构（web 是独立工程，引用不到 core） */

export interface CoworkFlowInput {
  id: string;
  label: string;
  hint?: string;
  multiple?: boolean;
  optional?: boolean;
}

export interface CoworkFlow {
  id: string;
  name: string;
  description?: string;
  inputs: CoworkFlowInput[];
  steps: string[];
  checks: string[];
  outputName?: string;
  askEachRun?: string;
  templateId?: string;
  createdAt: number;
  updatedAt: number;
  runs?: { sessionId: string; at: number }[];
}

/** 编辑中 / 未保存的流程（模板、AI 草稿） */
export type CoworkFlowDraft = Omit<CoworkFlow, "id" | "createdAt" | "updatedAt" | "runs"> & { id?: string };

export type CoworkCheckStatus = "pass" | "warn" | "fail";

export interface CoworkCheck {
  label: string;
  status: CoworkCheckStatus;
  detail?: string;
}

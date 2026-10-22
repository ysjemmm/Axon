/**
 * 声明式表单的前端类型
 *
 * 与 core 的 FormSpec 一一对应，但**不共用同一份定义**：表单规格经 JSON 跨进程传输，
 * 前端只消费"已经规整过"的字段。core 侧负责校验与截断（模型可能给出任意大的结构），
 * 前端据此直接渲染，不信模型、也不重复校验结构合法性。
 */

export interface FormOptionData {
  value: string;
  label: string;
  description?: string;
}

export interface FormColumnData {
  key: string;
  label: string;
  type: "text" | "number" | "select";
  options?: FormOptionData[];
  /** false = 只读列 */
  editable?: boolean;
  align?: "left" | "right";
}

export interface FormRowActionData {
  id: string;
  label: string;
  danger?: boolean;
}

export type FormFieldTypeData =
  | "text"
  | "textarea"
  | "number"
  | "select"
  | "radio"
  | "checkbox"
  | "switch"
  | "slider"
  | "date"
  | "time"
  | "tags"
  | "table"
  | "section"
  | "note";

export interface FormFieldData {
  type: FormFieldTypeData;
  name?: string;
  label?: string;
  help?: string;
  placeholder?: string;
  required?: boolean;
  default?: unknown;
  options?: FormOptionData[];
  min?: number;
  max?: number;
  step?: number;
  rows?: number;
  columns?: FormColumnData[];
  data?: Record<string, unknown>[];
  selectable?: boolean;
  addable?: boolean;
  removable?: boolean;
  rowActions?: FormRowActionData[];
  title?: string;
  text?: string;
}

export interface FormSpecData {
  title?: string;
  description?: string;
  fields: FormFieldData[];
  submitLabel?: string;
  buttons?: { id: string; label: string }[];
}

/** 用户提交时交给上层的内容：当前全部字段值 + 触发的动作。 */
export interface FormSubmitData {
  /** "submit" | 自定义按钮 id | `row:<表格名>:<行下标>:<动作 id>` */
  action: string;
  values: Record<string, unknown>;
  /** 表格名 → 被勾选的行下标 */
  selectedRows?: Record<string, string[]>;
  /** 行内操作命中的位置 */
  row?: { table: string; index: number; actionId: string };
}

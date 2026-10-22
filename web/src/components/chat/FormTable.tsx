/**
 * FormTable —— 表单里的可编辑表格控件
 *
 * 存在的意义是「让用户在结构化数据上逐格确认」：列可编辑、行可增删、行内可挂操作按钮。
 *
 * 行内按钮点击时**不单独回传**，而是连同当前整张表的值一起提交：用户改到一半顺手点了
 * 「删除」，我们得把此刻的全量内容交给模型；只回一个行号会让它拿不到上下文。
 */

import { Plus, Trash2 } from "lucide-react";
import type { FormColumnData, FormRowActionData } from "./formTypes";

export interface FormTableProps {
  columns: FormColumnData[];
  rows: Record<string, unknown>[];
  selectable?: boolean;
  addable?: boolean;
  removable?: boolean;
  rowActions?: FormRowActionData[];
  /** 已勾选的行下标（字符串形式，与回传格式一致） */
  selected: string[];
  disabled?: boolean;
  onRowsChange: (rows: Record<string, unknown>[]) => void;
  onToggleRow: (index: number) => void;
  onRowAction: (index: number, actionId: string) => void;
}

const CELL_INPUT =
  "w-full bg-transparent text-[11px] text-foreground outline-none placeholder:text-muted-foreground/40 px-1.5 py-1 rounded hover:bg-muted/40 focus:bg-muted/60 transition-colors";

export function FormTable({
  columns,
  rows,
  selectable,
  addable,
  removable,
  rowActions,
  selected,
  disabled,
  onRowsChange,
  onToggleRow,
  onRowAction,
}: FormTableProps) {
  const patchCell = (rowIndex: number, key: string, raw: string, type: FormColumnData["type"]) => {
    const next = rows.map((r, i) => {
      if (i !== rowIndex) return r;
      // 数字列保留数字类型：回传给模型的是 8080 而不是 "8080"，
      // 免得它再把字符串当数字用时多一层转换（也避免空值变成 NaN）。
      const value = type === "number" ? (raw.trim() === "" ? null : Number(raw)) : raw;
      return { ...r, [key]: value };
    });
    onRowsChange(next);
  };

  const addRow = () => {
    const empty: Record<string, unknown> = {};
    for (const col of columns) empty[col.key] = col.type === "number" ? null : "";
    onRowsChange([...rows, empty]);
  };

  const removeRow = (index: number) => {
    onRowsChange(rows.filter((_, i) => i !== index));
  };

  return (
    <div className="rounded-lg border border-border/60 overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <thead>
            <tr className="bg-muted/40">
              {selectable && <th className="w-7 px-1.5 py-1" />}
              {columns.map((col) => (
                <th
                  key={col.key}
                  className={`px-1.5 py-1 text-[10px] font-medium text-muted-foreground/70 whitespace-nowrap ${
                    col.align === "right" || col.type === "number" ? "text-right" : "text-left"
                  }`}
                >
                  {col.label}
                </th>
              ))}
              {(removable || (rowActions && rowActions.length > 0)) && <th className="w-16 px-1.5 py-1" />}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td
                  colSpan={columns.length + (selectable ? 1 : 0) + (removable ? 1 : 0)}
                  className="px-2 py-2 text-[11px] text-muted-foreground/50 text-center"
                >
                  暂无数据{addable ? "，可在下方添加一行" : ""}
                </td>
              </tr>
            )}
            {rows.map((row, index) => (
              <tr key={index} className="border-t border-border/40">
                {selectable && (
                  <td className="px-1.5 py-1 align-middle">
                    <input
                      type="checkbox"
                      className="w-3.5 h-3.5 accent-[var(--primary)] cursor-pointer"
                      checked={selected.includes(String(index))}
                      disabled={disabled}
                      onChange={() => onToggleRow(index)}
                    />
                  </td>
                )}
                {columns.map((col) => {
                  const value = row[col.key];
                  const editable = col.editable !== false && !disabled;
                  const alignRight = col.align === "right" || col.type === "number";
                  return (
                    <td key={col.key} className={`px-0.5 py-0.5 align-middle ${alignRight ? "text-right" : ""}`}>
                      {!editable ? (
                        <span className="block px-1.5 py-1 text-[11px] text-foreground/80">
                          {value == null || value === "" ? "—" : String(value)}
                        </span>
                      ) : col.type === "select" ? (
                        <select
                          className={`${CELL_INPUT} bg-transparent`}
                          value={value == null ? "" : String(value)}
                          onChange={(e) => patchCell(index, col.key, e.target.value, "text")}
                        >
                          <option value="">—</option>
                          {(col.options ?? []).map((o) => (
                            <option key={o.value} value={o.value}>
                              {o.label}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <input
                          type={col.type === "number" ? "number" : "text"}
                          className={`${CELL_INPUT} ${alignRight ? "text-right" : ""}`}
                          value={value == null ? "" : String(value)}
                          placeholder="—"
                          onChange={(e) => patchCell(index, col.key, e.target.value, col.type)}
                        />
                      )}
                    </td>
                  );
                })}
                {(removable || (rowActions && rowActions.length > 0)) && (
                  <td className="px-1.5 py-1 align-middle whitespace-nowrap text-right">
                    {(rowActions ?? []).map((a) => (
                      <button
                        key={a.id}
                        onClick={() => onRowAction(index, a.id)}
                        disabled={disabled}
                        className={`ml-1 px-1 py-0.5 rounded text-[10px] transition-colors disabled:opacity-40 ${
                          a.danger
                            ? "text-destructive hover:bg-destructive/10"
                            : "text-muted-foreground hover:text-foreground hover:bg-muted/60"
                        }`}
                      >
                        {a.label}
                      </button>
                    ))}
                    {removable !== false && !disabled && (
                      <button
                        onClick={() => removeRow(index)}
                        className="ml-1 p-0.5 rounded text-muted-foreground/60 hover:text-destructive hover:bg-destructive/10 transition-colors align-middle"
                        title="删除此行"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {addable && !disabled && (
        <button
          onClick={addRow}
          className="w-full flex items-center justify-center gap-1 px-2 py-1 text-[11px] text-muted-foreground/70 hover:text-foreground hover:bg-muted/40 border-t border-border/40 transition-colors"
        >
          <Plus className="w-3 h-3" />
          添加一行
        </button>
      )}
    </div>
  );
}

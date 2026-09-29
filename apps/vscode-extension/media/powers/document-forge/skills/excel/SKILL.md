---
name: excel
description: 生成 Excel 表格（.xlsx / .csv），含表头、多工作表、列宽与数字格式。
---

# 生成 Excel

## 实现方式（按优先级选）
1. **Python + openpyxl** —— 功能最全，首选
   ```
   pip install openpyxl
   ```
2. **Node + exceljs** —— 没有 Python 时用。装到工作区之外的临时目录，别污染用户项目
   ```
   npm i exceljs --prefix "<临时目录绝对路径>"
   ```
3. **退化为 CSV** —— 只要数据表格、不要求样式时最稳（零依赖，Excel / WPS 可直接打开）

## Python 模板
```python
from openpyxl import Workbook
from openpyxl.styles import Font

wb = Workbook()
ws = wb.active
ws.title = "Sheet1"

ws.append(["列1", "列2"])
for c in ws[1]:
    c.font = Font(bold=True)

for row in [["a", 1], ["b", 2]]:
    ws.append(row)

ws.freeze_panes = "A2"
ws.column_dimensions["A"].width = 20

wb.save(r"<绝对路径>.xlsx")
```

## 关键点
- 数字写成 `int` / `float`，**不要写字符串** —— 否则 Excel 里是文本、左对齐、不能求和
- 表头加粗 + 冻结首行（`freeze_panes = "A2"`），这是可读性下限
- 列太窄会让中文显示成 `###`，设 `column_dimensions[...].width`
- CSV 必须用 **UTF-8 带 BOM**（Python 写作 `encoding="utf-8-sig"`），否则中文在 Excel 里是乱码
- **验证**：生成后用 `list_dir` 确认文件在、大小 > 0

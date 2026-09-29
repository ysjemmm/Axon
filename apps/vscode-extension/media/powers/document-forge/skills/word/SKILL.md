---
name: word
description: 生成 Word 文档（.docx），含标题层级、段落、表格与图片。
---

# 生成 Word

## 实现方式
1. **Python + python-docx** —— 首选
   ```
   pip install python-docx
   ```
2. **Node + docx** —— 没有 Python 时用，装到工作区之外的临时目录
   ```
   npm i docx --prefix "<临时目录绝对路径>"
   ```

## Python 模板
```python
from docx import Document

doc = Document()
doc.add_heading("文档标题", level=0)
doc.add_heading("一级标题", level=1)
doc.add_paragraph("正文段落。")

table = doc.add_table(rows=1, cols=2)
table.style = "Table Grid"
hdr = table.rows[0].cells
hdr[0].text, hdr[1].text = "列1", "列2"
for a, b in [("a", "b")]:
    cells = table.add_row().cells
    cells[0].text, cells[1].text = a, b

doc.save(r"<绝对路径>.docx")
```

## 关键点
- 层级用 `add_heading(level=...)`，**不要**用加粗大字号假装标题 —— 那样 Word 的导航窗格和自动目录都用不了
- 表格加 `table.style = "Table Grid"`，否则没有边框、看着像错版
- 部分环境中文默认字体会退化，必要时显式设置 `doc.styles["Normal"].font.name` 与 `_element.rPr.rFonts` 的 eastAsia
- **验证**：`list_dir` 确认文件存在且大小 > 0（.docx 是 zip 包，正常至少几 KB）

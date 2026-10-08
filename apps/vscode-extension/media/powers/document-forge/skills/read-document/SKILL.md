---
name: read-document
description: 读取 Excel / PDF / Word 等二进制文档的内容（转成文本或 Markdown 后再读）。
---

# 读取文档内容

## 为什么需要这个技能

`read_file` 只能读文本。Excel（.xlsx）、Word（.docx）本质是 zip 压缩包，PDF 是二进制格式 ——
直接 `read_file` 得到的是乱码，不是内容。

做法是：**先用脚本把文档转成文本/Markdown 落到临时文件，再 `read_file` 那个中间产物。**
不要试图直接读原始二进制文件。

## 通用流程

1. 确认文件确实存在（`list_dir` 或 `read_file` 父目录），拿到绝对路径
2. 按下方对应格式写转换脚本，输出到临时目录（**不要写进用户的工作区**）
3. `read_file` 读取转换结果
4. 转换失败要如实说明失败原因，**不要凭文件名猜内容**

临时文件建议放系统临时目录，命名带来源文件名便于排查，例如
`<临时目录>/axon-doc-read/<原文件名>.md`。

## Excel（.xlsx / .xls / .csv）

`.csv` 直接 `read_file` 即可，无需转换。以下针对 `.xlsx`。

```python
# pip install openpyxl
from openpyxl import load_workbook

# data_only=True 取公式的【计算结果】而不是公式本身——用户问"这列合计是多少"，
# 要的是数字，不是 "=SUM(B2:B10)"。
wb = load_workbook(r"<绝对路径>.xlsx", data_only=True)

lines = []
for ws in wb.worksheets:
    lines.append(f"## 工作表：{ws.title}（{ws.max_row} 行 × {ws.max_column} 列）\n")
    for row in ws.iter_rows(values_only=True):
        # 整行为空的跳过，避免几千行空白灌进上下文
        if all(c is None for c in row):
            continue
        lines.append(" | ".join("" if c is None else str(c) for c in row))
    lines.append("")

with open(r"<输出路径>.md", "w", encoding="utf-8") as f:
    f.write("\n".join(lines))
```

要点：
- **先只读表头和前若干行**（`ws.iter_rows(max_row=30)`）确认结构，再决定要不要全量读 ——
  几万行的表全量灌进上下文会挤掉其他信息，而且多数问题只需要看结构 + 聚合结果
- 数据量大时**让脚本直接算**（求和、分组、对账差异），只把结果写出来，不要把原始数据全搬进上下文
- 多工作表要逐个标明来源，否则数字混在一起无法回溯

### ⚠️ 公式单元格读到 None（实测确认，必读）

`data_only=True` 读的是 **Excel 上次保存时缓存的计算结果**，openpyxl 自己并不算公式。
如果文件是脚本生成的、或从未被 Excel/WPS 打开保存过，公式单元格会读到 `None`。

实测：脚本写入 `=SUM(C2:C5)` 后用 `data_only=True` 读回，该单元格值为 `None`；
换 `data_only=False` 才读到公式文本 `'=SUM(C2:C5)'`。

这在会计场景极易踩坑 —— 表里有合计行，读出来却是空的，然后报告"合计为空"。正确做法：

```python
wb = load_workbook(path, data_only=True)
ws = wb.active
value = ws["C6"].value

if value is None:
    # 缓存缺失：改读公式，并【自己按原始数据算一遍】
    wb_f = load_workbook(path, data_only=False)
    formula = wb_f[ws.title]["C6"].value   # 如 '=SUM(C2:C5)'
    # 用 iter_rows 取出 C2:C5 自行求和，把算出的数字报告给用户，
    # 同时说明"该单元格是公式，文件无缓存值，结果由我按数据重算"
```

绝不能把 `None` 当成 0 或"空"报告给用户。

## PDF

```python
# pip install pypdf
from pypdf import PdfReader

reader = PdfReader(r"<绝对路径>.pdf")
lines = []
for i, page in enumerate(reader.pages, 1):
    text = page.extract_text() or ""
    lines.append(f"## 第 {i} 页\n{text}\n")

with open(r"<输出路径>.md", "w", encoding="utf-8") as f:
    f.write("\n".join(lines))
```

要点：
- **扫描版 PDF 抽不出文字**（`extract_text()` 返回空或极少字符）。这种情况要明确告知用户
  "这是扫描件，需要 OCR"，**不要**因为抽到几个零散字符就假装读懂了
- 表格在 PDF 里会被抽成错位的文本流，涉及表格数据时提醒用户核对，或改用 `pdfplumber`
  的 `extract_tables()`
- 页数多时先读前几页确认文档类型，再决定范围

## Word（.docx）

```python
# pip install python-docx
from docx import Document

doc = Document(r"<绝对路径>.docx")
lines = []

for p in doc.paragraphs:
    if not p.text.strip():
        continue
    # 保留标题层级，文档结构对理解内容很关键
    style = p.style.name or ""
    if style.startswith("Heading"):
        level = style.replace("Heading", "").strip()
        prefix = "#" * (int(level) + 1) if level.isdigit() else "##"
        lines.append(f"{prefix} {p.text}")
    else:
        lines.append(p.text)

# 表格独立于 paragraphs，必须单独遍历，否则表格内容会整块丢失
for i, table in enumerate(doc.tables, 1):
    lines.append(f"\n### 表格 {i}")
    for row in table.rows:
        lines.append(" | ".join(cell.text.strip() for cell in row.cells))

with open(r"<输出路径>.md", "w", encoding="utf-8") as f:
    f.write("\n".join(lines))
```

要点：
- **表格必须单独遍历**：`doc.paragraphs` 不含表格内容，只读段落会静默丢掉整张表
- 页眉页脚、批注、修订痕迹默认都读不到，用户问到这些要说明
- `.doc`（旧版二进制格式）python-docx 读不了，需先转 `.docx`

## 没有 Python 时

Node 侧替代方案（装到工作区之外的临时目录）：

```
npm i exceljs --prefix "<临时目录>"     # Excel
npm i pdf-parse --prefix "<临时目录>"   # PDF
npm i mammoth --prefix "<临时目录>"     # Word → HTML/文本
```

装不上要如实说明缺什么依赖，不要绕过去编造内容。

## 纪律

- 转换产物放临时目录，**不要污染用户的工作区**
- 大文件优先"脚本里算好、只读结果"，而不是全量读进上下文
- 抽取失败（扫描件 / 加密 / 格式损坏）必须如实报告，绝不根据文件名或部分片段推测内容
- 读完即用，不要把中间产物留在磁盘上当缓存（用户改了原文件，缓存就是错的）

---
name: pdf
description: 生成 PDF 文件（文本 / 表格 / 简单排版）。
---

# 生成 PDF

PDF 生成方式差异很大，**先判断用途**再选：

| 用途 | 推荐方式 |
|---|---|
| 纯文本 / 简单排版 / 需要精确控制位置 | **Python + reportlab** |
| 已有 HTML / 网页样式，想原样转 PDF | **Node + puppeteer**（复用浏览器排版） |
| 只是把现成内容导出存档 | 先写 Markdown/HTML，再转换 |

## Python（reportlab）模板
```python
from reportlab.lib.pagesizes import A4
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer
from reportlab.lib.styles import getSampleStyleSheet

# 中文必须注册 CID 字体，否则输出全是方块
pdfmetrics.registerFont(UnicodeCIDFont("STSong-Light"))

styles = getSampleStyleSheet()
styles["Normal"].fontName = "STSong-Light"
styles["Title"].fontName = "STSong-Light"

doc = SimpleDocTemplate(r"<绝对路径>.pdf", pagesize=A4)
story = [Paragraph("标题", styles["Title"]), Spacer(1, 12), Paragraph("正文。", styles["Normal"])]
doc.build(story)
```

## 关键点
- **中文一定要注册字体**（`STSong-Light` 是 reportlab 内置 CID 字体，不需要外部字体文件）。
  漏了不会报错，但整篇输出成方块 —— 这是最常见的翻车点
- 表格用 `reportlab.platypus.Table`，不要用空格对齐假装表格
- **验证**：`list_dir` 看存在与大小；只有几百字节通常意味着内容为空
- 不要用"截图再贴进 PDF"来糊弄文本内容 —— 那样无法选中、无法检索

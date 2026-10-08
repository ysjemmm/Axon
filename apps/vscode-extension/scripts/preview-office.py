import json
import os
import sys
import zipfile
import xml.etree.ElementTree as ET

# Windows 下 Python 默认用系统 ANSI 编码（中文环境是 GBK）写 stdout，
# 调用方按 UTF-8 解码时中文会变成替换字符。调用方已经设了 PYTHONIOENCODING，
# 这里再兜一道：脚本被手动执行或从别处调用时同样不会乱码。
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")


def unsupported(message):
    return {"kind": "unsupported", "message": message}


def excel_preview(path):
    try:
        import openpyxl
        workbook = openpyxl.load_workbook(path, read_only=True, data_only=False)
        blocks = []
        for sheet in workbook.worksheets:
            rows = []
            for row in sheet.iter_rows(values_only=True):
                values = ["" if value is None else str(value).replace("|", "\\|").replace("\n", " ") for value in row]
                if any(values):
                    rows.append(values)
            if not rows:
                continue
            width = max(len(row) for row in rows)
            normalized = [row + [""] * (width - len(row)) for row in rows]
            blocks.append(f"## {sheet.title}\n")
            blocks.append("| " + " | ".join(normalized[0]) + " |\n")
            blocks.append("| " + " | ".join(["---"] * width) + " |\n")
            for row in normalized[1:200]:
                blocks.append("| " + " | ".join(row) + " |\n")
            if len(normalized) > 200:
                blocks.append("\n> 仅显示前 200 行\n")
        return {"kind": "office", "content": "".join(blocks) or "（工作簿为空）"}
    except Exception as exc:
        return unsupported(f"无法预览 Excel：{exc}")


W_NS = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"


def _para_text(paragraph):
    """取一个 <w:p> 的纯文本。<w:br>/<w:tab> 转成对应空白。"""
    parts = []
    for node in paragraph.iter():
        tag = node.tag
        if tag == f"{W_NS}t":
            parts.append(node.text or "")
        elif tag == f"{W_NS}tab":
            parts.append("\t")
        elif tag == f"{W_NS}br":
            parts.append("\n")
    return "".join(parts).strip()


def _cell_text(cell):
    """单元格可能含多个段落，用空格接起来（表格里换行会破坏 markdown 行结构）。"""
    lines = [_para_text(p) for p in cell.findall(f"{W_NS}p")]
    text = " ".join(line for line in lines if line)
    return text.replace("|", "\\|")


def _table_rows(table):
    rows = []
    for row in table.findall(f"{W_NS}tr"):
        cells = [_cell_text(c) for c in row.findall(f"{W_NS}tc")]
        if any(cells):
            rows.append(cells)
    return rows


def docx_preview(path):
    try:
        with zipfile.ZipFile(path) as archive:
            xml = archive.read("word/document.xml")
        root = ET.fromstring(xml)
        body = root.find(f"{W_NS}body")
        if body is None:
            return unsupported("文档结构异常，无法预览")

        blocks = []
        # 只遍历 body 的【直接子节点】，按文档顺序处理。
        #
        # ⚠️ 不能用 root.iter() 找所有 <w:p>：表格单元格内部也是 <w:p>，
        # 那样会把表格摊平成一行一个字段（实测把「项目名称 | 【填写】」这种两列表格
        # 拆成了上下两行），完全丢掉表格结构。
        for child in body:
            if child.tag == f"{W_NS}p":
                text = _para_text(child)
                if text:
                    blocks.append(text)
            elif child.tag == f"{W_NS}tbl":
                rows = _table_rows(child)
                if not rows:
                    continue
                width = max(len(r) for r in rows)
                norm = [r + [""] * (width - len(r)) for r in rows]
                # 两列表格大多是「字段名 | 值」的键值表，首行不是表头。
                # 加分隔行会让渲染端把「项目名称 | 【填写】」当成列名加粗显示，
                # 所以只给三列以上（更可能是真数据表）的表格加表头。
                lines = ["| " + " | ".join(norm[0]) + " |"]
                if width > 2:
                    lines.append("| " + " | ".join(["---"] * width) + " |")
                for r in norm[1:]:
                    lines.append("| " + " | ".join(r) + " |")
                blocks.append("\n".join(lines))

        return {"kind": "office", "content": "\n\n".join(blocks) or "（文档为空）"}
    except Exception as exc:
        return unsupported(f"无法预览 Word：{exc}")


A_NS = "{http://schemas.openxmlformats.org/drawingml/2006/main}"


def _slide_number(name):
    """按 slide2 < slide10 排序；字符串排序会把 slide10 排到 slide2 前面。"""
    digits = "".join(ch for ch in name if ch.isdigit())
    return int(digits) if digits else 0


def pptx_preview(path):
    try:
        with zipfile.ZipFile(path) as archive:
            slides = sorted(
                (n for n in archive.namelist() if n.startswith("ppt/slides/slide") and n.endswith(".xml")),
                key=_slide_number,
            )
            output = []
            for index, slide in enumerate(slides, 1):
                root = ET.fromstring(archive.read(slide))
                # 按段落（<a:p>）分行，而不是把整页的 <a:t> 拼成一行 ——
                # 后者会让标题和正文、各个文本框全糊在一起。
                lines = []
                for para in root.iter(f"{A_NS}p"):
                    text = "".join(t.text or "" for t in para.iter(f"{A_NS}t")).strip()
                    if text:
                        lines.append(text)
                if lines:
                    output.append(f"## 幻灯片 {index}\n\n" + "\n\n".join(lines))
        return {"kind": "office", "content": "\n\n".join(output) or "（演示文稿为空）"}
    except Exception as exc:
        return unsupported(f"无法预览 PowerPoint：{exc}")


def main():
    path = sys.argv[1]
    ext = os.path.splitext(path)[1].lower()
    if ext == ".xlsx":
        result = excel_preview(path)
    elif ext == ".docx":
        result = docx_preview(path)
    elif ext == ".pptx":
        result = pptx_preview(path)
    elif ext in (".xls", ".doc", ".ppt"):
        result = unsupported("该旧版 Office 格式暂不支持预览，请另存为 xlsx、docx 或 pptx 后重试。")
    else:
        result = unsupported("该文件类型不支持预览。")
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()

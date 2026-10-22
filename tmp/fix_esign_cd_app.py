# -*- coding: utf-8 -*-
"""整理 esign_cd_app.xlsx：补全平台标记、标注仓库复用关系、新增统计汇总页"""
import re
import shutil
from collections import Counter, defaultdict
from datetime import datetime

import openpyxl
from openpyxl.styles import Font, PatternFill
from openpyxl.utils import get_column_letter

SRC = r"c:\Users\17120\Documents\esign_cd_app.xlsx"
backup = r"c:\Users\17120\Documents\esign_cd_app_backup_%s.xlsx" % datetime.now().strftime("%Y%m%d_%H%M%S")
shutil.copy(SRC, backup)
print("backup:", backup)

wb = openpyxl.load_workbook(SRC)
ws = wb["Result 1"]
rows = list(ws.iter_rows(values_only=True))
header = list(rows[0])
data = [list(r) for r in rows[1:]]

PLATFORM_COLS = header[2:10]  # PCWeb ... 支付宝小程序


def infer_platforms(name, path):
    n = (name or "").lower()
    p = (path or "").lower()
    s = n + " " + p
    tags = []
    if re.search(r"harmony|hm-mobile|hm_mobile", s):
        tags.append("鸿蒙")
    if re.search(r"android", s):
        tags.append("Android")
    if re.search(r"(^|[^a-z])ios([^a-z]|$)|iphone", s):
        tags.append("IOS")
    if re.search(r"alipay|zhifubao", s):
        tags.append("支付宝小程序")
    if re.search(r"weixin|wechat|wx-|-wx|miniprogram|mini-program|miniapp|mini-app|applet|taro|bytedance-mini", s):
        if "支付宝小程序" not in tags:
            tags.append("微信小程序")
    if re.search(r"esign-client|electron|desktop", s):
        tags.append("PC客户端")
    if re.search(r"(^|[^a-z])h5([^a-z]|$)|-wap|middleh5|mobile", s):
        tags.append("H5")
    if re.search(r"front|-web|web-|-fe|console|portal|admin|cms|website", s) and "PC客户端" not in tags:
        tags.append("PCWeb")
    return tags


def infer_tech(name, path):
    s = ((name or "") + " " + (path or "")).lower()
    if re.search(r"android", s):
        return "Android"
    if re.search(r"(^|[^a-z])ios([^a-z]|$)|iphone", s):
        return "iOS"
    if re.search(r"harmony", s):
        return "鸿蒙"
    if re.search(r"esign-client|electron|desktop", s):
        return "PC客户端"
    if re.search(r"alipay|weixin|wechat|wx-|-wx|miniprogram|mini-program|miniapp|mini-app|applet|taro|bytedance-mini|dingtalk|ding-|feishu|lark", s):
        return "小程序/轻应用"
    if re.search(r"(^|[^a-z])h5([^a-z]|$)|-wap|middleh5|mobile", s):
        return "H5/移动Web"
    if re.search(r"sdk|jssdk|-ui$|ui-|components|design|utils|logger|skin|element|f2e|fe-infra|plugin", s):
        return "SDK/组件/工具"
    if re.search(r"front|-web|web-|-fe|console|portal|admin|cms|website|platform|manage|cockpit", s):
        return "PC Web"
    return "其他/待确认"


# 统计同仓库复用
bypath = defaultdict(list)
for r in data:
    bypath[r[1]].append(r[0])

# 仓库路径里的命名空间
def namespace(path):
    m = re.match(r"git@[^:]+:([^/]+)/", path or "")
    return m.group(1) if m else ""


# ---- 补全平台列（只填空格，不动人工标记）并记录来源 ----
src_col = len(header) + 1
extra = ["命名空间", "技术形态(推断)", "同仓库应用数", "同仓库其他应用名", "平台标记来源"]
for i, name in enumerate(extra):
    ws.cell(row=1, column=src_col + i, value=name)

filled_count = 0
for ri, r in enumerate(data, start=2):
    name, path = r[0], r[1]
    inferred = infer_platforms(name, path)
    has_manual = any(r[2 + i] is not None for i in range(len(PLATFORM_COLS)))
    filled_now = 0
    for i, col in enumerate(PLATFORM_COLS):
        if r[2 + i] is None and col in inferred:
            ws.cell(row=ri, column=3 + i, value="推断")
            filled_now += 1
    if filled_now:
        filled_count += 1
    others = [n for n in bypath[path] if n != name]
    ws.cell(row=ri, column=src_col, value=namespace(path))
    ws.cell(row=ri, column=src_col + 1, value=infer_tech(name, path))
    ws.cell(row=ri, column=src_col + 2, value=len(bypath[path]))
    ws.cell(row=ri, column=src_col + 3, value=", ".join(others) if others else "")
    if has_manual and filled_now:
        src = "人工+推断"
    elif has_manual:
        src = "人工"
    elif filled_now:
        src = "推断"
    else:
        src = ""
    ws.cell(row=ri, column=src_col + 4, value=src)

print("rows with inferred platform filled:", filled_count)

# 列宽
for i in range(src_col, src_col + len(extra)):
    ws.column_dimensions[get_column_letter(i)].width = 22

# ---- 统计汇总页 ----
if "统计汇总" in wb.sheetnames:
    del wb["统计汇总"]
st = wb.create_sheet("统计汇总", 0)
bold = Font(bold=True)
fill = PatternFill("solid", fgColor="FFF2CC")

uniq_repos = set(r[1] for r in data)
dup_repos = {p: ns for p, ns in bypath.items() if len(ns) > 1}

platform_manual = Counter()
platform_final = Counter()
tech_counter = Counter()
ns_counter = Counter()
for r in data:
    for i, col in enumerate(PLATFORM_COLS):
        if r[2 + i] is not None:
            platform_manual[col] += 1
    for t in infer_platforms(r[0], r[1]):
        platform_final[t] += 1
    tech_counter[infer_tech(r[0], r[1])] += 1
    ns_counter[namespace(r[1])] += 1


def section(row, title):
    c = st.cell(row=row, column=1, value=title)
    c.font = bold
    c.fill = fill
    return row + 1


r = 1
r = section(r, "基本统计")
for k, v in [
    ("应用总数(name 行数)", len(data)),
    ("独立仓库数(code_path 去重)", len(uniq_repos)),
    ("被多个应用引用的仓库数", len(dup_repos)),
    ("涉及重复引用的应用行数", sum(len(v) for v in dup_repos.values())),
    ("本次由推断补全平台标记的行数", filled_count),
]:
    st.cell(row=r, column=1, value=k)
    st.cell(row=r, column=2, value=v)
    r += 1

r += 1
r = section(r, "平台分布(平台: 原表人工标记数 / 推断补齐后的合计数)")
for col in PLATFORM_COLS:
    st.cell(row=r, column=1, value=col)
    st.cell(row=r, column=2, value=platform_manual.get(col, 0))
    st.cell(row=r, column=3, value=platform_final.get(col, 0))
    r += 1

r += 1
r = section(r, "技术形态分布(按名称推断)")
for k, v in tech_counter.most_common():
    st.cell(row=r, column=1, value=k)
    st.cell(row=r, column=2, value=v)
    r += 1

r += 1
r = section(r, "命名空间 Top 20")
for k, v in ns_counter.most_common(20):
    st.cell(row=r, column=1, value=k)
    st.cell(row=r, column=2, value=v)
    r += 1

r += 1
r = section(r, "重复引用仓库明细(仓库: 应用名列表)")
for p, names in sorted(dup_repos.items(), key=lambda x: -len(x[1])):
    st.cell(row=r, column=1, value=p)
    st.cell(row=r, column=2, value=", ".join(names))
    r += 1

st.column_dimensions["A"].width = 60
st.column_dimensions["B"].width = 80
st.column_dimensions["C"].width = 14

wb.save(SRC)
print("saved:", SRC)

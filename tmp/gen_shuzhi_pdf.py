# -*- coding: utf-8 -*-
"""生成《前端应用资产盘点与治理专项 · 述职报告》PDF。

数据源：c:\\Users\\17120\\Documents\\esign_cd_app.xlsx
输出：  c:\\Users\\17120\\Documents\\esign_cd_app_述职报告.pdf
零第三方依赖：minipdf 自解析 TTF 并内嵌子集字体。
"""
import os
import re
import sys

import openpyxl

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from minipdf import MiniPDF, TTF, A4_W, A4_H  # noqa: E402

XLSX = r"c:\Users\17120\Documents\esign_cd_app.xlsx"
OUT = r"c:\Users\17120\Documents\esign_cd_app_述职报告.pdf"
FONT_REG = r"C:\Windows\Fonts\Deng.ttf"
FONT_BOLD = r"C:\Windows\Fonts\Dengb.ttf"

# ============================ 1. 数据提取 ============================
wb = openpyxl.load_workbook(XLSX, data_only=True)
sec_rows = list(wb["统计汇总"].iter_rows(min_row=1, max_row=109, values_only=True))

summary, platform_rows, tech_rows, ns_rows, dup_rows = {}, [], [], [], []
section = None
for r in sec_rows:
    if r[0] is None:
        continue
    key = str(r[0])
    if key == "基本统计":
        section = "basic"
    elif key.startswith("平台分布"):
        section = "platform"
    elif key.startswith("技术形态分布"):
        section = "tech"
    elif key.startswith("命名空间"):
        section = "ns"
    elif key.startswith("重复引用仓库明细"):
        section = "dup"
        continue
    elif section == "basic":
        summary[key] = r[1]
        continue
    elif section == "dup":
        continue

    if section == "platform" and r[1] is not None:
        platform_rows.append((key, r[1], r[2]))
    elif section == "tech" and r[1] is not None:
        tech_rows.append((key, r[1]))
    elif section == "ns" and r[1] is not None:
        ns_rows.append((key, r[1]))

for r in sec_rows:
    if r[0] and str(r[0]).startswith("git@"):
        apps = [a.strip() for a in str(r[1]).split(",") if a.strip()] if r[1] else []
        dup_rows.append((str(r[0]), apps))
dup_rows.sort(key=lambda x: -len(x[1]))

ws = wb["Result 1"]
rows = list(ws.iter_rows(min_row=2, values_only=True))
from collections import Counter
src_counter = Counter(r[14] for r in rows)
ns_counter = Counter(r[10] for r in rows if r[10])
total_ns = len(ns_counter)
repo_set = {r[1] for r in rows if r[1]}
multi_repo_rows = sum(1 for r in rows if (r[12] or 0) > 1)

total_apps = summary.get("应用总数(name 行数)", len(rows))
total_repos = summary.get("独立仓库数(code_path 去重)", len(repo_set))
shared_repos = summary.get("被多个应用引用的仓库数", len(dup_rows))
manual_cnt = src_counter.get("人工", 0)
infer_cnt = src_counter.get("推断", 0)
none_cnt = src_counter.get(None, 0)

# ============================ 2. 颜色 ============================
C_BODY = (0.118, 0.161, 0.231)      # #1e293b
C_TITLE = (0.059, 0.239, 0.431)     # #0f3d6e
C_HEAD = (0.118, 0.251, 0.686)      # #1e40af
C_ACCENT = (0.145, 0.388, 0.922)    # #2563eb
C_GRAY = (0.392, 0.455, 0.545)      # #64748b
C_LIGHT = (0.580, 0.639, 0.718)     # #94a3b8
C_BORDER = (0.796, 0.835, 0.882)    # #cbd5e1
C_WHITE = (1, 1, 1)
C_LEAD_BG = (0.937, 0.965, 1.0)     # #eff6ff
C_LEAD_BD = (0.749, 0.859, 0.996)   # #bfdbfe
C_CARD_BG = (0.973, 0.980, 0.988)   # #f8fafc
C_CARD_BD = (0.886, 0.910, 0.941)   # #e2e8f0
C_RISK_BG = (1.0, 0.969, 0.929)     # #fff7ed
C_RISK_BD = (0.961, 0.620, 0.043)   # #f59e0b
C_OK_BG = (0.941, 0.992, 0.957)     # #f0fdf4
C_OK_BD = (0.133, 0.773, 0.369)     # #22c55e
C_BAR = (0.231, 0.510, 0.965)       # #3b82f6
C_BAR2 = (0.055, 0.647, 0.914)      # #0ea5e9
C_ROWBG = (0.985, 0.99, 0.995)

# ============================ 3. 排版引擎 ============================
CJK_RE = re.compile(r"[\u2e80-\u9fff\uff00-\uffef\u3000-\u303f\u00b7\u2014\u2026\u2018\u2019\u201c\u201d]")


def tokenize(s):
    """CJK 单字成 token，连续 ASCII 词整体成 token（保证不从词中间折行）。"""
    toks, buf = [], ""
    for ch in s:
        if CJK_RE.match(ch):
            if buf:
                toks.append(buf)
                buf = ""
            toks.append(ch)
        elif ch.isalnum() or ch in "._-/:@+~":
            buf += ch
        else:
            if buf:
                toks.append(buf)
                buf = ""
            toks.append(ch)
    if buf:
        toks.append(buf)
    return toks


class Report:
    ML = 45
    MR = 45
    MT = 48
    MB = 50
    CW = A4_W - 90

    def __init__(self):
        self.pdf = MiniPDF()
        self.fonts = {"reg": TTF(FONT_REG), "bold": TTF(FONT_BOLD)}
        self.missing = set()
        self._wcache = {}
        self.y = self.MT
        self.page_no = 0
        self._new_page()

    # ---------- 字体/度量 ----------
    def _new_page(self):
        self.pdf.new_page()
        self.y = self.MT
        self.page_no += 1

    def page_break(self):
        self._new_page()

    def ensure(self, h):
        if self.y + h > A4_H - self.MB:
            self._new_page()
            return True
        return False

    def _font(self, bold):
        return self.fonts["bold" if bold else "reg"]

    def gid(self, ch, bold):
        f = self._font(bold)
        g = f.glyph_id(ch)
        if g == 0:
            other = self._font(not bold)
            g2 = other.glyph_id(ch)
            if g2 != 0:
                return ("bold" if not bold else "reg"), g2
            self.missing.add(ch)
            return ("bold" if bold else "reg"), g
        return ("bold" if bold else "reg"), g

    def cw(self, ch, size, bold):
        key = (ch, round(size, 1), bold)
        if key in self._wcache:
            return self._wcache[key]
        fk, g = self.gid(ch, bold)
        f = self.fonts[fk]
        w = f.advance(g) * size / f.units_per_em
        self._wcache[key] = w
        return w

    def tw(self, s, size, bold=False):
        return sum(self.cw(c, size, bold) for c in s)

    # ---------- 绘制 ----------
    def draw_text(self, x, y_top, s, size, bold, color):
        """按字体分段绘制一行文本，返回绘制后的右端 x。y_top 为行顶。"""
        baseline = y_top + size * 0.92
        runs = []
        cur_key, cur_buf = None, []
        for ch in s:
            fk, g = self.gid(ch, bold)
            k = "F2" if fk == "bold" else "F1"
            if k != cur_key:
                if cur_buf:
                    runs.append((cur_key, cur_buf))
                cur_key, cur_buf = k, []
            cur_buf.append(g)
        if cur_buf:
            runs.append((cur_key, cur_buf))
        cx = x
        for k, gs in runs:
            hexs = "".join("%04X" % g for g in gs)
            self.pdf.gid_text(cx, A4_H - baseline, size, hexs, k, color)
            # 宽度按字符逐个回算（runs 内 gid 顺序对应字符顺序）
            cx += self._run_width(gs, k, size)
        return cx

    def _run_width(self, gs, key, size):
        f = self.fonts["bold" if key == "F2" else "reg"]
        return sum(f.advance(g) for g in gs) * size / f.units_per_em

    # ---------- 分行 ----------
    def wrap_rich(self, segments, max_w, size):
        """segments: [(text, bold)] -> [[(token, bold, w), ...], ...]"""
        lines, cur, cur_w = [], [], 0.0

        def flush():
            nonlocal cur, cur_w
            if cur:
                lines.append(cur)
                cur, cur_w = [], 0.0

        for text, bold in segments:
            for tok in tokenize(text):
                w = self.tw(tok, size, bold)
                if w > max_w:
                    # 超长 token（如完整仓库路径）：按字符强制拆行，避免压到相邻列
                    flush()
                    piece = ""
                    for ch in tok:
                        if piece and self.tw(piece + ch, size, bold) > max_w:
                            pw = self.tw(piece, size, bold)
                            lines.append([(piece, bold, pw)])
                            piece = ch
                        else:
                            piece += ch
                    if piece:
                        pw = self.tw(piece, size, bold)
                        if pw >= max_w:
                            lines.append([(piece, bold, pw)])
                        else:
                            cur = [(piece, bold, pw)]
                            cur_w = pw
                    continue
                if cur_w + w > max_w and cur and tok != " ":
                    flush()
                    if tok == " ":
                        continue
                cur.append((tok, bold, w))
                cur_w += w
        flush()
        return lines or [[]]

    def draw_rich_line(self, x, y_top, tokens, size, color):
        cx = x
        for tok, bold, w in tokens:
            self.draw_text(cx, y_top, tok, size, bold, color)
            cx += w
        return cx

    def para(self, segments, size=10.5, lh=16, color=C_BODY, x=None, max_w=None,
             space_after=5, first_indent=0.0):
        if isinstance(segments, str):
            segments = [(segments, False)]
        x = self.ML if x is None else x
        max_w = self.CW - first_indent if max_w is None else max_w
        lines = self.wrap_rich(segments, max_w, size)
        for i, line in enumerate(lines):
            self.ensure(lh)
            indent = first_indent if i == 0 else 0
            self.draw_rich_line(x + indent, self.y, line, size, color)
            self.y += lh
        self.y += space_after

    # ---------- 组件 ----------
    def h1(self, s):
        self.draw_text(self.ML, self.y, s, 21, True, C_TITLE)
        self.y += 30

    def sub(self, s):
        self.para(s, size=9.5, lh=14, color=C_GRAY, space_after=8)

    def h2(self, s):
        self.ensure(34)
        self.y += 8
        self.pdf.rect(self.ML, A4_H - self.y - 16, 4, 16, fill=C_HEAD)
        self.draw_text(self.ML + 10, self.y, s, 13.5, True, C_HEAD)
        self.y += 22

    def h3(self, s):
        self.ensure(26)
        self.y += 5
        self.draw_text(self.ML, self.y, s, 11.5, True, C_HEAD)
        self.y += 18

    def box(self, segments, bg, bd, size=10.5, lh=16, pad=9, space_after=7):
        if isinstance(segments, str):
            segments = [(segments, False)]
        w = self.CW
        lines = self.wrap_rich(segments, w - 2 * pad - 4, size)
        h = pad * 2 + len(lines) * lh
        if self.y + h > A4_H - self.MB:
            self._new_page()
        top = self.y
        self.pdf.rect(self.ML, A4_H - top - h, w, h, fill=bg)
        # 左侧色条
        self.pdf.rect(self.ML, A4_H - top - h, 3.5, h, fill=bd)
        yy = top + pad
        for line in lines:
            self.draw_rich_line(self.ML + pad + 2, yy, line, size, C_BODY)
            yy += lh
        self.y = top + h + space_after

    def cards(self, items):
        gap = 8
        n = len(items)
        per_row = 3
        cw = (self.CW - gap * (per_row - 1)) / per_row
        ch = 50
        rows_n = (n + per_row - 1) // per_row
        need = rows_n * ch + (rows_n - 1) * gap + 6
        if self.y + need > A4_H - self.MB:
            self._new_page()
        top = self.y
        for i, (num, label) in enumerate(items):
            r, c = divmod(i, per_row)
            x = self.ML + c * (cw + gap)
            yy = top + r * (ch + gap)
            self.pdf.rect(x, A4_H - yy - ch, cw, ch, fill=C_CARD_BG, stroke=C_CARD_BD)
            ns = self.tw(str(num), 18, True)
            self.draw_text(x + (cw - ns) / 2, yy + 6, str(num), 18, True, C_ACCENT)
            ls = self.tw(label, 8.5, False)
            self.draw_text(x + (cw - ls) / 2, yy + 30, label, 8.5, False, C_GRAY)
        self.y = top + need

    def table(self, headers, rows, widths, size=9, lh=12.5, pad=4.5, header_bg=C_HEAD):
        """rows: [[cell,...]] cell 为 str 或 ('bar', frac) 或 ('r', str) 右对齐"""
        x0 = self.ML

        def col_w(i):
            return widths[i]

        def wrap_cell(cell, w):
            if isinstance(cell, tuple) and cell[0] == "bar":
                return []
            txt = cell if isinstance(cell, str) else cell[1]
            return self.wrap_rich([(txt, False)], w - 2 * pad, size)

        def row_height(cells):
            maxl = 1
            for i, cell in enumerate(cells):
                maxl = max(maxl, len(wrap_cell(cell, col_w(i))))
            return maxl * lh + 2 * pad

        def draw_header():
            hh = 17
            xx = x0
            self.pdf.rect(x0, A4_H - self.y - hh, sum(widths), hh, fill=header_bg)
            for i, htxt in enumerate(headers):
                self.draw_text(xx + pad, self.y + 2.5, htxt, size + 0.5, True, C_WHITE)
                xx += col_w(i)
            self.y += hh

        self.ensure(40)
        draw_header()
        for ri, cells in enumerate(rows):
            rh = row_height(cells)
            if self.y + rh > A4_H - self.MB:
                self._new_page()
                draw_header()
            top = self.y
            # 行背景与网格
            if ri % 2 == 1:
                self.pdf.rect(x0, A4_H - top - rh, sum(widths), rh, fill=C_ROWBG)
            xx = x0
            for i, cell in enumerate(cells):
                w = col_w(i)
                if isinstance(cell, tuple) and cell[0] == "bar":
                    frac = cell[1]
                    bw = max(2, (w - 2 * pad) * frac)
                    bh = 8
                    byy = A4_H - top - (rh - bh) / 2 - bh
                    self.pdf.rect(xx + pad, byy, bw, bh, fill=cell[2] if len(cell) > 2 else C_BAR)
                else:
                    txt = cell if isinstance(cell, str) else cell[1]
                    right = isinstance(cell, tuple) and cell[0] == "r"
                    lines = wrap_cell(cell, w)
                    yy = top + pad
                    for ln in lines:
                        lw = sum(t[2] for t in ln)
                        tx = xx + w - pad - lw if right else xx + pad
                        self.draw_rich_line(tx, yy, ln, size, C_BODY)
                        yy += lh
                # 竖线
                self.pdf.line(xx, A4_H - top, xx, A4_H - top - rh, color=C_BORDER, width=0.6)
                xx += w
            self.pdf.line(xx, A4_H - top, xx, A4_H - top - rh, color=C_BORDER, width=0.6)
            self.pdf.line(x0, A4_H - top - rh, xx, A4_H - top - rh, color=C_BORDER, width=0.6)
            self.y = top + rh
        self.y += 6

    def numbered(self, idx, segments, size=10.5, lh=16):
        if isinstance(segments, str):
            segments = [(segments, False)]
        mark = "%d. " % idx
        mw = self.tw(mark, size, True)
        lines = self.wrap_rich(segments, self.CW - mw, size)
        for i, line in enumerate(lines):
            self.ensure(lh)
            if i == 0:
                self.draw_text(self.ML, self.y, mark, size, True, C_HEAD)
            self.draw_rich_line(self.ML + mw, self.y, line, size, C_BODY)
            self.y += lh
        self.y += 3


# ============================ 4. 内容 ============================
r = Report()

r.h1("前端应用资产盘点与治理专项")
r.sub("述职报告 ｜ 数据来源：esign_cd_app.xlsx（app 表 type=3 全量导出）"
      " ｜ 汇报人：________ ｜ 日期：________")

r.box([
    ("本报告汇总本次前端应用资产盘点的完整成果：对 ", False),
    (str(total_apps), True), (" 个前端应用逐条梳理代码仓库归属、运行平台与技术形态，去重得到 ", False),
    (str(total_repos), True), (" 个独立仓库，识别出 ", False),
    (str(shared_repos), True), (" 个被多应用共享的仓库，并完成 ", False),
    (str(infer_cnt), True), (" 条平台标记的推断补全，为后续前端资产治理与仓库收敛提供了数据底座。", False),
], C_LEAD_BG, C_LEAD_BD)

r.h2("一、工作概述")
r.para([("背景：", True),
        ("前端应用长期按业务线分散建设，应用与代码仓库的对应关系不清晰、平台标记口径不统一，"
         "缺少一份可信的资产台账，导致仓库复用率、重复建设等问题无法量化。", False)])
r.para([("目标：", True),
        ("① 建立“应用—仓库—平台”三维资产清单；② 统一平台与技术形态标记口径；"
         "③ 量化重复引用与重复建设，识别可收敛仓库。", False)])
r.para([("方法：", True),
        ("以 SELECT name, code_path FROM app WHERE type = 3 全量拉取 ", False),
        (str(total_apps), True),
        (" 条应用记录，按 code_path 去重统计仓库；对缺失平台标记的记录基于应用命名与仓库特征逐条"
         "人工核对 + 规则推断补全；再按命名空间聚合、按仓库共享度排序，产出分布统计与重复引用明细。", False)])

r.h2("二、核心数据成果")
r.cards([
    (total_apps, "应用总数"),
    (total_repos, "独立代码仓库"),
    (shared_repos, "多应用共享仓库"),
    (multi_repo_rows, "存在重复引用的应用"),
    (total_ns, "涉及命名空间"),
    (infer_cnt, "推断补全的平台标记"),
])

r.h3("2.1 平台分布（人工标记 vs 推断补全后合计）")
max_plat = max(p[2] or 0 for p in platform_rows) or 1
plat_rows = [[name, ("r", str(m)), ("r", str(t)), ("bar", (t or 0) / max_plat)]
             for name, m, t in platform_rows]
r.table(["平台", "原人工标记", "补全后合计", "相对占比"], plat_rows,
        [110, 90, 90, r.CW - 290])
max_platform_total = max(p[2] for p in platform_rows)
r.para("补全前仅 %d 条记录有人工平台标记、%d 条完全缺失；补全后 PC Web 端 %d 个为绝对主体，"
       "同时 H5、双端小程序、PC 客户端等形态均有明确落位，平台口径从“大部分空白”提升为 %d%% 覆盖。"
       % (manual_cnt, none_cnt, max_platform_total,
          (manual_cnt + infer_cnt) * 100 // total_apps), size=10, lh=15)

r.page_break()
r.h2("三、技术形态与命名空间分析")

r.h3("3.1 技术形态分布（按名称规则推断）")
max_tech = max(t[1] for t in tech_rows) or 1
tech_tbl = [[name, ("r", str(cnt)), ("%d%%" % (cnt * 100 // total_apps)),
             ("bar", cnt / max_tech, C_BAR2)] for name, cnt in tech_rows]
r.table(["技术形态", "应用数", "占比", "分布"], tech_tbl,
        [150, 70, 55, r.CW - 275])
pc_web_share = 413 * 100 // total_apps
r.para("PC Web 应用 413 个、占比约 %d%%，是最主要的交付形态；小程序/轻应用 40 个、H5/移动 Web 38 个"
       "构成移动端长尾；另有 37 个 SDK/组件/工具类与 37 个“其他/待确认”应用，"
       "后者是下一步口径治理的遗留项。" % pc_web_share, size=10, lh=15)

r.h3("3.2 命名空间 Top 10（共 %d 个命名空间）" % total_ns)
ns_top = ns_rows[:10]
max_ns = ns_top[0][1] or 1
ns_tbl = [[name, ("r", str(cnt)), ("bar", cnt / max_ns)] for name, cnt in ns_top]
r.table(["命名空间", "应用数", "集中度"], ns_tbl, [300, 80, r.CW - 380])
top4 = sum(n[1] for n in ns_top[:4])
r.para("saas-front、support-micro-frontend、front-common、saas-micro-frontend 四大命名空间合计承载 "
       "%d 个应用，超过总量的四成，说明微前端容器与公共层已形成事实上的集中化，"
       "具备进一步收敛的基础。" % top4, size=10, lh=15)

r.h2("四、重复引用与仓库复用分析")
r.para("%d 个仓库被多个应用共享，涉及 %d 条应用记录。共享度最高的前 12 个明细如下"
       "（完整 58 个见原始数据表）：" % (shared_repos, multi_repo_rows), size=10, lh=15)
dup_tbl = []
for repo, apps in dup_rows[:12]:
    short = repo.replace("git@git.timevale.cn:", "").replace(".git", "")
    dup_tbl.append([short, ("r", str(len(apps))), "、".join(apps)])
r.table(["仓库（去 git 前缀）", "引用数", "引用应用"], dup_tbl,
        [195, 45, r.CW - 240], size=8.5, lh=11.5)

r.page_break()
r.h2("五、发现的问题与风险")
r.box([("1. 仓库一对多、多对一并存，边界混乱。", True),
       ("低代码模板仓库 esa-front 被 12 个应用引用，esign-client、magic-flow-middle、模板类仓库"
        "各被 7 个应用引用；同名应用分叉（preview/stable/normal 变体）大量存在，"
        "分支与仓库职责边界不清，改动影响面难以评估。", False)], C_RISK_BG, C_RISK_BD)
r.box([("2. 平台标记历史上大面积缺失。", True),
       ("盘点前仅 %d 条人工标记、%d 条空白，%d 条（占 %d%%）依赖本次规则推断补全，"
        "推断结果需要业务负责人复核确认，尚存在口径误差风险。"
        % (manual_cnt, none_cnt, infer_cnt, infer_cnt * 100 // total_apps), False)],
      C_RISK_BG, C_RISK_BD)
r.box([("3. 存在无法归类的长尾应用。", True),
       ("37 个“其他/待确认”与 37 个 SDK/组件/工具类应用技术形态不明，"
        "部分疑似已废弃（名称含 disabled、old、feiqi 的变体仓库），缺乏下线/归档机制。", False)],
      C_RISK_BG, C_RISK_BD)
r.box([("4. 复用靠“复制仓库”而非“依赖共享”。", True),
       ("大量应用通过克隆模板仓库再改名的方式创建，公共修复无法同步，"
        "重复建设与维护成本随应用数线性增长。", False)], C_RISK_BG, C_RISK_BD)

r.h2("六、治理举措与下一步计划")
r.box([("本期已完成：", True),
       ("全量应用—仓库映射台账、平台/技术形态双口径统计、命名空间集中度分析、%d 个共享仓库明细，"
        "形成可复用的盘点脚本与数据基线。" % shared_repos, False)], C_OK_BG, C_OK_BD)
r.numbered(1, [("标记复核：", True),
               ("推动各命名空间负责人对 %d 条推断平台标记在两周内完成复核，"
                "将“其他/待确认”37 个应用清零，平台台账转为人工确认口径。" % infer_cnt, False)])
r.numbered(2, [("变体收敛：", True),
               ("对 preview / stable / normal / old 类同源变体仓库制定合并计划，"
                "优先收敛模板类与 usercenter、web-treaty 等高频复制仓库。", False)])
r.numbered(3, [("复用方式升级：", True),
               ("将“克隆模板”改为 npm 包 / 微前端子应用注册的共享机制，"
                "从源头减少 %d 个共享仓库的分叉压力。" % shared_repos, False)])
r.numbered(4, [("常态化盘点：", True),
               ("将本次脚本接入定时任务，按月输出资产变化报告，防止台账腐化。", False)])
r.numbered(5, [("废弃治理：", True),
               ("对长期无提交、无访问的应用发起下线确认，建立归档与注销流程。", False)])

r.h2("七、个人总结")
r.para("本次专项把分散在各业务线、口径不一的 %d 条前端应用记录，梳理成一份可查询、可量化的资产台账："
       "仓库去重、平台补全、形态归类、共享度排名四步闭环，让“我们到底有多少前端应用、跑在什么平台、"
       "复用了多少代码”第一次有了确定答案。过程中通过人工核对与规则推断相结合，在保证效率的同时"
       "把推断项全部标注来源、留出复核接口。下一步将聚焦标记复核与变体仓库收敛，"
       "把盘点成果转化为实际的维护成本下降。" % total_apps, size=10.5, lh=16.5)

r.y += 14
r.para("汇报人：________      部门负责人：________      日期：________", size=10, lh=15)
r.para("数据口径：esign_cd_app.xlsx / Result 1 共 %d 行；统计以“应用行”为基本单位，"
       "仓库按 code_path 精确去重。" % total_apps, size=8.5, lh=13, color=C_LIGHT)

# ============================ 5. 组装输出 ============================
fonts_meta = []

# 收集全部涉及字符，为常规/粗体两个字体分别生成子集
all_chars = set()


def add(s):
    all_chars.update(s)


add(open(__file__, encoding="utf-8").read())
for name, m, t in platform_rows:
    add(name)
for name, cnt in tech_rows + ns_rows:
    add(name)
for repo, apps in dup_rows:
    add(repo)
    add("".join(apps))
for k, v in summary.items():
    add(str(k))
    add(str(v))

for key, ttf in (("F1", r.fonts["reg"]), ("F2", r.fonts["bold"])):
    gids = {ttf.glyph_id(c) for c in all_chars if ttf.glyph_id(c) != 0}
    gids.update(r.gid(c, key == "F2")[1] for c in all_chars)
    gids.discard(0)
    subset = ttf.subset(gids)
    widths = {g: ttf.advance(g) * 1000.0 / ttf.units_per_em for g in gids}
    tounicode = {}
    for c in all_chars:
        g = ttf.glyph_id(c)
        if g and g not in tounicode:
            tounicode[g] = c
    name = ttf.ps_name.replace(" ", "-")
    fonts_meta.append({
        "key": key,
        "base": "%s%s+" % ("AAAAAA" if key == "F1" else "BBBBBB", name),
        "data": subset,
        "widths": widths,
        "tounicode": tounicode,
        "ascent": ttf.ascent * 1000.0 / ttf.units_per_em,
        "descent": ttf.descent * 1000.0 / ttf.units_per_em,
        "bbox": ttf.bbox,
        "upem": ttf.units_per_em,
    })

total_pages = r.page_no
for i, ops in enumerate(r.pdf._pages):
    r.pdf._ops = ops
    label = "— %d / %d —" % (i + 1, total_pages)
    w = r.tw(label, 8.5)
    r.draw_text((A4_W - w) / 2, A4_H - 34, label, 8.5, False, C_LIGHT)

r.pdf.save(OUT, fonts_meta)

print("PDF:", OUT)
print("pages:", total_pages, "| size:", os.path.getsize(OUT), "bytes")
if r.missing:
    print("MISSING GLYPHS:", "".join(sorted(r.missing)))
else:
    print("glyphs: all covered")

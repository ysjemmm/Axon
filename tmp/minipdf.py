# -*- coding: utf-8 -*-
"""极简 PDF 生成库：解析 TrueType 字体 -> 子集内嵌 -> 自绘文本/图形。

零第三方依赖，支持中文字体（DengXian / SimHei / msyh.ttc 等）。
仅实现本项目所需能力：A4 页面、文本绘制、矩形/线条、自动换行由上层负责。
"""
import struct
import zlib

A4_W, A4_H = 595.0, 842.0


def _u16(b, o):
    return struct.unpack_from(">H", b, o)[0]


def _i16(b, o):
    return struct.unpack_from(">h", b, o)[0]


def _u32(b, o):
    return struct.unpack_from(">I", b, o)[0]


def _checksum(data):
    n = len(data)
    pad = (-n) % 4
    if pad:
        data = data + b"\x00" * pad
    s = 0
    for i in range(0, len(data), 4):
        s = (s + struct.unpack_from(">I", data, i)[0]) & 0xFFFFFFFF
    return s


class TTF:
    """TrueType 字体解析（支持 .ttf 与 .ttc 取第一张脸）。"""

    def __init__(self, path, face_index=0):
        d = open(path, "rb").read()
        self.raw = d
        if d[:4] == b"ttcf":
            num = _u32(d, 8)
            if face_index >= num:
                raise ValueError("ttc face index out of range")
            base = _u32(d, 12 + face_index * 4)
        else:
            base = 0
        self.base = base
        num_tables = _u16(d, base + 4)
        self.tables = {}
        for i in range(num_tables):
            o = base + 12 + i * 16
            tag = d[o:o + 4].decode("latin1")
            self.tables[tag] = (_u32(d, o + 4), _u32(d, o + 8), _u32(d, o + 12))

        ho = self.tables["head"][1]
        self.units_per_em = _u16(d, ho + 18)
        self.bbox = struct.unpack_from(">hhhh", d, ho + 36)
        self.loc_fmt = _i16(d, ho + 50)

        self.num_glyphs = _u16(d, self.tables["maxp"][1] + 4)

        hh = self.tables["hhea"][1]
        self.ascent = _i16(d, hh + 4)
        self.descent = _i16(d, hh + 6)
        num_h = _u16(d, hh + 34)
        hm = self.tables["hmtx"][1]
        self._adv = [_u16(d, hm + i * 4) for i in range(num_h)]
        self._num_h = num_h

        lo = self.tables["loca"][1]
        if self.loc_fmt == 0:
            self.loca = [_u16(d, lo + i * 2) * 2 for i in range(self.num_glyphs + 1)]
        else:
            self.loca = [_u32(d, lo + i * 4) for i in range(self.num_glyphs + 1)]
        self._glyf_off = self.tables["glyf"][1]

        self.cmap = self._parse_cmap()
        self.ps_name = self._ps_name()

    # ---------- 查询 ----------
    def glyph_id(self, ch):
        return self.cmap.get(ord(ch), 0)

    def advance(self, gid):
        if gid < self._num_h:
            return self._adv[gid]
        return self._adv[-1] if self._adv else 0

    def width(self, s, size):
        upem = self.units_per_em
        return sum(self.advance(self.glyph_id(c)) for c in s) * size / upem

    def glyph_bytes(self, gid):
        if gid + 1 >= len(self.loca):
            return b""
        d = self.raw
        s = self._glyf_off + self.loca[gid]
        e = self._glyf_off + self.loca[gid + 1]
        return d[s:e]

    def _composite_refs(self, data):
        """复合字形引用的组件 gid 列表。"""
        if len(data) < 10 or _i16(data, 0) >= 0:
            return []
        refs = []
        off = 10
        while True:
            if off + 4 > len(data):
                break
            flags = _u16(data, off)
            gid = _u16(data, off + 2)
            refs.append(gid)
            off += 4
            off += 4 if flags & 0x0001 else 2
            if flags & 0x0008:
                off += 2
            elif flags & 0x0040:
                off += 4
            elif flags & 0x0080:
                off += 8
            if not (flags & 0x0020):
                break
        return refs

    def _parse_cmap(self):
        d = self.raw
        co = self.tables["cmap"][1]
        n = _u16(d, co + 2)
        best = None
        for i in range(n):
            o = co + 4 + i * 8
            plat = _u16(d, o)
            enc = _u16(d, o + 2)
            off = _u32(d, o + 4)
            score = {(3, 10): 4, (0, 4): 3, (3, 1): 2, (0, 3): 2, (0, 1): 1}.get((plat, enc), 0)
            if best is None or score > best[0]:
                best = (score, co + off)
        mapping = {}
        if best is None:
            return mapping
        sub = best[1]
        fmt = _u16(d, sub)
        if fmt == 4:
            seg_x2 = _u16(d, sub + 6)
            seg = seg_x2 // 2
            ends = sub + 14
            starts = ends + seg_x2 + 2
            deltas = starts + seg_x2
            ranges = deltas + seg_x2
            for i in range(seg):
                end = _u16(d, ends + i * 2)
                start = _u16(d, starts + i * 2)
                delta = _i16(d, deltas + i * 2)
                ro = _u16(d, ranges + i * 2)
                if start > end:
                    continue
                for c in range(start, end + 1):
                    if c == 0xFFFF:
                        continue
                    if ro == 0:
                        gid = (c + delta) & 0xFFFF
                    else:
                        addr = ranges + i * 2 + ro + (c - start) * 2
                        if addr + 2 > len(d):
                            continue
                        gid = _u16(d, addr)
                        if gid:
                            gid = (gid + delta) & 0xFFFF
                    if gid:
                        mapping[c] = gid
        elif fmt == 12:
            groups = _u32(d, sub + 12)
            for i in range(groups):
                o = sub + 16 + i * 12
                sc, ec, sg = _u32(d, o), _u32(d, o + 4), _u32(d, o + 8)
                for c in range(sc, ec + 1):
                    mapping[c] = sg + (c - sc)
        elif fmt == 6:
            first = _u16(d, sub + 6)
            cnt = _u16(d, sub + 8)
            for i in range(cnt):
                mapping[first + i] = _u16(d, sub + 10 + i * 2)
        return mapping

    def _ps_name(self):
        if "name" not in self.tables:
            return "EmbeddedFont"
        d = self.raw
        no, nl = self.tables["name"][1], self.tables["name"][2]
        count = _u16(d, no + 2)
        storage = no + _u16(d, no + 4)
        for i in range(count):
            o = no + 6 + i * 12
            pid, eid, lid, nid, length, off = struct.unpack_from(">HHHHHH", d, o)
            if nid == 6:
                raw = d[storage + off:storage + off + length]
                try:
                    s = raw.decode("utf-16-be") if pid == 3 or pid == 0 else raw.decode("latin1")
                    s = "".join(ch for ch in s if ch.isalnum() or ch in "+-_.")
                    if s:
                        return s[:30]
                except Exception:
                    pass
        return "EmbeddedFont"

    # ---------- 子集 ----------
    def subset(self, needed_gids):
        used = set(g for g in needed_gids if 0 < g < self.num_glyphs)
        used.add(1) if self.num_glyphs > 1 else None
        stack = list(used)
        while stack:
            g = stack.pop()
            refs = self._composite_refs(self.glyph_bytes(g))
            for r in refs:
                if 0 < r < self.num_glyphs and r not in used:
                    used.add(r)
                    stack.append(r)

        # glyf / loca 重建（保持原 gid，未用字形置空）
        new_glyf = bytearray()
        new_loca = []
        for gid in range(self.num_glyphs):
            new_loca.append(len(new_glyf))
            if gid in used:
                data = self.glyph_bytes(gid)
                if data:
                    new_glyf += data
                    pad = (-len(new_glyf)) % 4
                    if pad:
                        new_glyf += b"\x00" * pad
        new_loca.append(len(new_glyf))
        loca_bytes = b"".join(struct.pack(">I", x) for x in new_loca)

        d = self.raw
        out_tables = {}
        for tag, (_cs, off, length) in self.tables.items():
            if tag in ("glyf", "loca", "head", "post"):
                continue
            out_tables[tag] = d[off:off + length]

        head = bytearray(d[self.tables["head"][1]:self.tables["head"][1] + self.tables["head"][2]])
        struct.pack_into(">I", head, 8, 0)              # checkSumAdjustment = 0
        struct.pack_into(">h", head, 50, 1)             # indexToLocFormat = long
        out_tables["head"] = bytes(head)
        out_tables["loca"] = loca_bytes
        out_tables["glyf"] = bytes(new_glyf)

        if "post" in self.tables:
            po, pl = self.tables["post"][1], self.tables["post"][2]
            post = bytearray(d[po:po + min(pl, 32)])
            if len(post) < 32:
                post += b"\x00" * (32 - len(post))
            struct.pack_into(">I", post, 0, 0x00030000)  # format 3.0（无字形名）
            out_tables["post"] = bytes(post)
        else:
            out_tables["post"] = struct.pack(">IiiIIIII", 0x00030000, 0, -120, 50, 0, 0, 0, 0, 0)

        tags = sorted(out_tables.keys())
        n = len(tags)
        import math
        sr = 2 ** int(math.log2(n)) * 16
        es = int(math.log2(n))
        rs = n * 16 - sr
        header = struct.pack(">IHHHH", 0x00010000, n, sr, es, rs)

        records = b""
        body = b""
        offsets = {}
        cur = 12 + n * 16
        for tag in tags:
            data = out_tables[tag]
            pad = (-len(data)) % 4
            offsets[tag] = cur
            records += struct.pack(">4sIII", tag.encode("latin1"), _checksum(data), cur, len(data))
            body += data + b"\x00" * pad
            cur += len(data) + pad

        font = bytearray(header + records + body)
        # 全文件校验和写回 head.checkSumAdjustment
        adj_off = offsets["head"] + 8
        total = _checksum(bytes(font))
        adj = (0xB1B0AFBA - total) & 0xFFFFFFFF
        struct.pack_into(">I", font, adj_off, adj)
        return bytes(font)


class MiniPDF:
    """页面绘制与文件组装。"""

    def __init__(self, width=A4_W, height=A4_H):
        self.w = width
        self.h = height
        self._pages = []
        self._ops = None

    def new_page(self):
        self._ops = []
        self._pages.append(self._ops)

    @property
    def ops(self):
        if self._ops is None:
            self.new_page()
        return self._ops

    # ---------- 原语 ----------
    def raw(self, s):
        self.ops.append(s)

    def rect(self, x, y, w, h, fill=None, stroke=None, line_width=0.8):
        """坐标为 PDF 原生坐标（原点左下）。"""
        parts = []
        if fill:
            parts.append("%.3f %.3f %.3f rg" % fill)
        if stroke:
            parts.append("%.3f %.3f %.3f RG %.2f w" % (stroke + (line_width,)))
        op = "f" if fill and not stroke else ("B" if fill and stroke else "S")
        parts.append("%.2f %.2f %.2f %.2f re %s" % (x, y, w, h, op))
        self.ops.append(" ".join(parts))

    def line(self, x1, y1, x2, y2, color=(0, 0, 0), width=0.8):
        self.ops.append(
            "%.3f %.3f %.3f RG %.2f w %.2f %.2f m %.2f %.2f l S"
            % (color + (width, x1, y1, x2, y2))
        )

    def text(self, x, y_baseline, size, s, font_key, color=(0, 0, 0), tfs=1.0):
        hexs = s.encode("utf-16-be").hex().upper()
        # 说明：此处字符串按 gid 编码，由上层调用前已转换，见 _gid_text
        self.ops.append(
            "BT /%s %.2f Tf %.3f %.3f %.3f rg 1 0 0 1 %.2f %.2f Tm <%s> Tj ET"
            % (font_key, size, color[0], color[1], color[2], x, y_baseline, hexs)
        )

    def gid_text(self, x, y_baseline, size, gid_hex, font_key, color=(0, 0, 0)):
        self.ops.append(
            "BT /%s %.2f Tf %.3f %.3f %.3f rg 1 0 0 1 %.2f %.2f Tm <%s> Tj ET"
            % (font_key, size, color[0], color[1], color[2], x, y_baseline, gid_hex)
        )

    # ---------- 输出 ----------
    def save(self, path, fonts):
        """fonts: [{'key','base','data','widths':{gid:pdfw},'tounicode':{gid:ch},
                    'ascent','descent','bbox','upem'}]"""
        objs = {}

        def put(data):
            oid = len(objs) + 1
            objs[oid] = data
            return oid

        # 字体对象
        font_res = {}
        for f in fonts:
            ff = put(b"<< /Length %d /Length1 %d /Filter /FlateDecode >>\nstream\n%s\nendstream"
                     % (0, 0, b""))  # 占位，稍后替换
            font_data = zlib.compress(f["data"])
            objs[ff] = b"<< /Length %d /Length1 %d /Filter /FlateDecode >>\nstream\n%s\nendstream" % (
                len(font_data), len(f["data"]), font_data)

            tu = f["tounicode"]
            chunks = list(tu.items())
            lines = ["/CIDInit /ProcSet findresource begin", "12 dict begin", "begincmap",
                     "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def",
                     "/CMapName /Adobe-Identity-UCS def", "/CMapType 2 def",
                     "1 begincodespacerange", "<0000> <FFFF>", "endcodespacerange"]
            for i in range(0, len(chunks), 100):
                part = chunks[i:i + 100]
                lines.append("%d beginbfchar" % len(part))
                for gid, ch in part:
                    lines.append("<%04X> <%s>" % (gid, ch.encode("utf-16-be").hex().upper()))
                lines.append("endbfchar")
            lines += ["endcmap", "CMapName currentdict /CMap defineresource pop", "end", "end"]
            tu_data = "\n".join(lines).encode("latin1")
            tu_comp = zlib.compress(tu_data)
            tu_obj = put(b"<< /Length %d /Filter /FlateDecode >>\nstream\n%s\nendstream"
                         % (len(tu_comp), tu_comp))

            w_parts = []
            for gid in sorted(f["widths"]):
                w_parts.append("%d [%.2f]" % (gid, f["widths"][gid]))
            w_str = " ".join(w_parts)

            base = f["base"]
            bbox = [max(-1000, min(3000, v * 1000.0 // f["upem"])) for v in f["bbox"]]
            fd = put((
                "<< /Type /FontDescriptor /FontName /%s /Flags 4 "
                "/FontBBox [%s] /ItalicAngle 0 /Ascent %d /Descent %d "
                "/CapHeight %d /StemV 80 /FontFile2 %d 0 R >>"
                % (base, " ".join(str(int(v)) for v in bbox),
                   int(f["ascent"]), int(f["descent"]), int(f["ascent"]), ff)
            ).encode("latin1"))

            cidf = put((
                "<< /Type /Font /Subtype /CIDFontType2 /BaseFont /%s "
                "/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> "
                "/FontDescriptor %d 0 R /DW 1000 /W [ %s ] /CIDToGIDMap /Identity >>"
                % (base, fd, w_str)
            ).encode("latin1"))

            t0 = put((
                "<< /Type /Font /Subtype /Type0 /BaseFont /%s /Encoding /Identity-H "
                "/DescendantFonts [%d 0 R] /ToUnicode %d 0 R >>"
                % (base, cidf, tu_obj)
            ).encode("latin1"))
            font_res[f["key"]] = t0

        page_ids = []
        kids = []
        # 占位对象：Pages（编号必须先确定）——用两遍法：先算对象号
        # 简化：直接按顺序构造，Pages 放在最后回填
        # 这里先创建页面对象（其 Resources 引用字体，Contents 稍后）
        content_ids = []
        for ops in self._pages:
            stream = "\n".join(ops).encode("latin1")
            comp = zlib.compress(stream)
            cid = put(b"<< /Length %d /Filter /FlateDecode >>\nstream\n%s\nendstream"
                      % (len(comp), comp))
            content_ids.append(cid)

        font_res_str = " ".join("/%s %d 0 R" % (k, v) for k, v in font_res.items())
        for cid in content_ids:
            pid = put(("<< /Type /Page /Parent @@PAGES@@ /MediaBox [0 0 %.0f %.0f] "
                       "/Resources << /Font << %s >> >> /Contents %d 0 R >>"
                       % (self.w, self.h, font_res_str, cid)).encode("latin1"))
            page_ids.append(pid)

        pages_oid = len(objs) + 1
        kids_str = " ".join("%d 0 R" % p for p in page_ids)
        objs[pages_oid] = b"<< /Type /Pages /Count %d /Kids [%s] >>" % (
            len(page_ids), kids_str.encode("latin1"))
        # 回填子页面的 /Parent
        for p in page_ids:
            objs[p] = objs[p].replace(b"@@PAGES@@", b"%d 0 R" % pages_oid)

        cat_oid = len(objs) + 1
        objs[cat_oid] = b"<< /Type /Catalog /Pages %d 0 R >>" % pages_oid

        out = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
        offsets = {}
        for oid in sorted(objs):
            offsets[oid] = len(out)
            out += b"%d 0 obj\n" % oid
            out += objs[oid]
            out += b"\nendobj\n"

        xref_pos = len(out)
        nobj = len(objs) + 1
        out += b"xref\n0 %d\n" % nobj
        out += b"0000000000 65535 f \n"
        for oid in range(1, nobj):
            out += b"%010d 00000 n \n" % offsets[oid]
        out += b"trailer\n<< /Size %d /Root %d 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (
            nobj, cat_oid, xref_pos)

        with open(path, "wb") as fh:
            fh.write(bytes(out))

#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""临床数据脱敏：检测并替换中国医疗数据里最常见的可识别信息(PII/PHI)。

覆盖：身份证号(18/15位,含校验)、手机号、住院号/病案号/门诊号、银行卡、Email、
座机、车牌、（可选）姓名列、具体日期。可对 CSV/Excel 的指定列、或任意文本做脱敏。

设计原则：
  - 宁可多报（把疑似 PII 标出来让人确认），也不要漏掉真 PII。
  - **一致性假名化**：同一个原值在整份数据里替换成同一个假名（P0001、P0002…），
    保留可分析性（能按患者聚合），又不泄露真实身份。映射表单独存，供必要时人工回溯。
  - **默认不把映射表混进脱敏输出**；映射另存 mapping.csv，提醒用户单独妥善保管/或销毁。

用法：
  # 文本/Markdown 文件
  python deidentify.py --input notes.txt --out outputs/notes_deid.txt

  # CSV：脱敏全表（自动扫每个单元格），姓名列显式指定按列假名化
  python deidentify.py --input patients.csv --out outputs/patients_deid.csv \
      --name-cols 姓名,患者姓名 --id-cols 住院号,身份证号

  # 只扫描报告有哪些 PII、不改数据（先看看）
  python deidentify.py --input patients.csv --scan-only
"""
import argparse
import csv
import os
import re
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


# ---- 检测规则（按精确度从高到低）----

def _id_card_ok(s):
    """18 位身份证校验位核验，降低误报（把随便一串 18 位数字当身份证）。
    15 位老身份证无校验位，只能按长度判定（误报率较高，报告里会提示）。"""
    if len(s) != 18:
        return len(s) == 15 and s.isdigit()
    if not re.match(r"^\d{17}[\dXx]$", s):
        return False
    w = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2]
    check = "10X98765432"
    total = sum(int(s[i]) * w[i] for i in range(17))
    return check[total % 11] == s[17].upper()


def _luhn_ok(s):
    """Luhn 校验：真实银行卡号满足，随机 16-19 位数字串基本不满足——
    大幅降低把科研长数字（样本编号/坐标/流水号）误当银行卡的假阳性。"""
    digits = [int(c) for c in s if c.isdigit()]
    if not 16 <= len(digits) <= 19:
        return False
    total, parity = 0, len(digits) % 2
    for i, d in enumerate(digits):
        if i % 2 == parity:
            d *= 2
            if d > 9:
                d -= 9
        total += d
    return total % 10 == 0


PATTERNS = [
    # (类别, 正则, 可选校验函数, 假名前缀)
    # 身份证在银行卡之前——18 位身份证也像银行卡，先按身份证识别、校验位核验。
    ("身份证", re.compile(r"(?<![0-9])(\d{17}[\dXx]|\d{15})(?![0-9])"), _id_card_ok, "ID"),
    # 手机号：容忍 +86/86 前缀与 -/空格 分隔（138-1234-5678、+8613812345678 都能抓）。
    ("手机号", re.compile(r"(?<![0-9])(?:\+?86[\-\s]?)?1[3-9]\d(?:[\-\s]?\d){8}(?![0-9])"), None, "MOB"),
    ("Email", re.compile(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}"), None, "MAIL"),
    # 银行卡：Luhn 校验，避免误伤任意 16-19 位数字。
    ("银行卡", re.compile(r"(?<![0-9])\d{16,19}(?![0-9])"), _luhn_ok, "CARD"),
    ("座机", re.compile(r"(?<![0-9])0\d{2,3}-?\d{7,8}(?![0-9])"), None, "TEL"),
    ("车牌", re.compile(r"[京津沪渝冀豫云辽黑湘皖鲁苏浙赣鄂桂甘晋蒙陕吉闽贵粤青藏川宁琼新]\s?[A-Z]\s?[A-Z0-9]{5,6}"), None, "PLATE"),
    # 住院号/病案号等：标签+号码；标签与号码间容忍"为/是/：/空格"等连接词。
    ("病案标识", re.compile(r"(住院号|病案号|病历号|档案号|门诊号|就诊卡号|登记号|标本号|床号)\s*(?:为|是|:|：|=|\s)?\s*([A-Za-z0-9\-]{2,})"), None, "MRN"),
    # 具体日期（默认不脱，用 --dates 开启）
    ("日期", re.compile(r"(?<![0-9])(19|20)\d{2}[-/年.](0?[1-9]|1[0-2])[-/月.](0?[1-9]|[12]\d|3[01])日?(?![0-9])"), None, "DATE"),
]


_PREFIX = {cat: prefix for cat, _pat, _v, prefix in PATTERNS}
_PREFIX["姓名"] = "P"


def make_masker():
    """返回 (mask 函数, 映射表)。同一原值→同一假名，跨整份数据一致。
    每个类别用不同前缀（手机 MOB / 座机 TEL …），避免不同 PII 撞同名。"""
    counters, mapping = {}, {}

    def mask(category, value):
        key = (category, value)
        if key not in mapping:
            counters[category] = counters.get(category, 0) + 1
            prefix = _PREFIX.get(category, "X")
            mapping[key] = f"[{prefix}{counters[category]:04d}]"
        return mapping[key]

    return mask, mapping


def deidentify_text(text, mask, do_dates=False):
    hits = []
    for category, pat, validator, _prefix in PATTERNS:
        if category == "日期" and not do_dates:
            continue

        def _sub(m, category=category, validator=validator):
            # 病案标识：保留标签，替换其后的号码
            if category == "病案标识":
                label, num = m.group(1), m.group(2)
                hits.append((category, num))
                return f"{label}{mask(category, num)}"
            val = m.group(0)
            if validator and not validator(val):
                return val  # 校验不过，不当 PII
            hits.append((category, val))
            return mask(category, val)

        text = pat.sub(_sub, text)
    return text, hits


def _read_text(path):
    """按 utf-8-sig → gbk → gb18030 尝试；都失败才报错。绝不用 errors='replace'
    静默吞掉——国内 HIS 常导出 GBK，静默乱码会让用户拿到看似脱敏实则损坏的文件。"""
    for enc in ("utf-8-sig", "gbk", "gb18030"):
        try:
            with open(path, encoding=enc) as f:
                return f.read(), enc
        except UnicodeDecodeError:
            continue
    sys.exit(f"无法解码文件（试过 utf-8/gbk/gb18030）：{path}。请确认是纯文本/CSV，或先转成 UTF-8。")


BINARY_EXTS = {".xlsx", ".xls", ".doc", ".docx", ".pdf", ".zip", ".rtf"}


def _guard_binary(path):
    ext = os.path.splitext(path)[1].lower()
    if ext in BINARY_EXTS:
        sys.exit(f"不支持二进制格式 {ext}：请先用 data-analysis 技能/Excel 把它另存为 CSV 再脱敏。"
                 "（直接处理二进制会静默产出乱码、看似脱敏实则未处理，已阻止。）")


def _warn_suspicious_columns(header, name_cols, id_cols):
    """表头里像标识列（含 号/编号/卡号/ID/No 等）但没被 --id-cols/--name-cols 指定的，
    警告用户：这些列不会按列强制脱敏，可能有 PII 漏出。"""
    kw = re.compile(r"(号|编号|卡号|ID|Id|No\.?|姓名|名字|name)", re.I)
    covered = name_cols | id_cols
    sus = [h for h in header if h.strip() and h.strip() not in covered and kw.search(h)]
    if sus:
        print("⚠️ 疑似标识列未被显式指定（不会按列强制脱敏，仅靠正则扫描，可能漏）："
              + "、".join(sus))
        print("   如含 PII，请用 --id-cols / --name-cols 指定这些列名。")


def process_csv(path, out, mask, name_cols, id_cols, do_dates, scan_only):
    _, enc = _read_text(path)  # 只为探测编码；下面用同一编码读
    with open(path, newline="", encoding=enc) as f:
        rows = list(csv.reader(f))
    if not rows:
        return [], 0
    header = rows[0]
    _warn_suspicious_columns(header, name_cols, id_cols)
    name_idx = {i for i, h in enumerate(header) if h.strip() in name_cols}
    id_idx = {i for i, h in enumerate(header) if h.strip() in id_cols}
    all_hits = []
    for r in rows[1:]:
        for i, cell in enumerate(r):
            if i in name_idx and cell.strip():
                all_hits.append(("姓名", cell))
                if not scan_only:
                    r[i] = mask("姓名", cell.strip())
                continue
            if i in id_idx and cell.strip():
                all_hits.append(("病案标识", cell))
                if not scan_only:
                    r[i] = mask("病案标识", cell.strip())
                continue
            new, hits = deidentify_text(cell, mask, do_dates)
            all_hits.extend(hits)
            if not scan_only:
                r[i] = new
    if not scan_only:
        os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
        with open(out, "w", newline="", encoding="utf-8-sig") as f:
            csv.writer(f).writerows(rows)
    return all_hits, len(rows) - 1


def main():
    ap = argparse.ArgumentParser(description="临床数据脱敏（中国 PII/PHI）")
    ap.add_argument("--input", required=True)
    ap.add_argument("--out", default="outputs/deidentified_output")
    ap.add_argument("--name-cols", default="", help="CSV 里的姓名列名，逗号分隔")
    ap.add_argument("--id-cols", default="", help="CSV 里的标识号列名（住院号等），逗号分隔")
    ap.add_argument("--dates", action="store_true", help="同时脱敏具体日期（默认不脱）")
    ap.add_argument("--scan-only", action="store_true", help="只报告 PII、不改数据")
    args = ap.parse_args()

    _guard_binary(args.input)  # 拒绝 .xlsx/.doc 等二进制，避免静默乱码
    name_cols = {x.strip() for x in args.name_cols.split(",") if x.strip()}
    id_cols = {x.strip() for x in args.id_cols.split(",") if x.strip()}
    mask, mapping = make_masker()
    ext = os.path.splitext(args.input)[1].lower()

    if ext == ".csv":
        hits, n = process_csv(args.input, args.out, mask, name_cols, id_cols, args.dates, args.scan_only)
        scope = f"CSV {n} 行"
    else:
        text, _enc = _read_text(args.input)
        new, hits = deidentify_text(text, mask, args.dates)
        scope = "文本"
        if not args.scan_only:
            os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
            open(args.out, "w", encoding="utf-8").write(new)

    from collections import Counter
    dist = Counter(c for c, _ in hits)
    print(f"扫描范围：{scope}")
    print("检出 PII：" + ("，".join(f"{k} {v}" for k, v in dist.items()) if dist else "无") )
    if args.scan_only:
        print("（--scan-only：仅扫描，未改数据）")
        print("⚠️ 姓名等中文命名实体正则难以穷尽，务必人工复核！")
        return

    # 映射表另存，提醒单独保管
    if mapping:
        map_path = os.path.splitext(args.out)[0] + "_mapping.csv"
        with open(map_path, "w", newline="", encoding="utf-8-sig") as f:
            w = csv.writer(f)
            w.writerow(["类别", "原值", "假名"])
            for (cat, val), pseudo in mapping.items():
                w.writerow([cat, val, pseudo])
        print(f"脱敏输出：{args.out}")
        print(f"⚠️ 映射表：{map_path} —— 含原始 PII，请单独妥善保管或用后销毁，切勿随数据一起外发。")
    print("⚠️ 本工具是辅助：中文姓名/自由文本里的隐性标识难以穷尽，脱敏后务必人工复核再对外共享。")


if __name__ == "__main__":
    main()

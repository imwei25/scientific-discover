#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""就地改写的校验闸：证明"只改了字，没碰别的"，并核对数字与引用没被动过。

四道闸：
  A. zip 层    条目集合一致；没被改的部件【逐字节相同】（图片、样式、主题、字体表…）
  B. 结构层    表/行/单元格/合并格/图/域/公式/分节/段落数一一相等
  C. 文本层    修订模式下"拒绝全部修订"应当**还原成原文**——这是"没有静默丢字"的机械证明
  D. 不变量    数字、引用标记、DOI/PMID、（可选）术语在改写前后一致（复用 check_invariants 的正则）

用法：
  python docx_verify.py 原稿.docx 改后.docx
  python docx_verify.py 原稿.docx 改后.docx --terms "HFpEF,SGLT2i,eGFR"

退出码：有硬伤=1，全过=0。
"""
import argparse
import sys
import zipfile
from collections import Counter

import check_invariants as CI
import docx_ooxml as X

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

# 结构指纹：这些标签的数量一旦变了，就说明改写动到了文档结构而不只是文字。
STRUCT_TAGS = [("tbl", "表"), ("tr", "表格行"), ("tc", "单元格"),
               ("vMerge", "纵向合并格"), ("gridSpan", "横向合并格"),
               ("drawing", "图"), ("instrText", "域代码"), ("fldChar", "域标记"),
               ("sectPr", "分节"), ("p", "段落"), ("footnoteReference", "脚注引用"),
               ("hyperlink", "超链接"), ("bookmarkStart", "书签")]


def text_view(root, mode):
    """accepted=接受全部修订后的文字；rejected=拒绝全部修订（即还原成原文）。"""
    out = []
    for el in root.iter():
        if el.tag == X.W + "t":
            in_ins = any(a.tag == X.W + "ins" for a in el.iterancestors())
            if mode == "accepted" or not in_ins:
                out.append(el.text or "")
        elif el.tag == X.W + "delText" and mode == "rejected":
            out.append(el.text or "")
    return "".join(out)


def all_text(path, mode):
    return "".join(text_view(X.load(path, part), mode) for part in X.parts_of(path))


def struct(path):
    c = Counter()
    for part in X.parts_of(path):
        root = X.load(path, part)
        for tag, _ in STRUCT_TAGS:
            c[tag] += len(root.findall(".//" + X.W + tag))
    return c


def main():
    ap = argparse.ArgumentParser(description="docx 就地改写校验")
    ap.add_argument("before"); ap.add_argument("after")
    ap.add_argument("--terms", default="", help="逗号分隔的术语白名单，逐个计数比对")
    ap.add_argument("--auto-terms", action="store_true",
                    help="自动把基因名/化学式(TP53/SGLT2/IL-6)纳入比对")
    args = ap.parse_args()
    fail, warn = [], []

    za, zb = zipfile.ZipFile(args.before), zipfile.ZipFile(args.after)
    na, nb = set(za.namelist()), set(zb.namelist())
    print("== A. zip 层 ==")
    if na != nb:
        fail.append(f"条目集合不同：多了 {sorted(nb - na)[:3]}，少了 {sorted(na - nb)[:3]}")
    same, diff = [], []
    for n in sorted(na & nb):
        (same if za.read(n) == zb.read(n) else diff).append(n)
    print(f"  条目 {len(na)} 个：逐字节相同 {len(same)} 个，被改动 {len(diff)} 个"
          f"（{', '.join(d.replace('word/', '') for d in diff) or '无'}）")
    for n in diff:
        if not X.PART_RE.match(n):
            fail.append(f"不该被改的条目被改了：{n}")

    print("== B. 结构层 ==")
    sa, sb = struct(args.before), struct(args.after)
    for tag, name in STRUCT_TAGS:
        mark = "" if sa[tag] == sb[tag] else "  ✗"
        if sa[tag] or sb[tag]:
            print(f"  {name}：{sa[tag]} → {sb[tag]}{mark}")
        if sa[tag] != sb[tag]:
            fail.append(f"{name}数量变了 {sa[tag]}→{sb[tag]}")
    try:
        import docx
        docx.Document(args.after)
        print("  python-docx 打开产物：成功")
    except Exception as e:
        fail.append(f"python-docx 打不开产物：{e}")

    print("== C. 文本层 ==")
    orig = all_text(args.before, "accepted")
    rejected = all_text(args.after, "rejected")
    accepted = all_text(args.after, "accepted")
    tracked = rejected != accepted
    print(f"  产物是否带修订标记：{'是' if tracked else '否（直接覆盖）'}")
    if tracked:
        if rejected == orig:
            print("  拒绝全部修订 → 与原文逐字相同 ✔（没有任何改动绕过修订标记）")
        else:
            fail.append("拒绝全部修订后与原文不一致——有文字被改却没有留下修订标记，"
                        "用户在 Word 里看不见它，也没法拒绝")
    print(f"  原文 {len(orig)} 字 → 改后 {len(accepted)} 字"
          f"（{(len(accepted) - len(orig)) / max(len(orig), 1) * 100:+.1f}%）")
    if abs(len(accepted) - len(orig)) > 0.15 * max(len(orig), 1):
        warn.append("篇幅变动超过 ±15%，润色不该改这么多，请核对是否有整段被删或被扩写")

    print("== D. 不变量 ==")
    eb, ea = {}, {}
    for name, rx in (("数字", CI.NUM_RE), ("DOI", CI.DOI_RE)):
        eb[name] = Counter(m.group(0).strip() for m in rx.finditer(orig))
        ea[name] = Counter(m.group(0).strip() for m in rx.finditer(accepted))
    for name, rx in (("引用[n]", CI.BRACKET_CITE_RE), ("PMID", CI.PMID_RE)):
        eb[name] = Counter(rx.findall(orig)); ea[name] = Counter(rx.findall(accepted))
    eb["引用(作者,年)"] = Counter(CI.PAREN_CITE_RE.findall(orig) + CI.CJK_CITE_RE.findall(orig))
    ea["引用(作者,年)"] = Counter(CI.PAREN_CITE_RE.findall(accepted) + CI.CJK_CITE_RE.findall(accepted))
    terms = {t.strip() for t in args.terms.split(",") if t.strip()}
    if args.auto_terms:
        terms |= set(CI.AUTOTERM_RE.findall(orig)) | set(CI.AUTOTERM_RE.findall(accepted))
    if terms:
        eb["术语"] = Counter({t: orig.count(t) for t in terms})
        ea["术语"] = Counter({t: accepted.count(t) for t in terms})

    dirty = 0
    for kind in eb:
        lost, added = eb[kind] - ea[kind], ea[kind] - eb[kind]
        if not lost and not added:
            continue
        dirty += 1
        print(f"  [!] {kind} 有变化：")
        for k, n in list(lost.items())[:8]:
            print(f"      - 丢失 {k!r} ×{n}")
        for k, n in list(added.items())[:8]:
            print(f"      + 新增 {k!r} ×{n}")
        if kind in ("数字", "DOI", "PMID", "引用[n]", "引用(作者,年)"):
            fail.append(f"{kind}在改写前后不一致——润色不许动数据与引用")
    if not dirty:
        print("  数字、引用标记、DOI/PMID" + ("、术语" if terms else "") + " 前后一致 ✔")

    print("-" * 56)
    for w in warn:
        print(f"[WARN] {w}")
    if fail:
        for f in fail:
            print(f"[FAIL] {f}")
        print("\n这些是硬伤：修好再交付，别拿这份文件出件。")
        sys.exit(1)
    print("[OK] 结构、格式载体、数字与引用均未被改动；改的只有文字本身。")


if __name__ == "__main__":
    main()

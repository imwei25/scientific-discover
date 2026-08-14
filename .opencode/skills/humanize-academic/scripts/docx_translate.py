#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把整篇译文【就地】写回原 docx —— 保住排版载体，不重新生成文件。

和 docx_apply.py（润色）共用一套底座，但**写回策略必须不同**，这是实测出来的：

  润色能保住段内格式，靠的是"没改到的字符留在原 run 里"。翻译每个字都变，这个前提没了。
  实测中译英：原文与译文没有公共子串 → 字符级 diff 退化成一个 replace →
  整段译文被塞进【最后一个 run】，继承它的格式。而实测样例那段 324 字 / 22 run /
  3 种可见格式里，末尾 run 的格式**恰恰不是主导格式**。若原文与译文有偶然公共字符
  （数字、SGLT2、括号、%），译文还会被切成几截塞进不同格式的 run —— 用户看到的是
  "半句话莫名其妙换了字号或颜色"。

所以翻译走【主导格式整段落笔】：取该片里占字数最多的那个 rPr 作为承载格式，
整段译文写进它，其余可改 run 清空删除。段落级的一切（样式、缩进、对齐、编号、
项目符号、表格所在单元格）分毫不动，段内的局部格式（个别词加粗/斜体）会被统一——
这一条无法回避：译文里那个词落在哪儿，机器不知道。脚本会**逐段报出**哪些段落被统一了。

另外两件翻译特有、润色完全没有的事（不做的话产物一看就是机翻）：
  * `w:lang` 不改 → Word 拿中文词典查英文，全篇红波浪线；
  * `rFonts@ascii` 不改 → 英文用宋体/SimSun 渲染。实测两份真稿：t1 有 429 个 run
    的 ascii 是宋体，t2 有 119 个是 SimSun。
故本脚本默认在承载 run 上落 --set-lang 与 --latin-font。

用法：
  python docx_translate.py 原稿.docx 译文.md -o 原稿_en.docx \
      --set-lang en-US --latin-font "Times New Roman"

译文清单格式与 docx_extract.py 的产出一致：每行 `[[p0007]] 译文`。
`⟦…⟧` 里是域/公式/图内文字（引文、交叉引用、页码），**原样保留、不翻译**——
它们由 Word 按域代码重算，翻了也会被 F9 刷回去。

退出码：0 成功；2 输入有问题；3 有段落被拒绝（译文没有全部落地）。
"""
import argparse
import sys
from collections import Counter
from pathlib import Path

from lxml import etree

import docx_ooxml as X
from docx_apply import read_edits

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


def ensure_rPr(run):
    rPr = run.find(X.W + "rPr")
    if rPr is None:
        rPr = etree.SubElement(run, X.W + "rPr")
        run.remove(rPr)
        run.insert(0, rPr)          # rPr 必须是 run 的第一个子元素，顺序是 schema 强制的
    return rPr


def set_child(rPr, tag, attrs):
    """在 rPr 上落一个带属性的子元素（已有就改属性，不重复插）。"""
    el = rPr.find(X.W + tag)
    if el is None:
        el = etree.SubElement(rPr, X.W + tag)
    for k, v in attrs.items():
        if v is not None:
            el.set(X.W + k, v)
    return el


def restyle(run, opt, stats):
    """给承载译文的 run 落语言属性与字体。"""
    if not (opt.set_lang or opt.latin_font or opt.cjk_font):
        return
    rPr = ensure_rPr(run)
    if opt.set_lang:
        # 目标是中文时要落 eastAsia，否则 Word 仍按西文规则断行与查词
        if opt.set_lang.lower().startswith("zh"):
            set_child(rPr, "lang", {"eastAsia": opt.set_lang})
        else:
            set_child(rPr, "lang", {"val": opt.set_lang})
        stats["lang_runs"] += 1
    if opt.latin_font or opt.cjk_font:
        set_child(rPr, "rFonts", {
            "ascii": opt.latin_font, "hAnsi": opt.latin_font,
            "eastAsia": opt.cjk_font})
        stats["font_runs"] += 1


def write_segment(runs, text, opt, stats, pid):
    """把整段译文写进这一片里【主导格式】的那个 run，其余 run 清掉。"""
    weight = Counter()
    for r in runs:
        weight[X.visible_fmt(r)] += len(X.run_text(r))
    if not weight:
        return
    dominant = weight.most_common(1)[0][0]
    if len(weight) > 1:
        stats["fmt_unified"].append((pid, len(weight)))

    carrier = next((r for r in runs if X.visible_fmt(r) == dominant), runs[0])
    for r in runs:
        if r is carrier:
            continue
        parent = r.getparent()
        if parent is not None and X.is_splittable(r):
            parent.remove(r)                 # 整个删掉：只清空文字会在 XML 里留下一串空 run
            stats["runs_removed"] += 1
        else:
            for t in r.iter(X.W + "t"):
                t.text = ""
    ts = list(carrier.iter(X.W + "t"))
    if not ts:
        t = etree.SubElement(carrier, X.W + "t")
        ts = [t]
    ts[0].text = text
    if text != text.strip():
        ts[0].set(X.XML_SPACE, "preserve")
    for extra in ts[1:]:
        extra.getparent().remove(extra)
    restyle(carrier, opt, stats)
    stats["runs_written"] += 1


def translate_paragraph(p, new_text, opt, stats, pid):
    segs = X.segments(p)
    frozen = [v for k, v in segs if k == "freeze"]
    marks = X.FREEZE_RE.findall(new_text)
    if marks != frozen:
        want = "、".join(f"{X.FREEZE_OPEN}{f[:10]}{X.FREEZE_CLOSE}" for f in frozen) or "（无）"
        return False, (f"冻结片对不上：原文 {want}，译文里对不上号"
                       f"（域/公式/图内文字要原样保留、不翻译、不删、不换顺序）")

    gaps, pos = [], 0
    for f in frozen:
        marker = X.FREEZE_OPEN + f + X.FREEZE_CLOSE
        i = new_text.index(marker, pos)
        gaps.append(new_text[pos:i])
        pos = i + len(marker)
    gaps.append(new_text[pos:])

    g, plan = 0, []
    for kind, val in segs:
        if kind == "freeze":
            g += 1
        else:
            if gaps[g] is None:           # 同一空档被两个可改片争用：切片逻辑出了问题，
                return False, "段落切片异常（同一空档对应多个可改片），已跳过不动它"
            plan.append((val, gaps[g]))
            gaps[g] = None
    for k, leftover in enumerate(gaps):
        if leftover:
            return False, (f"第 {k+1} 个空档里的文字「{leftover[:16]}」没有可写入的位置"
                           f"（那一段原本紧挨着域/公式）")

    # 先整体判定再落笔：某一片译空了就整段拒绝，别落一半——半中半英的段落比没翻更糟
    for runs, txt in plan:
        old = "".join(X.run_text(r) for r in runs)
        if old.strip() and not txt.strip():
            return False, f"这一段的译文是空的（原文「{old[:16]}…」）——漏译，不许落盘"
    for runs, txt in plan:
        write_segment(runs, txt, opt, stats, pid)
    return True, ""


def main():
    ap = argparse.ArgumentParser(description="整篇译文 → 就地写回 docx（保原排版）")
    ap.add_argument("src", type=Path, help="原稿 .docx")
    ap.add_argument("edits", help="译文清单（docx_extract.py 产出的 _para.md 改成译文，或 json）")
    ap.add_argument("-o", "--out", type=Path, required=True, help="输出 .docx")
    ap.add_argument("--set-lang", default=None,
                    help="目标语言标记，如 en-US / zh-CN。不设的话 Word 会用原语言的词典校对译文")
    ap.add_argument("--latin-font", default=None,
                    help='西文字体，如 "Times New Roman"。中译英不设的话英文会用宋体渲染')
    ap.add_argument("--cjk-font", default=None, help="中文字体，如 宋体（英译中时设）")
    opt = ap.parse_args()

    if not opt.src.is_file():
        print(f"ERROR: 找不到原稿：{opt.src}", file=sys.stderr)
        sys.exit(2)
    edits = read_edits(opt.edits)

    stats = {"runs_written": 0, "runs_removed": 0, "lang_runs": 0, "font_runs": 0,
             "fmt_unified": []}
    replaced, done, same, rejected = {}, 0, 0, []
    seen = set()
    for part in X.parts_of(opt.src):
        root = X.load(opt.src, part)
        prefix = X.part_prefix(part)
        dirty = False
        for i, p in enumerate(X.paragraphs(root)):
            pid = f"{prefix}{i:04d}"
            if pid not in edits:
                continue
            seen.add(pid)
            before = X.marked_text(p)
            if not before.strip():
                continue
            if edits[pid] == before:
                same += 1
                continue
            ok, why = translate_paragraph(p, edits[pid], opt, stats, pid)
            if ok:
                done += 1
                dirty = True
            else:
                rejected.append((pid, why))
        if dirty:
            replaced[part] = X.serialize(root)

    X.rezip(opt.src, opt.out, replaced)
    unknown = [k for k in edits if k not in seen]

    print(f"[translate] 落译文 {done} 段，涉及部件 {len(replaced)} 个"
          f"（{len(edits)} 段清单里 {same} 段与原文逐字相同）")
    if same:
        print(f"[translate] ⚠ 有 {same} 段与原文一字不差——多半是漏译（模型跳段），"
              f"不是「这段无需翻译」。跑 docx_verify.py --mode translate 会逐段点名。",
              file=sys.stderr)
    if stats["fmt_unified"]:
        ids = "、".join(f"{pid}({n}种)" for pid, n in stats["fmt_unified"][:8])
        print(f"[translate] {len(stats['fmt_unified'])} 段原本段内有多种格式"
              f"（加粗/斜体/颜色/字号），译文按主导格式统一：{ids}"
              f"{' …' if len(stats['fmt_unified']) > 8 else ''}")
        print(f"[translate]   这一条无法回避——译文里那个词落在哪儿机器判断不了。"
              f"要保住就得人工在 Word 里补回加粗/斜体。")
    if stats["lang_runs"] or stats["font_runs"]:
        print(f"[translate] 语言标记 {stats['lang_runs']} 个 run"
              f"（{opt.set_lang or '未设'}），字体 {stats['font_runs']} 个 run"
              f"（西文 {opt.latin_font or '未设'} / 中文 {opt.cjk_font or '未设'}）")
    elif opt.out:
        print(f"[translate] ⚠ 没设 --set-lang / --latin-font：Word 会拿原语言的词典校对译文"
              f"（全篇红波浪线），中译英时英文还会用中文字体渲染。", file=sys.stderr)
    for pid, why in rejected:
        print(f"[translate] 拒绝 {pid}：{why}", file=sys.stderr)
    if unknown:
        print(f"[translate] 清单里有 {len(unknown)} 个编号原稿里没有（已忽略）："
              f"{', '.join(unknown[:6])}", file=sys.stderr)
    print(f"[translate] → {opt.out}")
    print(f"[translate] 下一步：python docx_verify.py {opt.src.name} {opt.out.name} "
          f"--mode translate --expect-lang {(opt.set_lang or 'en')[:2]}")
    if rejected:
        sys.exit(3)


if __name__ == "__main__":
    main()

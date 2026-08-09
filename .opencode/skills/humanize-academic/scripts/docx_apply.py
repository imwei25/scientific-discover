#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把逐段改写结果【就地】写回原 docx —— 除了被改的那几个字，别的字节一律不动。

原理：字符级 diff 落到具体 run 的 w:t 上。没被改到的字符，其所在 run 的 XML
原样保留，因此段内局部格式（斜体基因名、上下标、红字标注、高亮）在未改动处
必然还在。整份文件除 word/*.xml 里被改的那几个部件外，逐字节从原 zip 搬运。

两种写回模式：
  默认        直接覆盖，交回一份"干净稿"。
  --track-changes  落成 Word 原生【修订】(w:ins/w:del)，用户在 Word 里逐条接受/拒绝。
                   ★ 交付整篇润色稿时用这个：用户要的是"看得见改了什么"，
                     而不是一份"据说改过"的新文件。

用法：
  python docx_apply.py 原稿.docx 原稿_para.md -o 原稿_humanized.docx --track-changes
  改动清单也可以给 json（{"p0007": "新文本", ...}）。

退出码：0 成功；2 输入有问题；3 有段落被拒绝（改动没有全部落地）。
"""
import argparse
import copy
import json
import re
import sys
import time
from difflib import SequenceMatcher
from pathlib import Path

from lxml import etree

import docx_ooxml as X

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

LINE_RE = re.compile(r"^\[\[([A-Za-z0-9]+)\]\]\s?(.*)$")


# ---- 读改动清单 -----------------------------------------------------------

def read_edits(path):
    p = Path(path)
    if not p.is_file():
        print(f"ERROR: 找不到改动清单：{p}", file=sys.stderr)
        sys.exit(2)
    if p.suffix.lower() == ".json":
        return json.loads(p.read_text(encoding="utf-8"))
    edits, dup = {}, []
    for ln in p.read_text(encoding="utf-8").splitlines():
        m = LINE_RE.match(ln)
        if not m:
            continue                      # 注释行、空行：忽略
        if m.group(1) in edits:
            dup.append(m.group(1))
        edits[m.group(1)] = m.group(2)
    if dup:
        print(f"ERROR: 清单里有重复的段落编号：{', '.join(dup[:6])}\n"
              f"       同一段出现两行，无法判断哪行是最终稿。", file=sys.stderr)
        sys.exit(2)
    return edits


# ---- run 级写回 -----------------------------------------------------------

def set_run_text(run, text):
    """非修订模式：把整段文字塞进这个 run 的第一个 w:t，其余 w:t 清掉。"""
    ts = [t for t in run.iter(X.W + "t")]
    if not ts:
        return
    ts[0].text = text
    if text != text.strip():
        ts[0].set(X.XML_SPACE, "preserve")
    for extra in ts[1:]:
        extra.getparent().remove(extra)


def make_run(proto, text, deleted=False):
    """按 proto 的格式造一个只含 text 的新 run（修订模式用）。"""
    r = copy.deepcopy(proto)
    for c in list(r):
        if c.tag != X.W + "rPr":
            r.remove(c)
    t = etree.SubElement(r, X.W + ("delText" if deleted else "t"))
    t.text = text
    if text != text.strip():
        t.set(X.XML_SPACE, "preserve")
    return r


def wrap(tag, child, meta):
    el = etree.Element(X.W + tag)
    el.set(X.W + "id", str(meta["next_id"]()))
    el.set(X.W + "author", meta["author"])
    el.set(X.W + "date", meta["date"])
    el.append(child)
    return el


def coalesce(ops, min_equal, fmts):
    """把被极短"相同片"隔开的相邻改动并成一处。

    字符级 diff 对中文会产生"改一个字、留两个字、再改一个字"的碎片：落成修订标记后，
    Word 里是满屏单字红线，人根本读不下去，也没法逐条判断"这处改得对不对"。
    真人编辑给的红线是词组级的。所以把中间那段短于 min_equal 的"相同片"也吃进改动里——
    代价是有几个字被"删了再原样插回"，语义完全等价，可读性天差地别。
    """
    if min_equal <= 0:
        return ops
    # 只吃【夹在两处改动中间】的短相同片；结尾/开头挂着的不动，
    # 否则会平白造出"删掉再原样插回"的空修订。
    # 还有一条硬限制：**不许跨可见格式边界合并**。实测教训——不加这条时，合并把
    # 黑字与红字之间的短相同片吃进同一处改动，新插入的文字就被迫套上另一边的格式，
    # 跨边界告警从 1 处涨到 3 处，全是合并自己造出来的。
    def flat(i1, i2):
        return not fmts or len({fmts[k] for k in range(max(i1 - 1, 0), min(i2 + 1, len(fmts)))}) == 1

    out = []
    for k, op in enumerate(ops):
        sandwiched = (op[0] == "equal" and op[2] - op[1] < min_equal
                      and out and out[-1][0] != "equal"
                      and k + 1 < len(ops) and ops[k + 1][0] != "equal"
                      and flat(op[1], op[2]))
        out.append(("replace",) + tuple(op[1:]) if sandwiched else op)
    merged = []
    for op in out:
        if op[0] != "equal" and merged and merged[-1][0] != "equal":
            merged[-1] = ("replace", merged[-1][1], op[2], merged[-1][3], op[4])
        else:
            merged.append(tuple(op))
    return merged


def patch_runs(runs, new_text, opt, stats, pid, check_only=False):
    """把 new_text 写回这一串 run。返回 False 表示因护栏拒绝。

    check_only=True 时只做判定与告警、不动 XML —— 段落里有多个可改片时，
    必须先整体判定再统一落笔，否则第 2 片被拒时第 1 片已经改了一半，
    产出的文件既不是原稿也不是改写稿。
    """
    old = "".join(X.run_text(r) for r in runs)
    if old == new_text:
        return True
    owner = []
    for k, r in enumerate(runs):
        owner.extend([k] * len(X.run_text(r)))
    fmts = [X.visible_fmt(runs[o]) for o in owner]

    pieces = [[] for _ in runs]           # 每个 run 的 [(kind, text), ...]

    def push(k, kind, text, front=False):
        if not text:
            return
        lst = pieces[k]
        if not front and lst and lst[-1][0] == kind:
            lst[-1] = (kind, lst[-1][1] + text)
        elif front:
            lst.insert(0, (kind, text))
        else:
            lst.append((kind, text))

    ops = SequenceMatcher(None, old, new_text, autojunk=False).get_opcodes()
    for tag, i1, i2, j1, j2 in coalesce(ops, opt.granularity, fmts):
        if tag == "equal":
            for k in range(i1, i2):
                push(owner[k], "keep", old[k])
            continue
        if tag in ("replace", "delete"):
            spanned = sorted({owner[k] for k in range(i1, i2)})
            if len(spanned) > 1 and len({X.visible_fmt(runs[k]) for k in spanned}) > 1 and check_only:
                # 这一处改写跨越了【可见】格式边界（颜色/高亮/粗斜/上下标/字号）。
                # 硬改的话，被合并进来的那截文字会被迫改成前一段的格式——
                # 用户看到的是"某个词莫名其妙变了颜色"，而且没有任何提示。
                stats["fmt_cross"].append((pid, old[i1:i2][:24]))
                if opt.strict_format:
                    return False
            for k in range(i1, i2):
                push(owner[k], "del", old[k])
            if tag == "replace":
                # 新文字挂在【最后一个被删字符】所在的 run 上：Word 里读作"先删后插"，
                # 与真人红线的习惯一致。i1==i2 的退化情形（纯插入被并进 replace）另算。
                push(owner[i2 - 1] if i2 > i1 else (owner[i1 - 1] if i1 > 0 else 0),
                     "ins", new_text[j1:j2])
            continue
        # insert
        if i1 > 0:
            push(owner[i1 - 1], "ins", new_text[j1:j2])
        else:
            push(0, "ins", new_text[j1:j2], front=True)

    if check_only:
        return True

    if not opt.track_changes:
        for k, r in enumerate(runs):
            txt = "".join(t for kind, t in pieces[k] if kind != "del")
            if txt == X.run_text(r):
                continue                  # 一个字都没变的 run：不碰它，XML 保持原样
            stats["runs_modified"] += 1
            if not txt and opt.clean_empty_runs and X.is_splittable(r):
                r.getparent().remove(r)   # 整段被挪走的空 run，留着只是垃圾
                stats["runs_removed"] += 1
            else:
                set_run_text(r, txt)
        return True

    meta = stats["meta"]
    for k, r in enumerate(runs):
        seq = pieces[k]
        if not seq or (len(seq) == 1 and seq[0][0] == "keep" and seq[0][1] == X.run_text(r)):
            continue                      # 没动过
        parent = r.getparent()
        at = list(parent).index(r)
        built = []
        for kind, txt in seq:
            if kind == "keep":
                built.append(make_run(r, txt))
            elif kind == "ins":
                built.append(wrap("ins", make_run(r, txt), meta))
            else:
                built.append(wrap("del", make_run(r, txt, deleted=True), meta))
        for off, el in enumerate(built):
            parent.insert(at + off, el)
        parent.remove(r)
        stats["runs_modified"] += 1
    return True


# ---- 段落级：对齐冻结片 ---------------------------------------------------

def apply_paragraph(p, new_text, opt, stats, pid):
    segs = X.segments(p)
    frozen = [v for k, v in segs if k == "freeze"]
    marks = X.FREEZE_RE.findall(new_text)
    if marks != frozen:
        want = "、".join(f"{X.FREEZE_OPEN}{f[:10]}{X.FREEZE_CLOSE}" for f in frozen) or "（无）"
        got = "、".join(f"{X.FREEZE_OPEN}{f[:10]}{X.FREEZE_CLOSE}" for f in marks) or "（无）"
        return False, f"冻结片对不上：原文 {want}，改写稿 {got}（域/公式/图内文字不许改、不许删、不许换顺序）"

    # 按冻结片把新文本切成若干"空档"，再把空档对回各个可改片
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
            gaps[g] = None                # 这个空档已有归属
    for k, leftover in enumerate(gaps):
        if leftover:                      # 非空且没人认领 = 文字被写在了两个冻结片之间的真空处
            return False, (f"第 {k+1} 个空档里的文字「{leftover[:16]}」没有可写入的位置"
                           f"（那一段原本紧挨着域/公式，段首段尾无法插字）")

    # 先整体判定，再统一落笔——中途拒绝会留下"改了一半"的段落
    for runs, txt in plan:
        if not patch_runs(runs, txt, opt, stats, pid, check_only=True):
            return False, "改写跨越了可见格式边界（--strict-format 已拒绝）"
    for runs, txt in plan:
        patch_runs(runs, txt, opt, stats, pid)
    return True, ""


def main():
    ap = argparse.ArgumentParser(description="逐段改写结果 → 就地写回 docx")
    ap.add_argument("src", type=Path, help="原稿 .docx")
    ap.add_argument("edits", help="改动清单（docx_extract.py 产出的 _para.md，或 json）")
    ap.add_argument("-o", "--out", type=Path, required=True, help="输出 .docx")
    ap.add_argument("--track-changes", action="store_true",
                    help="落成 Word 原生修订（w:ins/w:del），用户可逐条接受/拒绝")
    ap.add_argument("--author", default="AI 润色", help="修订作者名（默认「AI 润色」）")
    ap.add_argument("--date", default=None, help="修订时间 ISO8601（默认当前时间）")
    ap.add_argument("--granularity", type=int, default=6, metavar="N",
                    help="把被少于 N 个字的相同片隔开的相邻改动并成一处修订"
                         "（默认 6，中文合适；0=关闭，逐字修订）")
    ap.add_argument("--strict-format", action="store_true",
                    help="改写跨越可见格式边界时直接拒绝该段（默认只告警）")
    ap.add_argument("--no-clean-empty-runs", dest="clean_empty_runs",
                    action="store_false", help="保留被清空的 run（默认删掉）")
    opt = ap.parse_args()

    if not opt.src.is_file():
        print(f"ERROR: 找不到原稿：{opt.src}", file=sys.stderr)
        sys.exit(2)
    edits = read_edits(opt.edits)
    counter = [1000]

    def next_id():
        counter[0] += 1
        return counter[0]

    stats = {"runs_modified": 0, "runs_removed": 0, "ins": 0, "dele": 0,
             "fmt_cross": [], "meta": {
                 "author": opt.author,
                 "date": opt.date or time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                 "next_id": next_id}}

    replaced, changed, unchanged, rejected, unknown = {}, 0, 0, [], []
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
                unchanged += 1
                continue
            ok, why = apply_paragraph(p, edits[pid], opt, stats, pid)
            if ok:
                changed += 1
                dirty = True
            else:
                rejected.append((pid, why))
        if dirty:
            replaced[part] = X.serialize(root)
            if opt.track_changes:
                gi, gd = X.revision_groups(root)
                stats["ins"] += gi
                stats["dele"] += gd

    unknown = [k for k in edits if k not in seen]
    if not replaced:
        print("[apply] 清单里没有任何与原文不同的段落——没有改动可写回。", file=sys.stderr)
    X.rezip(opt.src, opt.out, replaced)

    mode = "修订标记" if opt.track_changes else "直接覆盖"
    print(f"[apply] {mode}：改写 {changed} 段（{unchanged} 段与原文相同，跳过），"
          f"涉及部件 {len(replaced)} 个")
    if opt.track_changes:
        print(f"[apply] 落下修订：插入 {stats['ins']} 处 / 删除 {stats['dele']} 处"
              f"（相邻的已合并，即用户在 Word 里看到的处数），作者「{opt.author}」"
              f"——在「审阅」里逐条接受或拒绝")
    else:
        print(f"[apply] 修改 {stats['runs_modified']} 个 run"
              f"（清掉空 run {stats['runs_removed']} 个）")
    if stats["fmt_cross"]:
        print(f"[apply] ⚠ {len(stats['fmt_cross'])} 处改写跨越了可见格式边界"
              f"（颜色/高亮/粗斜/上下标），被合并的文字会改成前一段的格式，请人工看一眼：",
              file=sys.stderr)
        for pid, snip in stats["fmt_cross"][:8]:
            print(f"         {pid}：…{snip}…", file=sys.stderr)
    for pid, why in rejected:
        print(f"[apply] 拒绝 {pid}：{why}", file=sys.stderr)
    if unknown:
        print(f"[apply] 清单里有 {len(unknown)} 个编号在原稿里不存在（已忽略）："
              f"{', '.join(unknown[:6])}", file=sys.stderr)
    print(f"[apply] → {opt.out}")
    print(f"[apply] 下一步：python docx_verify.py {opt.src.name} {opt.out.name}")
    if rejected:
        sys.exit(3)


if __name__ == "__main__":
    main()

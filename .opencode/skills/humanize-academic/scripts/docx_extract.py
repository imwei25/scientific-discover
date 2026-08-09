#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把 .docx 抽成【带段落编号的文字清单】，供逐段就地改写——不生成"另一份文档"。

为什么要有这条路（别退回 pandoc 那条）：
`ingest_doc.py` 走的是 docx → markdown → 改写 → **重新生成** docx。重新生成意味着
原文件里 markdown 表达不了的东西全部消失，而且一路无声：
  * EndNote / Zotero 的引文域变成死文本，用户回 Word 再也没法更新文献表；
  * 合并单元格的表头必被拍平（pipe 表语法上就没有 rowspan/colspan）；
  * 页眉页脚、分节、页码、交叉引用、题注自动编号、批注、他人修订痕迹一并丢失。
本脚本只抽"地址簿"：图、表、域、页眉页脚自始至终没离开原文件，也就无所谓丢失。

产出（都落当前工作目录）：
  <稿件名>_para.md    模型读它、也改它：每行 `[[p0007]] 正文…`
  <稿件名>_para.json  机器用：部件、序号、原文、可改字数、是否在表格内

用法：
  python docx_extract.py manuscript.docx
  改写时**整行替换**那行的正文，行首 `[[id]]` 一个字符都不要动，别增删行。

退出码：0 成功；2 输入有问题。
"""
import argparse
import json
import sys
from pathlib import Path

import docx_ooxml as X

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


def main():
    ap = argparse.ArgumentParser(description="docx → 带编号的段落清单（就地改写用）")
    ap.add_argument("input", type=Path, help="待润色的 .docx")
    ap.add_argument("--out", type=Path, default=None, help="清单 md（默认 <稿件名>_para.md）")
    args = ap.parse_args()

    src = args.input
    if not src.is_file():
        print(f"ERROR: 找不到输入文件：{src}", file=sys.stderr)
        sys.exit(2)
    if src.suffix.lower() != ".docx":
        print(f"ERROR: 就地改写只支持 .docx，拿到的是 {src.suffix}。\n"
              f"       .pdf / .md 请走 ingest_doc.py 那条（改完用 render-docx 出件）。\n"
              f"       .doc(97-2003) 先转：soffice --headless --convert-to docx {src.name}",
              file=sys.stderr)
        sys.exit(2)

    rows, frozen_total = [], 0
    for part in X.parts_of(src):
        root = X.load(src, part)
        prefix = X.part_prefix(part)
        for i, p in enumerate(X.paragraphs(root)):
            text = X.marked_text(p)
            if not text.strip():
                continue
            elen = X.editable_len(p)
            anc = {a.tag for a in p.iterancestors()}
            style = p.find(X.W + "pPr/" + X.W + "pStyle")
            nfrozen = sum(1 for k, _ in X.segments(p) if k == "freeze")
            frozen_total += nfrozen
            rows.append({
                "id": f"{prefix}{i:04d}",
                "part": part,
                "index": i,
                "text": text,
                "plain": X.plain_text(p),
                "editable_chars": elen,
                "frozen_spans": nfrozen,
                "in_table": (X.W + "tc") in anc,
                "style": style.get(X.W + "val") if style is not None else None,
                "runs": len(p.findall(X.W + "r")),
            })

    if not rows:
        print("ERROR: 这份 docx 里没抽到任何文字段落。", file=sys.stderr)
        sys.exit(2)

    out_md = args.out or Path(f"{src.stem}_para.md")
    out_json = Path(f"{src.stem}_para.json")
    with open(out_md, "w", encoding="utf-8") as f:
        f.write(f"<!-- 就地改写清单：{src.name}\n"
                f"     改法：整行替换 [[id]] 后面的正文；行首 [[id]] 别动；别增删行、别拆合并段落。\n"
                f"     {X.FREEZE_OPEN}…{X.FREEZE_CLOSE} 里是域/公式/图内文字（引文、交叉引用、页码），\n"
                f"     可以整体挪位置，里面一个字都不许改，也不许删。 -->\n")
        for r in rows:
            f.write(f"[[{r['id']}]] {r['text']}\n")
    out_json.write_text(json.dumps(rows, ensure_ascii=False, indent=1), encoding="utf-8")

    n_tab = sum(1 for r in rows if r["in_table"])
    n_ro = sum(1 for r in rows if r["editable_chars"] == 0)
    parts = sorted({r["part"] for r in rows})
    print(f"[extract] {src.name} → {out_md} / {out_json.name}")
    print(f"[extract] 有字段落 {len(rows)} 段（表格单元格内 {n_tab} 段，"
          f"整段不可改 {n_ro} 段），冻结片 {frozen_total} 处")
    if len(parts) > 1:
        print(f"[extract] 覆盖部件：{', '.join(X.part_prefix(p) + '=' + p for p in parts)}")
    print(f"[extract] 最碎的一段有 {max(r['runs'] for r in rows)} 个 run（Word 的正常现象，不影响改写）")
    print(f"[extract] 下一步：改 {out_md} 里的正文行，然后\n"
          f"          python docx_apply.py {src.name} {out_md} -o {src.stem}_humanized.docx --track-changes")


if __name__ == "__main__":
    main()

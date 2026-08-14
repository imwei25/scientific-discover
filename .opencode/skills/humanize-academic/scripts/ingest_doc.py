#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把待润色的 .docx / .pdf / .md 抽成 Markdown —— **图和表一起抽出来**。

为什么要有这个脚本（别删，也别"顺手"换成裸 pandoc）：
润色模块此前没有「读入原文」这一步，agent 自己发挥，而它手边每条现成的路都丢图：
  * `pandoc x.docx -o x.md` **不加 `--extract-media`**：md 里留下 `![](media/rId10.png)`，
    但那个文件根本没落盘。等到排版出件时 pandoc 只打一句
    `[WARNING] Could not fetch resource ...: replacing image with description` 然后 **退 0** ——
    产出的 docx 里一张图都没有，全链路没有一句红字。
  * `pdf_to_md.py`（fulltext-retrieval）写死 `write_images=False, ignore_images=True`
    （注释是"skip images (saves tokens)"）——对"读文献"是对的，对"润色我的稿子"是灾难。
  * `python-docx` 的 `doc.paragraphs` 里既没有图、也没有表（表在 `doc.tables` 里要另取）。

所以这里把三件事一次做对：
  1. **媒体真的落盘**，并把链接改写成相对当前目录可解析的路径（排版步才找得到）；
  2. **表格一律转成 pipe 表**（关掉 simple/multiline/grid 表）——render-docx 的
     `normalize_md.py` / `infer_colwidths.py` / `figures_at_end.py` 全都只认 pipe 表，
     出成 simple table 的话后面三个优化全部落空；
  3. **数出图与表各多少**，打印出来。这个数字是下游 `check_invariants.py` 的比对基准：
     润色稿里少一张图、少一行表，那一步就会判红。

媒体目录**只放一层**（`<稿件名>_files/fig_001.png`，不是 pandoc 默认的 `_files/media/...`）：
界面「产出」侧栏只递归一层，再深一层用户就看不到、也下载不了。

用法：
  python ingest_doc.py manuscript.docx                  # → manuscript_src.md + manuscript_files/
  python ingest_doc.py manuscript.pdf --out src.md
  python ingest_doc.py draft.md                         # 已经是 md：原样复制并清点图表

退出码：0 成功；2 输入有问题；3 缺依赖（pandoc / pymupdf4llm）；4 转换失败。
"""
import argparse
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

# pandoc 能直接读的文稿格式。.doc/.rtf 不一定所有 pandoc 版本都带 reader，
# 转失败时如实报错，别假装成功（下游会拿着空稿继续润色）。
PANDOC_EXTS = {".docx", ".odt", ".doc", ".rtf", ".html", ".htm", ".tex", ".latex"}
MD_EXTS = {".md", ".markdown", ".txt"}
IMG_RE = re.compile(r"!\[[^\]]*\]\(\s*<?([^)>\s]+)")
# pipe 表的表体行：以 | 开头结尾。表头分隔行（|---|---|）单独识别，用来数"几张表"。
PIPE_ROW_RE = re.compile(r"^\s*\|.*\|\s*$")
PIPE_SEP_RE = re.compile(r"^\s*\|(?:\s*:?-{2,}:?\s*\|)+\s*$")


def resolve_pandoc():
    """找 pandoc。Windows 上 winget 装的 pandoc 常不在 Git Bash 的 PATH 里，
    补几条与 render_docx.sh 一致的探测路径，免得两个脚本对"装没装"给出不同结论。"""
    exe = shutil.which("pandoc")
    if exe:
        return exe
    la = os.environ.get("LOCALAPPDATA", "")
    pf = os.environ.get("ProgramFiles", "")
    cands = []
    if la:
        cands += sorted(Path(la).glob("Microsoft/WinGet/Packages/JohnMacFarlane.Pandoc*/pandoc-*/pandoc.exe"))
        cands.append(Path(la) / "Microsoft/WinGet/Links/pandoc.exe")
    if pf:
        cands.append(Path(pf) / "Pandoc/pandoc.exe")
    for c in cands:
        if Path(c).is_file():
            return str(c)
    return None


def flatten_media(media_root: Path, stem: str):
    """pandoc --extract-media 会造出 <dir>/media/<name>；摊平成 <dir>/fig_00N.<ext>。

    返回 {原相对路径: 新相对路径}（都相对于 md 所在目录）。
    摊平的理由见文件头：侧栏只递归一层，`_files/media/x.png` 用户看不到。
    """
    nested = media_root / "media"
    mapping = {}
    if not nested.is_dir():
        return mapping
    for i, src in enumerate(sorted(nested.iterdir()), 1):
        if not src.is_file():
            continue
        dst = media_root / f"fig_{i:03d}{src.suffix.lower()}"
        # 目标已存在（重跑）时先删，shutil.move 在 Windows 上不覆盖
        if dst.exists():
            dst.unlink()
        shutil.move(str(src), str(dst))
        mapping[f"{media_root.name}/media/{src.name}"] = f"{media_root.name}/{dst.name}"
    try:
        nested.rmdir()
    except OSError:
        pass
    return mapping


def unescape_citations(text: str) -> str:
    r"""pandoc 的 markdown writer 会把 `[1]` 写成 `\[1\]`（防止被当成链接/引用）。

    渲染结果一样，但会让「改动对照」里每一条带角标的句子都显得被改过，
    也让人读稿时满眼反斜杠。只还原**纯数字角标**这一种，别动其它转义。
    """
    return re.sub(r"\\\[(\d+(?:\s*[-,]\s*\d+)*)\\\]", r"[\1]", text)


def count_assets(text: str):
    """数出图片数与 pipe 表数（表以"表头分隔行"计，一张表算一个）。"""
    imgs = IMG_RE.findall(text)
    tables = sum(1 for ln in text.splitlines() if PIPE_SEP_RE.match(ln))
    rows = sum(1 for ln in text.splitlines() if PIPE_ROW_RE.match(ln))
    return imgs, tables, rows


def convert_pandoc(src: Path, out_md: Path, media_dir: Path) -> str:
    pandoc = resolve_pandoc()
    if not pandoc:
        print("ERROR: 未找到 pandoc，无法读入 Word/ODT 稿件。先跑 env-setup 技能。", file=sys.stderr)
        sys.exit(3)
    # -t 里显式关掉 simple/multiline/grid 表：默认输出的是 simple table，
    # 而 render-docx 的三个后处理脚本只认 pipe 表（见文件头第 2 条）。
    fmt = "markdown-simple_tables-multiline_tables-grid_tables+pipe_tables"
    cmd = [pandoc, str(src), "-t", fmt, "--wrap=none",
           f"--extract-media={media_dir}", "-o", str(out_md)]
    r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if r.returncode != 0:
        print(f"ERROR: pandoc 转换失败（{src.name}）：\n{(r.stderr or '').strip()[:1500]}", file=sys.stderr)
        sys.exit(4)
    if r.stderr and r.stderr.strip():
        print(f"[ingest] pandoc 提示：\n{r.stderr.strip()[:1500]}", file=sys.stderr)
    return out_md.read_text(encoding="utf-8")


def convert_pdf(src: Path, out_md: Path, media_dir: Path) -> str:
    try:
        import pymupdf4llm
    except ImportError:
        print("ERROR: 未装 pymupdf4llm，无法读入 PDF 稿件。先跑 env-setup 技能。", file=sys.stderr)
        sys.exit(3)
    media_dir.mkdir(parents=True, exist_ok=True)
    # 与 fulltext-retrieval/pdf_to_md.py 的默认【故意相反】：那边为省 token 丢图，
    # 这边是在润色用户自己的稿子，图丢了等于把人家的插图删了。
    kwargs = {
        "show_progress": False,
        "write_images": True,
        "ignore_images": False,
        "image_path": str(media_dir),
        "image_format": "png",
        "table_strategy": "lines_strict",
    }
    try:
        md_text = pymupdf4llm.to_markdown(str(src), **kwargs)
    except TypeError:
        # 老版本 pymupdf4llm 不认 image_path/image_format：退回"至少别丢正文"，
        # 但必须**响亮说明图没抽出来**，不许静默降级（静默降级正是本次要修的病）。
        print("[ingest] WARN: 当前 pymupdf4llm 版本不支持 image_path，改用无图模式——"
              "**PDF 里的插图没有抽出来**，请改传 .docx 或手动提供图片文件。", file=sys.stderr)
        md_text = pymupdf4llm.to_markdown(str(src), show_progress=False,
                                          write_images=False, ignore_images=True,
                                          table_strategy="lines_strict")
    md_text = re.sub(r"\n{4,}", "\n\n\n", md_text)
    out_md.write_text(md_text, encoding="utf-8")
    return md_text


def main():
    ap = argparse.ArgumentParser(description="待润色稿件 → Markdown（图与表一并抽出）")
    ap.add_argument("input", type=Path, help="待润色的 .docx / .pdf / .md")
    ap.add_argument("--out", type=Path, default=None,
                    help="输出 md（默认 <稿件名>_src.md，写在当前目录）")
    ap.add_argument("--media-dir", type=Path, default=None,
                    help="媒体目录（默认 <稿件名>_files/，与 md 同级）")
    args = ap.parse_args()

    src = args.input
    if not src.is_file():
        print(f"ERROR: 找不到输入文件：{src}", file=sys.stderr)
        sys.exit(2)
    ext = src.suffix.lower()

    # 产物一律落【当前工作目录】＝本会话产物目录（见主控 §五）。
    # 上传目录不是产物目录，写回上传目录用户在侧栏里看不到。
    out_md = args.out if args.out else Path(f"{src.stem}_src.md")
    media_dir = args.media_dir if args.media_dir else Path(f"{src.stem}_files")
    out_md.parent.mkdir(parents=True, exist_ok=True)

    if ext in MD_EXTS:
        text = src.read_text(encoding="utf-8", errors="replace")
        # md 稿引用的图多半和 md 放在一起（上传目录），复制到产物目录，
        # 否则排版步 `--resource-path` 照样找不到 —— 症状和 docx 丢图一模一样。
        imgs, _, _ = count_assets(text)
        copied = 0
        for ref in imgs:
            if re.match(r"^[a-z]+://", ref, re.I):
                continue
            cand = (src.parent / ref)
            if cand.is_file():
                dst = out_md.parent / ref
                dst.parent.mkdir(parents=True, exist_ok=True)
                if cand.resolve() != dst.resolve():
                    shutil.copy2(cand, dst)
                copied += 1
        out_md.write_text(text, encoding="utf-8")
        if imgs and copied < len(imgs):
            print(f"[ingest] WARN: 稿件引用 {len(imgs)} 张图，只找到并复制了 {copied} 张——"
                  f"缺的那些排版时会**静默消失**，请让用户补齐原图。", file=sys.stderr)
    elif ext == ".pdf":
        text = convert_pdf(src, out_md, media_dir)
    elif ext in PANDOC_EXTS:
        text = convert_pandoc(src, out_md, media_dir)
        mapping = flatten_media(media_dir, src.stem)
        if mapping:
            for old, new in mapping.items():
                text = text.replace(old, new)
        text = unescape_citations(text)
        out_md.write_text(text, encoding="utf-8")
    else:
        print(f"ERROR: 不认识的稿件格式 {ext}；支持 .docx/.odt/.doc/.rtf/.pdf/.md", file=sys.stderr)
        sys.exit(2)

    imgs, tables, rows = count_assets(text)
    # 落盘核对：md 里写着的图，文件是不是真的在。这一条就是为了堵住"链接在、文件不在"
    # 那个静默丢图的口子 —— 在入口就发现，比等到排版出件后用户打开 Word 才发现强。
    missing = []
    for ref in imgs:
        if re.match(r"^[a-z]+://", ref, re.I):
            continue
        if not (out_md.parent / ref).is_file():
            missing.append(ref)

    print(f"[ingest] {src.name} → {out_md}")
    print(f"[ingest] 抽出 图 {len(imgs)} 张 / 表 {tables} 张（表体 {rows} 行）")
    # md 直通那条路不建媒体目录（图按原稿的相对路径复制到产物目录），别报一个不存在的目录
    if len(imgs) and media_dir.is_dir():
        print(f"[ingest] 媒体目录：{media_dir}/")
    if missing:
        print(f"[ingest] WARN: 有 {len(missing)} 处图片链接在稿件里但文件没落盘："
              f"{', '.join(missing[:5])}{' …' if len(missing) > 5 else ''}\n"
              f"         这些图排版时会**无声消失**，必须先解决再往下走。", file=sys.stderr)
    print("[ingest] 下一步：润色时这 %d 张图与 %d 张表必须原样搬进润色稿，"
          "改完用 check_invariants.py 比对（少一张就判红）。" % (len(imgs), tables))


if __name__ == "__main__":
    main()

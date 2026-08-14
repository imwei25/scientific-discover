#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""按 library.json 里的分类，把文献文件归到同名子文件夹里（一类一个子文件夹）。

【这是会动用户原始文件的操作】所以：
  · 默认只【预演】，打印"哪个文件会去哪儿"，一个字节都不动；真要执行必须显式 --apply。
  · 每次执行都写 archive_log.json（from→to 全量），`--undo` 能原样搬回去。
  · 同名冲突不覆盖，自动加 (2)(3)；移完把 library.json 里的 file 字段同步成新路径，
    否则下一次归档/改分类会找不到文件。

用法：
  python archive_library.py                     # 预演（默认，不动文件）
  python archive_library.py --apply             # 真的移动
  python archive_library.py --apply --copy      # 复制一份过去，原文件留在原地
  python archive_library.py --undo              # 按 archive_log.json 撤销上一次归档
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from datetime import datetime

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

UNCLASSIFIED = "未分类"


def rebuild(root, json_name):
    """路径变了就把 Excel 重出一遍。

    ★ 不重出的后果不是"不好看"：台账里的 file 已经变成「类名/文件名」，而 Excel 的「文件名」列
      还是旧路径 —— 界面上的「改分类」按这一列去台账里找记录，一漂就每行都判成"台账里没有这一篇"，
      下拉当场全部失效。web/library.mjs 那半边同理（两边必须一起改）。
    """
    build = os.path.join(os.path.dirname(os.path.abspath(__file__)), "build_workbook.py")
    try:
        r = subprocess.run([sys.executable, build, "--json", json_name, "--out", "library.xlsx"],
                           cwd=root, capture_output=True, text=True)
        if r.returncode != 0:
            print(f"  ⚠ Excel 没能重出（{(r.stderr or r.stdout or '').strip()[:200]}）——"
                  f"请手动跑一次 build_workbook.py，否则表里的文件名还是旧路径")
    except Exception as e:
        print(f"  ⚠ Excel 没能重出：{type(e).__name__}: {e}")


def safe_dir(raw):
    """分类名 → 目录名。Windows 保留字符 / 结尾的点与空格都要处理，否则建不出来"""
    name = re.sub(r'[\\/:*?"<>|\x00-\x1f]', "_", str(raw or "").strip())
    name = name.rstrip(". ").strip() or UNCLASSIFIED
    return name[:80]


def unique_path(dst):
    """不覆盖：a.pdf 已存在 → a (2).pdf"""
    if not os.path.exists(dst):
        return dst
    stem, ext = os.path.splitext(dst)
    for i in range(2, 1000):
        cand = f"{stem} ({i}){ext}"
        if not os.path.exists(cand):
            return cand
    raise RuntimeError(f"同名文件太多，放不下了：{dst}")


def do_undo(root, logp):
    if not os.path.exists(logp):
        sys.exit(f"没有 {os.path.basename(logp)}，无从撤销（只有执行过归档才会有这份记录）")
    with open(logp, encoding="utf-8") as f:
        log = json.load(f)
    moves = log.get("moves") or []
    if log.get("mode") == "copy":
        sys.exit("上一次是【复制】归档，原文件没被动过——不需要撤销。要删掉复制出来的子文件夹请自己确认后删。")
    n_ok, n_miss = 0, 0
    for m in reversed(moves):
        src, dst = os.path.join(root, m["to"]), os.path.join(root, m["from"])
        if not os.path.exists(src):
            n_miss += 1
            continue
        os.makedirs(os.path.dirname(dst) or root, exist_ok=True)
        shutil.move(src, unique_path(dst))
        n_ok += 1
    # 空掉的分类目录顺手清掉（只删空目录，里面有别的东西就留着）
    for cat in {os.path.dirname(m["to"]) for m in moves if os.path.dirname(m["to"])}:
        d = os.path.join(root, cat)
        try:
            if os.path.isdir(d) and not os.listdir(d):
                os.rmdir(d)
        except OSError:
            pass
    # library.json 的路径同步搬回
    libp = os.path.join(root, log.get("json", "library.json"))
    if os.path.exists(libp):
        with open(libp, encoding="utf-8") as f:
            lib = json.load(f)
        back = {m["to"]: m["from"] for m in moves}
        for r in lib.get("records", []):
            if r.get("file") in back:
                r["file"] = back[r["file"]]
        with open(libp, "w", encoding="utf-8") as f:
            json.dump(lib, f, ensure_ascii=False, indent=2)
        rebuild(root, log.get("json", "library.json"))
    os.remove(logp)
    print(f"已撤销：{n_ok} 个文件搬回原位" + (f"；{n_miss} 个在原位置找不到（可能被手动移走了）" if n_miss else ""))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default=".", help="文献文件夹（默认当前目录）")
    ap.add_argument("--json", default="library.json")
    ap.add_argument("--apply", action="store_true", help="真的执行；不加就是预演")
    ap.add_argument("--copy", action="store_true", help="复制而不是移动（原文件留在原地）")
    ap.add_argument("--undo", action="store_true", help="撤销上一次归档")
    ap.add_argument("--log", default="archive_log.json")
    a = ap.parse_args()

    root = os.path.abspath(a.dir)
    logp = os.path.join(root, a.log)
    if a.undo:
        return do_undo(root, logp)

    libp = os.path.join(root, a.json)
    if not os.path.exists(libp):
        sys.exit(f"找不到 {a.json}")
    with open(libp, encoding="utf-8") as f:
        lib = json.load(f)
    if not lib.get("classified", True):
        sys.exit("这份台账是【不分类】的，没有可归档的类别。")

    plan, missing, stay = [], [], 0
    for r in lib.get("records", []):
        rel = str(r.get("file") or "").replace("\\", "/")
        if not rel:
            continue
        src = os.path.join(root, rel)
        if not os.path.exists(src):
            missing.append(rel)
            continue
        cat = safe_dir(r.get("category") or UNCLASSIFIED)
        to = f"{cat}/{os.path.basename(rel)}"
        if to == rel:                     # 已经在正确的子文件夹里
            stay += 1
            continue
        plan.append({"from": rel, "to": to, "record": r})

    verb = "复制" if a.copy else "移动"
    if not a.apply:
        print(f"【预演】不会动任何文件。共 {len(plan)} 个待{verb}"
              + (f"，{stay} 个已在位" if stay else "")
              + (f"，{len(missing)} 个找不到" if missing else ""))
        for p in plan[:200]:
            print(f"  {p['from']}  →  {p['to']}")
        if len(plan) > 200:
            print(f"  …… 另有 {len(plan) - 200} 个")
        for m in missing:
            print(f"  ⚠ 找不到：{m}（可能已被手动移走或改名）")
        print(f"\n确认无误后加 --apply 执行" + ("（--copy 已指定：原文件会留在原地）" if a.copy else "（移动后可用 --undo 撤销）"))
        return

    moves = []
    for p in plan:
        src = os.path.join(root, p["from"])
        dstdir = os.path.join(root, os.path.dirname(p["to"]))
        os.makedirs(dstdir, exist_ok=True)
        dst = unique_path(os.path.join(root, p["to"]))
        try:
            shutil.copy2(src, dst) if a.copy else shutil.move(src, dst)
        except Exception as e:            # 单个文件被占用/无权限不该毁掉整批
            print(f"  ⚠ {verb}失败：{p['from']}（{type(e).__name__}: {e}）")
            continue
        rel_to = os.path.relpath(dst, root).replace(os.sep, "/")
        moves.append({"from": p["from"], "to": rel_to})
        if not a.copy:
            p["record"]["file"] = rel_to   # 移动才改台账；复制的话原文件还在原路径

    if not a.copy and moves:
        with open(libp, "w", encoding="utf-8") as f:
            json.dump(lib, f, ensure_ascii=False, indent=2)
        rebuild(root, a.json)
    with open(logp, "w", encoding="utf-8") as f:
        json.dump({"at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"), "dir": root,
                   "mode": "copy" if a.copy else "move", "json": a.json, "moves": moves},
                  f, ensure_ascii=False, indent=2)

    cats = sorted({os.path.dirname(m["to"]) for m in moves})
    print(f"归档完成：{len(moves)} 个文件已{verb}到 {len(cats)} 个子文件夹")
    for c in cats:
        print(f"  · {c}/")
    if missing:
        print(f"⚠ {len(missing)} 个文件找不到，没动：{'、'.join(missing[:10])}")
    if not a.copy:
        print(f"记录写在 {a.log}；要搬回去：python archive_library.py --undo")


if __name__ == "__main__":
    main()

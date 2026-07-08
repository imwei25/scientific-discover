#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
校验所有 skill 是否可被 OpenCode 正确加载。检查：
  1) SKILL.md 无 BOM（带 BOM 会让 OpenCode 崩溃——本仓库踩过的坑）
  2) frontmatter 合法，含 name + description，且 name 与目录名一致
  3) 两套镜像 .opencode/skills 与 deploy/skills 的技能集合一致
  4) 技能引用的辅助脚本存在
  5) 两套镜像的“正文方法论”未漂移——规范化（统一换行、venv 解释器→python3）
     并剥掉每个技能各自的“环境前言”（`## Python 环境`/`## 解释器` 段、
     `> 本仓库运行环境` 提示行）后，正文必须逐字节一致。这样改了一边忘了另一边
     就会被抓出来。data-analysis 的正文是有意为容器环境重写的，列入白名单不比对。

退出码非 0 表示有问题（供一键安装脚本判定）。
"""
import os
import re
import sys
import difflib

# Windows 控制台可能是 GBK，强制 stdout 用 UTF-8，避免打印符号时崩溃
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, ".opencode", "skills")   # 唯一真源镜像
DST = os.path.join(ROOT, "deploy", "skills")       # 服务器/容器镜像
MIRRORS = [SRC, DST]

# 正文可以合法地在两套镜像之间不一致的技能（各自手工维护，不做正文比对）。
# data-analysis：deploy 版把说明整段重写成“服务器/容器版”。
INTENTIONAL_BODY_DIVERGENCE = {"data-analysis"}

# 环境前言：允许两边不同、且从正文比对中剔除的区域。
_ENV_NOTE_RE = re.compile(r"^>\s*\*\*本仓库运行环境")           # vendored 技能顶部提示行
_ENV_SEC_RE = re.compile(r"^##\s*(Python 环境|解释器)")          # 环境小节标题
_NEXT_SEC_RE = re.compile(r"^##\s")


def skill_body(path):
    """把一个 SKILL.md 规范化并剥掉环境前言，返回用于跨镜像比对的正文行列表。

    规范化：统一 CRLF/CR→LF；本地 venv 解释器路径→python3（两套镜像唯一的
    机械差异）。剥离：`> 本仓库运行环境` 行、`## Python 环境`/`## 解释器` 到下一
    个 `## ` 之间的整段。剩下的应当在两套镜像里逐字节一致。
    """
    text = open(path, "rb").read().decode("utf-8", "replace")
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    # 统一各平台解释器写法，避免两镜像内联命令因 Windows/Linux 路径不同而误报
    for pat in ("backend/.venv/Scripts/python.exe", ".venv\\Scripts\\python.exe",
                ".venv/Scripts/python.exe", ".venv/bin/python", "python3"):
        text = text.replace(pat, "PY")
    out, in_env = [], False
    for line in text.split("\n"):
        if _ENV_NOTE_RE.match(line):
            continue
        if _ENV_SEC_RE.match(line):
            in_env = True
            continue
        if in_env and _NEXT_SEC_RE.match(line):
            in_env = False
        if in_env:
            continue
        out.append(line)
    return out


def check_body_sync(common_names):
    """比对两套镜像里同名技能的正文，返回问题列表。"""
    errs = []
    for name in sorted(common_names):
        if name in INTENTIONAL_BODY_DIVERGENCE:
            continue
        a = skill_body(os.path.join(SRC, name, "SKILL.md"))
        b = skill_body(os.path.join(DST, name, "SKILL.md"))
        if a == b:
            continue
        diff = list(difflib.unified_diff(
            a, b, fromfile=f".opencode/{name}", tofile=f"deploy/{name}",
            lineterm="", n=1))
        # 只展示前若干行差异，够定位即可
        shown = "\n      ".join(diff[:14])
        errs.append(
            f"[正文漂移] 技能 {name!r} 两套镜像正文不一致"
            f"（改了一边忘了另一边？）：\n      {shown}")
    return errs


def parse_frontmatter(text):
    if not text.startswith("---"):
        return None
    end = text.find("\n---", 3)
    if end == -1:
        return None
    fm = {}
    for line in text[3:end].strip().splitlines():
        if ":" in line:
            k, v = line.split(":", 1)
            fm[k.strip()] = v.strip()
    return fm


def collect_helpers(base):
    """收集该镜像下所有辅助脚本文件名（供跨技能引用校验）。"""
    present = set()
    if not os.path.isdir(base):
        return present
    for d in os.listdir(base):
        sd = os.path.join(base, d)
        if not os.path.isdir(sd):
            continue
        for root, _, files in os.walk(sd):
            for fn in files:
                if fn.endswith(".py"):
                    present.add(fn)
    return present


def check_mirror(base):
    errs = []
    names = set()
    if not os.path.isdir(base):
        return [f"缺少目录 {base}"], names
    helpers_present = collect_helpers(base)
    for d in sorted(os.listdir(base)):
        sk = os.path.join(base, d, "SKILL.md")
        if not os.path.isfile(sk):
            continue
        names.add(d)
        raw = open(sk, "rb").read()
        if raw.startswith(b"\xef\xbb\xbf"):
            errs.append(f"[BOM] {sk} 带 UTF-8 BOM，会导致 OpenCode 崩溃")
        text = raw.decode("utf-8", "replace")
        fm = parse_frontmatter(text)
        if not fm:
            errs.append(f"[frontmatter] {sk} 缺少合法的 --- frontmatter ---")
            continue
        if "name" not in fm:
            errs.append(f"[frontmatter] {sk} 缺 name")
        elif fm["name"] != d:
            errs.append(f"[name] {sk} 的 name={fm['name']!r} 与目录名 {d!r} 不一致")
        if not fm.get("description"):
            errs.append(f"[frontmatter] {sk} 缺 description")
        # 引用脚本存在性：只要该镜像里任一技能提供了这个脚本即算通过
        # （允许 research-scan 引用 literature-download/fetch.py 这类跨技能调用）
        for helper in ("fetch.py", "search.py", "build_docx.py", "pubstyle.py", "verify_refs.py"):
            if helper in text and helper not in helpers_present:
                errs.append(f"[missing-script] {sk} 提到 {helper} 但整个镜像里都找不到")
    return errs, names


def main():
    all_errs = []
    name_sets = []
    for base in MIRRORS:
        errs, names = check_mirror(base)
        all_errs += errs
        name_sets.append(names)
        print(f"{base}: {len(names)} 个技能 -> {', '.join(sorted(names)) or '(空)'}")

    if len(name_sets) == 2 and name_sets[0] != name_sets[1]:
        only_a = name_sets[0] - name_sets[1]
        only_b = name_sets[1] - name_sets[0]
        if only_a:
            all_errs.append(f"[镜像不一致] 只在 .opencode/skills: {sorted(only_a)}")
        if only_b:
            all_errs.append(f"[镜像不一致] 只在 deploy/skills: {sorted(only_b)}")

    # 正文漂移检查（只对两套镜像都存在的技能）
    if len(name_sets) == 2:
        common = name_sets[0] & name_sets[1]
        all_errs += check_body_sync(common)

    print("-" * 50)
    if all_errs:
        print(f"发现 {len(all_errs)} 个问题：")
        for e in all_errs:
            print("  [x]", e)
        sys.exit(1)
    print(f"[OK] 全部通过：{len(name_sets[0])} 个技能，两套镜像技能集合一致、"
          f"正文无漂移（data-analysis 除外，有意重写），无 BOM，frontmatter 合法。")


if __name__ == "__main__":
    main()

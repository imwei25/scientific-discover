#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
校验所有 skill 是否可被 OpenCode 正确加载。检查：
  1) SKILL.md 无 BOM（带 BOM 会让 OpenCode 崩溃——本仓库踩过的坑）
  2) frontmatter 合法，含 name + description，且 name 与目录名一致
  3) 技能引用的辅助脚本存在
  4) shell 脚本不得带 CRLF（技能会在 Linux/mac 上直接执行，CRLF 会破坏 bash）

历史注：仓库曾维护 .opencode/skills 与 deploy/skills 双镜像并在此比对漂移；
deploy 副本连同整个容器部署目录已删除，本脚本随之只校验唯一源 .opencode/skills。

退出码非 0 表示有问题（供一键安装脚本判定）。
"""
import os
import sys

# Windows 控制台可能是 GBK，强制 stdout 用 UTF-8，避免打印符号时崩溃
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, ".opencode", "skills")   # 唯一真源（本地 + 部署镜像共用）


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
    """收集所有辅助脚本文件名（供跨技能引用校验）。"""
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


def check_shell_eol(base):
    """技能目录整体 COPY 进 Linux 容器：.sh 带 CRLF 会让 bash 报 '\\r' 语法错。"""
    errs = []
    for root, _, files in os.walk(base):
        for fn in files:
            if not fn.endswith(".sh"):
                continue
            p = os.path.join(root, fn)
            if b"\r\n" in open(p, "rb").read():
                rel = os.path.relpath(p, ROOT)
                errs.append(
                    f"[CRLF] {rel} 带 CRLF 换行——进容器会破坏 bash。"
                    f"根 .gitattributes 已强制 *.sh eol=lf，重新 checkout 或手工转 LF")
    return errs


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
        # 引用脚本存在性：只要任一技能提供了这个脚本即算通过
        # （允许 research-scan 引用 literature-download/fetch.py 这类跨技能调用）
        for helper in ("fetch.py", "search.py", "build_docx.py", "pubstyle.py", "verify_refs.py"):
            if helper in text and helper not in helpers_present:
                errs.append(f"[missing-script] {sk} 提到 {helper} 但整个技能目录里都找不到")
    return errs, names


def main():
    all_errs, names = check_mirror(SRC)
    print(f"{SRC}: {len(names)} 个技能 -> {', '.join(sorted(names)) or '(空)'}")
    all_errs += check_shell_eol(SRC)

    print("-" * 50)
    if all_errs:
        print(f"发现 {len(all_errs)} 个问题：")
        for e in all_errs:
            print("  [x]", e)
        sys.exit(1)
    print(f"[OK] 全部通过：{len(names)} 个技能，无 BOM，frontmatter 合法，"
          f"引用脚本齐全，shell 脚本换行正确。")


if __name__ == "__main__":
    main()

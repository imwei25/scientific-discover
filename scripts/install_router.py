#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把顶层主控 AGENTS.md 镜像到**项目根**的 CLAUDE.md，供 Claude Code 读取
（OpenCode 直接读 AGENTS.md）。用受管块（marker）包裹，可反复运行：
已有块就原地替换、无块就追加，**保留用户在 CLAUDE.md 里的其它内容**。

只写传入的目标路径（安装脚本传项目根的 CLAUDE.md）——
**绝不写机器全局 ~/.claude/CLAUDE.md**，否则会在无关项目里触发本套件的路由铁律。

用法：  python install_router.py <src: AGENTS.md> <dest: 项目根/CLAUDE.md>
"""
import os
import sys

BEGIN = "<!-- BEGIN sci-skill router (auto-managed) -->"
END = "<!-- END sci-skill router (auto-managed) -->"


def main(argv):
    if len(argv) != 3:
        sys.exit("用法: python install_router.py <src AGENTS.md> <dest CLAUDE.md>")
    src, dest = argv[1], argv[2]
    if not os.path.isfile(src):
        sys.exit(f"找不到源文件 {src!r}（应为项目根的 AGENTS.md）")

    body = open(src, encoding="utf-8").read().strip()
    block = f"{BEGIN}\n{body}\n{END}"

    old = ""
    if os.path.isfile(dest):
        old = open(dest, encoding="utf-8").read()

    bi, ei = old.find(BEGIN), old.find(END)
    if bi >= 0 and ei >= bi:                      # 已有受管块 → 原地替换
        new = old[:bi] + block + old[ei + len(END):]
    elif old.strip():                            # 有用户内容、无块 → 追加，保留原内容
        new = old.rstrip() + "\n\n" + block + "\n"
    else:                                        # 空/不存在 → 只写块
        new = block + "\n"

    d = os.path.dirname(dest)
    if d:
        os.makedirs(d, exist_ok=True)
    with open(dest, "w", encoding="utf-8", newline="\n") as f:  # LF、无 BOM
        f.write(new)
    print(f"router -> {dest}")


if __name__ == "__main__":
    main(sys.argv)

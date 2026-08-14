#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""端到端自测：install_router.py 是否把 AGENTS.md 正确写到【项目根】CLAUDE.md，
并且**绝不碰机器全局 ~/.claude/CLAUDE.md**。纯 stdlib，跨平台。

覆盖：
  1) 项目根 CLAUDE.md 被创建，AGENTS.md 正文完整落在受管块内
  2) 无 BOM、LF 换行
  3) 幂等：连跑 3 次仍恰好一个块、内容为最新
  4) 保留用户在 CLAUDE.md 里的原有内容
  5) 全局安全：跑完后 ~/.claude/CLAUDE.md 内容零变化（证明只写项目根）
  6) 静态核查：四个安装脚本都调 install_router.py，且目标是项目根 CLAUDE.md、
     不是全局 ~/.claude/CLAUDE.md

用法：  python scripts/test_install_router.py     （退出码 0=全过）
"""
import hashlib
import os
import shutil
import subprocess
import sys
import tempfile

# Windows 控制台可能是 GBK，强制 UTF-8 输出，避免打印中文/符号时崩溃
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ROUTER = os.path.join(ROOT, "scripts", "install_router.py")
BEGIN = "<!-- BEGIN sci-skill router (auto-managed) -->"
END = "<!-- END sci-skill router (auto-managed) -->"

_passed, _failed = 0, 0


def check(cond, name, detail=""):
    global _passed, _failed
    if cond:
        _passed += 1
        print(f"[ OK ] {name}")
    else:
        _failed += 1
        print(f"[FAIL] {name}  {detail}")


def run_router(src, dest):
    """像安装脚本那样调用 install_router.py，返回 (rc, stdout+stderr)。"""
    p = subprocess.run([sys.executable, ROUTER, src, dest],
                       capture_output=True, text=True)
    return p.returncode, (p.stdout + p.stderr)


def read_bytes(path):
    return open(path, "rb").read() if os.path.isfile(path) else None


def sha(path):
    b = read_bytes(path)
    return hashlib.sha256(b).hexdigest() if b is not None else None


def main():
    if not os.path.isfile(ROUTER):
        print(f"找不到被测脚本 {ROUTER}")
        sys.exit(2)

    # 用真实的项目 AGENTS.md 当样本（没有就用占位内容）
    real_agents = os.path.join(ROOT, "AGENTS.md")
    sample = (open(real_agents, encoding="utf-8").read()
              if os.path.isfile(real_agents)
              else "# 顶层主控\n路由表在这里。\n")

    # —— 全局安全基线：先记下机器全局 ~/.claude/CLAUDE.md 的指纹（只读，不改）——
    global_claude = os.path.join(os.path.expanduser("~"), ".claude", "CLAUDE.md")
    global_before = sha(global_claude)

    tmp = tempfile.mkdtemp(prefix="router_test_")
    try:
        proj = os.path.join(tmp, "myproject")          # 假装的“项目根”
        os.makedirs(proj)
        src = os.path.join(proj, "AGENTS.md")
        dest = os.path.join(proj, "CLAUDE.md")          # 安装脚本传的正是“项目根/CLAUDE.md”
        open(src, "w", encoding="utf-8").write(sample)

        # 1) 首次写入
        rc, out = run_router(src, dest)
        check(rc == 0, "首次运行退出码 0", out.strip())
        check(os.path.isfile(dest), "项目根 CLAUDE.md 已创建", dest)
        raw = read_bytes(dest) or b""
        text = raw.decode("utf-8", "replace")
        check(text.count(BEGIN) == 1 and text.count(END) == 1,
              "恰好一个受管块")
        body = sample.strip()
        inside = text[text.find(BEGIN) + len(BEGIN):text.find(END)].strip()
        check(inside == body, "块内正文与 AGENTS.md 完全一致")
        check(not raw.startswith(b"\xef\xbb\xbf"), "无 UTF-8 BOM")
        check(b"\r\n" not in raw, "LF 换行（无 CRLF）")

        # 2) 写在项目根，而不是别处
        check(os.path.dirname(os.path.abspath(dest)) == os.path.abspath(proj),
              "CLAUDE.md 落在项目根目录")

        # 3) 幂等：连跑 3 次，仍只有一个块、内容跟随最新 AGENTS.md
        open(src, "w", encoding="utf-8").write("# 顶层主控 v2\n新路由内容\n")
        run_router(src, dest)
        open(src, "w", encoding="utf-8").write("# 顶层主控 v3\n最终路由内容\n")
        run_router(src, dest)
        t = open(dest, encoding="utf-8").read()
        check(t.count(BEGIN) == 1 and t.count(END) == 1, "多次运行后仍只有一个块")
        check("最终路由内容" in t and "新路由内容" not in t, "块内容更新为最新版")

        # 4) 保留用户原有内容
        dest2 = os.path.join(proj, "CLAUDE_with_user.md")
        open(dest2, "w", encoding="utf-8").write("# 我的项目笔记\n务必保留我\n")
        open(src, "w", encoding="utf-8").write("路由 X\n")
        run_router(src, dest2)
        run_router(src, dest2)                          # 再跑一次确认不重复累加
        u = open(dest2, encoding="utf-8").read()
        check("务必保留我" in u, "保留了用户原有内容")
        check(u.count(BEGIN) == 1, "用户文件里也只有一个块")

        # 5) 全局安全：跑完这一切，机器全局 ~/.claude/CLAUDE.md 必须纹丝不动
        global_after = sha(global_claude)
        check(global_before == global_after,
              "机器全局 ~/.claude/CLAUDE.md 未被触碰",
              f"before={global_before} after={global_after}")

        # 6) 静态核查：四个安装脚本都用 install_router.py，且目标是项目根、非全局
        installers = ["install.ps1", "install.sh",
                      os.path.join("scripts", "setup.ps1"),
                      os.path.join("scripts", "setup.sh")]
        for rel in installers:
            p = os.path.join(ROOT, rel)
            src_txt = open(p, encoding="utf-8").read() if os.path.isfile(p) else ""
            mentions = [ln for ln in src_txt.splitlines() if "install_router.py" in ln]
            check(bool(mentions), f"{rel} 提到 install_router.py")
            # 真正的调用行 = 既有脚本名、又带目标 CLAUDE.md（排除只是错误提示里提到脚本名的行）
            calls = [ln for ln in mentions if "CLAUDE.md" in ln]
            check(bool(calls), f"{rel} 有一次带 CLAUDE.md 目标的 install_router.py 调用")
            # 目标不得落在全局 .claude/ 目录
            bad = [ln for ln in calls
                   if "/.claude/" in ln or "\\.claude\\" in ln or ".claude/CLAUDE" in ln]
            check(not bad, f"{rel} 的目标是项目根 CLAUDE.md（非全局 ~/.claude）",
                  "; ".join(bad))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    print("-" * 56)
    if _failed:
        print(f"结果：{_passed} 通过，{_failed} 失败 ✗")
        sys.exit(1)
    print(f"结果：全部 {_passed} 项通过 ✔  —— AGENTS.md 能正确写到项目根，且不碰全局 ~/.claude")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""科研项目工作区 / manifest 状态管理（供 sci-pilot 主控技能维护项目状态）。

每个课题一个 workspace/<slug>/，用 manifest.json 记录目标、流水线、每步状态与 next。
sci-pilot 靠它做到"逐步推进 + 继续上次的项目"。纯 stdlib，无依赖。

子命令：
  init    新建/初始化一个课题工作区（写 manifest + 建子目录）
  show    打印某课题 manifest（人读 + 机读）
  list    列出所有课题及其进度
  set     更新某一步的状态（并自动推进 next 指向下一个 pending 步）
  path    打印某步的产物应写到的绝对/相对路径（供各技能 --out 用）

预置流水线（--pipeline）：review / grant / paper / research，其步骤见 sci-pilot references/。

用法：
  python workspace.py init --slug sglt2i-hfpef-review --goal 系统综述 --pipeline review \
      --topic '{"P":"HFpEF","I":"SGLT2i","O":"心衰住院","lang":"zh"}'
  python workspace.py show --slug sglt2i-hfpef-review
  python workspace.py list
  python workspace.py set --slug sglt2i-hfpef-review --step literature-review --status done --out drafts/review.md --n 43
  python workspace.py path --slug sglt2i-hfpef-review --step render-pdf-doc
"""
import argparse
import json
import os
import re
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

# 工作区放在**当前工作目录**下的 workspace/（与"产出写项目根 outputs/"约定一致）。
# 这样技能即便被复制到 ~/.claude/skills 单独加载，workspace 仍落在用户当前项目里，
# 而不是技能安装目录。可用环境变量 SCI_WORKSPACE 覆盖。
WS = os.environ.get("SCI_WORKSPACE") or os.path.join(os.getcwd(), "workspace")

# 预置流水线：每步 = (技能, 默认产物相对路径)。sci-pilot 据此建骨架。
PIPELINES = {
    "review": [
        ("search-lit", "search/refs.bib"),
        ("literature-review", "drafts/review.md"),
        ("reference-check", "checks/reference_check.md"),
        ("humanize-academic", "drafts/review_humanized.md"),
        ("render-pdf-doc", "final/review.pdf"),
    ],
    "grant": [
        ("research-scan", "search/research_scan.md"),
        ("topic-selection", "drafts/topics.md"),
        ("grant-proposal", "drafts/proposal.md"),
        ("peer-review", "checks/self_review.md"),
        ("render-pdf-doc", "final/proposal.pdf"),
    ],
    "paper": [
        ("deidentify", "analysis/data_deid.csv"),
        ("clinical-stats", "analysis/table1.csv"),
        ("data-analysis", "analysis/results.md"),
        ("nature-figure", "figures/"),
        ("write-paper", "drafts/manuscript.md"),
        ("reference-check", "checks/reference_check.md"),
        ("humanize-academic", "drafts/manuscript_humanized.md"),
        ("peer-review", "checks/self_review.md"),
        ("render-docx", "final/manuscript.docx"),
    ],
    "research": [
        ("deep-research", "drafts/deep_research.md"),
        ("render-pdf-doc", "final/deep_research.pdf"),
    ],
}

SUBDIRS = ["search", "fulltext", "analysis", "figures", "drafts", "checks", "final"]


def slugify(s):
    # ASCII 化到安全字符集：去掉 / \ . 等（顺带杜绝 ../ 路径穿越），中文/空格转连字符。
    s = re.sub(r"[^\w\-]+", "-", (s or "").strip().lower(), flags=re.UNICODE)
    return re.sub(r"-+", "-", s).strip("-") or "project"


def proj_dir(slug):
    # 所有命令统一 slugify（init/set/show/path 一致），既修中文/空格 slug 找不到的问题，
    # 也让 --slug "../../x" 这类穿越尝试被 slugify 消解在 workspace/ 内。
    return os.path.join(WS, slugify(slug))


def manifest_path(slug):
    return os.path.join(proj_dir(slug), "manifest.json")


def load(slug):
    p = manifest_path(slug)
    if not os.path.isfile(p):
        sys.exit(f"找不到课题 {slug!r}（{p} 不存在）。先 init，或用 list 看现有课题。")
    with open(p, encoding="utf-8") as f:
        return json.load(f)


def save(slug, m):
    os.makedirs(proj_dir(slug), exist_ok=True)
    # 原子写：先写临时文件再 replace，写一半崩了也不会毁掉原 manifest。
    p = manifest_path(slug)
    tmp = p + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(m, f, ensure_ascii=False, indent=2)
    os.replace(tmp, p)


def recompute_next(m):
    for s in m["steps"]:
        if s["status"] in ("pending", "running"):
            m["next"] = s["skill"]
            return
    m["next"] = None  # 全部 done


def cmd_init(a):
    slug = slugify(a.slug)
    if a.pipeline not in PIPELINES:
        sys.exit(f"未知流水线 {a.pipeline!r}，可选：{', '.join(PIPELINES)}")
    # 拒绝覆盖已有课题的进度——这是 sci-pilot 断点续跑的命根子。
    if os.path.isfile(manifest_path(slug)) and not a.force:
        m0 = load(slug)
        done = sum(1 for s in m0["steps"] if s["status"] == "done")
        sys.exit(f"课题 {slug!r} 已存在（进度 {done}/{len(m0['steps'])}，next={m0['next']}）。"
                 f"续跑请直接 show/set，不要 init；确要清空重来加 --force。")
    topic = {}
    if a.topic:
        try:
            topic = json.loads(a.topic)
        except json.JSONDecodeError as e:
            sys.exit(f"--topic 不是合法 JSON：{e}")
    steps = [{"skill": sk, "status": "pending", "out": out, "n": None}
             for sk, out in PIPELINES[a.pipeline]]
    m = {"project": slug, "goal": a.goal, "pipeline": a.pipeline,
         "created": a.date or "", "topic": topic, "steps": steps, "next": None}
    recompute_next(m)
    os.makedirs(proj_dir(slug), exist_ok=True)
    for d in SUBDIRS:
        os.makedirs(os.path.join(proj_dir(slug), d), exist_ok=True)
    save(slug, m)
    print(f"已建课题工作区：{proj_dir(slug)}")
    print(f"流水线 {a.pipeline}，共 {len(steps)} 步，下一步：{m['next']}")
    _print_steps(m)


def _print_steps(m):
    mark = {"done": "[x]", "running": "[~]", "pending": "[ ]", "skipped": "[-]"}
    for i, s in enumerate(m["steps"], 1):
        cur = " ← next" if s["skill"] == m["next"] else ""
        nn = f"  (n={s['n']})" if s.get("n") else ""
        print(f"  {mark.get(s['status'],'[ ]')} {i}. {s['skill']:20} {s['out']}{nn}{cur}")


def cmd_show(a):
    m = load(a.slug)
    print(f"课题：{m['project']}  目标：{m.get('goal')}  流水线：{m['pipeline']}")
    if m.get("topic"):
        print("主题：" + json.dumps(m["topic"], ensure_ascii=False))
    _print_steps(m)
    print("next:", m["next"])
    if a.json:
        print("---JSON---")
        print(json.dumps(m, ensure_ascii=False, indent=2))


def cmd_list(a):
    if not os.path.isdir(WS):
        print("还没有任何课题工作区（workspace/ 不存在）。")
        return
    found = False
    for slug in sorted(os.listdir(WS)):
        if os.path.isfile(manifest_path(slug)):
            found = True
            m = load(slug)
            done = sum(1 for s in m["steps"] if s["status"] == "done")
            print(f"- {slug}  [{done}/{len(m['steps'])}]  目标={m.get('goal')}  next={m['next']}")
    if not found:
        print("还没有任何课题工作区。")


def cmd_set(a):
    m = load(a.slug)
    hit = False
    for s in m["steps"]:
        if s["skill"] == a.step:
            s["status"] = a.status
            if a.out:
                s["out"] = a.out
            if a.n is not None:
                s["n"] = a.n
            hit = True
            break
    if not hit:
        sys.exit(f"流水线里没有步骤 {a.step!r}。步骤：{[s['skill'] for s in m['steps']]}")
    recompute_next(m)
    save(a.slug, m)
    print(f"已更新 {a.step} → {a.status}；next：{m['next']}")


def cmd_path(a):
    m = load(a.slug)
    for s in m["steps"]:
        if s["skill"] == a.step:
            # forward slashes: works in bash and PowerShell, and matches manifest style
            print(f"workspace/{slugify(a.slug)}/{s['out']}")
            return
    sys.exit(f"流水线里没有步骤 {a.step!r}。")


def main():
    ap = argparse.ArgumentParser(description="科研项目工作区 / manifest 状态管理")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("init")
    p.add_argument("--slug", required=True)
    p.add_argument("--goal", default="")
    p.add_argument("--pipeline", required=True, choices=list(PIPELINES))
    p.add_argument("--topic", default="", help="JSON，如 '{\"P\":\"HFpEF\"}'")
    p.add_argument("--date", default="", help="创建日期(ISO)，主控传入（脚本不取系统时间）")
    p.add_argument("--force", action="store_true", help="课题已存在时清空重来（危险，会丢进度）")
    p.set_defaults(func=cmd_init)

    p = sub.add_parser("show")
    p.add_argument("--slug", required=True)
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_show)

    p = sub.add_parser("list")
    p.set_defaults(func=cmd_list)

    p = sub.add_parser("set")
    p.add_argument("--slug", required=True)
    p.add_argument("--step", required=True)
    p.add_argument("--status", required=True, choices=["pending", "running", "done", "skipped"])
    p.add_argument("--out", default="")
    p.add_argument("--n", type=int, default=None)
    p.set_defaults(func=cmd_set)

    p = sub.add_parser("path")
    p.add_argument("--slug", required=True)
    p.add_argument("--step", required=True)
    p.set_defaults(func=cmd_path)

    a = ap.parse_args()
    a.func(a)


if __name__ == "__main__":
    main()

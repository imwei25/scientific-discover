#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
综述用检索：一个或多个检索式 → 去重的证据表（供模型据此写综述）。

用法：
  python search.py "concept1" "concept2" --since 2018          # 不限条数，命中多少取多少
  python search.py "concept1" "concept2" --limit 25            # 只要前 25 条时才显式给
产出：
  evidence_table.csv   标题/年份/期刊/研究类型线索/DOI/PMID/摘要
  evidence.md          精简清单（模型写综述时读它，逐条引用）

一个会话里做多轮检索（重要）：产物默认是**固定名**，第二次跑会把第一次挤成 .bak。分主题 / 分概念
多轮检索时**每轮都带 `--tag`**，产物变成 evidence_table__<标签>.csv / evidence__<标签>.md，
互不覆盖；不带 --tag 时**也不会覆盖**——同名旧产物先改名成 evidence_table.csv.bak（已有 .bak
就 .bak2、.bak3……）让位并在 stderr 报出，但下游按固定名只读得到最新一次，所以多轮仍应带 --tag。
要把多个概念合成一次检索（AND 交集）直接把它们作为多个位置参数传给同一次调用即可。

研究类型线索：从标题/摘要里粗粒度识别 RCT / cohort / meta-analysis /
review / case report 等，方便按证据等级组织综述。不替代人工判读。

检索条数：**默认不限**（命中多少取多少，翻页到源枯竭）。命中数会打印出来（PRISMA 要记）。
只有检索式过宽（命中十万级）时才由跑飞护栏 SCI_SEARCH_MAX（默认 5000，设 0 取消）截断，
且截断一定【响亮报告】。要少取就显式 `--limit N`。
"""
import argparse
import csv
import math
import os
import re
import sys
import time

# Windows 控制台默认 GBK；强制 UTF-8，避免中文进度输出变 mojibake（agent 靠 stdout 判成败）。
if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

try:
    import requests
except ImportError:
    sys.exit("缺少 requests：请先在仓库根运行 install.ps1（Windows）/ install.sh（Linux/macOS），或让 agent 运行 env-setup 技能")

EPMC = "https://www.ebi.ac.uk/europepmc/webservices/rest/search"
_EMAIL = (os.environ.get("SCI_CONTACT_EMAIL")
          or os.environ.get("MEDSCI_CONTACT_EMAIL")
          or os.environ.get("CONTACT_EMAIL")
          or "sci-skill@users.noreply.github.com")
UA = {"User-Agent": f"sci-agent-literature-review/1.1 (mailto:{_EMAIL})"}
TIMEOUT = 30
# 每页取多少。EPMC 允许到 1000，但 resultType=core 每条都带全文摘要，1000 条一页实测能到
# 十几 MB，代理/网关那一层直接把连接掐了（RemoteDisconnected）。100 是稳的，翻页靠 cursorMark，
# 多几次请求换不掉链子。
PAGE = 100

# ---- 检索条数：默认【不限】 ----
# 不给 --limit 就一路翻页，命中多少取多少。理由：做综述的人没有"只要前 25 篇"的需求，
# 而一个默认上限会把"这个方向到底有多少文献"变成由默认值决定的假答案（旧默认 25 实测
# 把 EMPEROR-Preserved 这类里程碑 RCT 直接挤出结果集）。
# SCI_SEARCH_MAX 只是【跑飞护栏】：检索式过宽（命中十万级）时取到这么多就停下并【响亮报告】
# 截断，而不是闷头翻上半小时。设 SCI_SEARCH_MAX=0 连护栏也去掉，真·不限。
# 显式给了 --limit N 时按 N 精确取，护栏不介入。
DEFAULT_HARD_CAP = 5000


def _hard_cap():
    raw = (os.environ.get("SCI_SEARCH_MAX") or "").strip()
    if not raw:
        return DEFAULT_HARD_CAP
    try:
        v = int(raw)
    except ValueError:
        sys.stderr.write(f"⚠ SCI_SEARCH_MAX={raw!r} 不是整数，按默认 {DEFAULT_HARD_CAP} 处理\n")
        return DEFAULT_HARD_CAP
    return v if v > 0 else math.inf


# ---- 产物目录解析（8 个技能脚本统一；见 AGENTS.md §五）----
# 优先级：显式参数 > SCI_OUTPUT_DIR 环境变量 > 当前工作目录(若已在 outputs/<会话id>/ 内) > 报错中止。
# 【绝不】再默认写共享的 outputs/ 根：那里不会出现在界面"产出"侧栏，
# 且同一用户的多个会话共用一个 outputs 卷，写固定名会跨会话互相覆盖。
# 为什么必须由外部传进来：opencode 是【一个进程服务所有会话】的，
# 脚本自己读不到任何会话级上下文，只能靠主控（网关每轮注入的 preamble）用环境变量或参数告知。
def _resolve_out_dir(explicit=None):
    import os as _os, sys as _sys
    from pathlib import Path as _Path
    _cwd = _Path.cwd()
    _in_session = _cwd.parent.name == 'outputs'   # cwd 已是 outputs/<会话id>/
    if explicit:
        _p = _Path(explicit)
        # 【拦截已知的错误传法】cwd 已经是会话产物目录，却又传了以 outputs/ 开头的相对路径：
        # 那会写成 outputs/<会话id>/outputs/xxx —— 侧栏只递归一层，这是两层，
        # 这份产物在界面“产出”侧栏里【看不见】，用户会以为跑成功了却什么都没拿到。
        # 这是旧文档教出来的写法，宁可响亮报错也不要静默产出不可见的文件。
        if _in_session and not _p.is_absolute() and _p.parts and _p.parts[0] == 'outputs':
            _m = [
                '!! 产物目录参数写法有误，已中止。',
                '   你传的是： ' + str(explicit),
                '   当前工作目录已经【就是】本会话的产物目录： ' + str(_cwd),
                '   再拼 outputs/ 前缀会写成 ' + str(_cwd / _p) + '，',
                '   界面的“产出”侧栏只递归一层，再套一层的路径不会显示；且在会话产物目录里'
                '   再造一个名为 outputs 的目录，本身就说明误解了目录布局。',
                '   正确写法：直接用【裸文件名】（如 --out table1.csv），或干脆不传该参数。',
            ]
            _sys.exit(chr(10).join(_m))
        return _p
    _env = (_os.environ.get('SCI_OUTPUT_DIR') or '').strip()
    if _env:
        _e = _Path(_env)
        # 与 explicit 分支同样的拦截。这条尤其要紧：项目文档教的就是
        # `SCI_OUTPUT_DIR=outputs/<会话id>` 这个【相对】写法，而 cwd 已经是会话产物目录，
        # 解析出来就是 outputs/<会话id>/outputs/<会话id>/ —— 产物在界面上永远看不见。
        if _in_session and not _e.is_absolute() and _e.parts and _e.parts[0] == 'outputs':
            _m = [
                '!! 环境变量 SCI_OUTPUT_DIR 的写法有误，已中止。',
                '   当前值： SCI_OUTPUT_DIR=' + _env,
                '   当前工作目录已经【就是】本会话的产物目录： ' + str(_cwd),
                '   再拼 outputs/ 前缀会写成 ' + str(_cwd / _e) + '，',
                '   界面的“产出”侧栏只递归一层，再套一层的路径不会显示；且在会话产物目录里'
                '   再造一个名为 outputs 的目录，本身就说明误解了目录布局。',
                '   正确做法：不要设这个环境变量（脚本会自动认出当前目录），',
                '   或把它设成【绝对路径】。',
            ]
            _sys.exit(chr(10).join(_m))
        return _e
    if _in_session:
        return _cwd
    _msg = [
        '!! 未指定产物目录，已中止（不再默认写共享的 outputs/ 根）。',
        '   正常情况下不需要指定：每轮对话的当前工作目录就是本会话的产物目录，',
        '   直接用裸文件名即可（如 --out table1.csv）。现在会走到这里，说明当前工作目录是',
        '   ' + str(_cwd) + '，不在任何会话产物目录下。',
        '   请任选一种方式指定：',
        '     1) 先切回本会话的产物目录再跑（推荐）',
        '     2) 环境变量： SCI_OUTPUT_DIR=<会话产物目录绝对路径>',
        '     3) 显式参数： --outdir <会话产物目录绝对路径>',
        '   注意路径要用【绝对路径】或相对当前目录的正确路径，不要再拼 outputs/<会话id>：',
        '   那是旧架构的写法，现在会多套一层目录导致产物在界面上不可见。',
        '   原因：写到共享的 outputs/ 根会跨会话互相覆盖，且不出现在界面的“产出”侧栏里。',
    ]
    _sys.exit(chr(10).join(_msg))

def _resolve_out_file(explicit=None, default_name="output"):
    import sys as _sys
    from pathlib import Path as _Path
    if explicit:
        _p = _Path(explicit)
        # 同 _resolve_out_dir：cwd 已是会话产物目录时再拼 outputs/ 前缀，产物会落到
        # outputs/<会话id>/outputs/... —— 侧栏只递归一层，这是两层，用户看不见。
        if (_Path.cwd().parent.name == 'outputs' and not _p.is_absolute()
                and _p.parts and _p.parts[0] == 'outputs'):
            _m = [
                '!! 产物路径写法有误，已中止。',
                '   你传的是： ' + str(explicit),
                '   当前工作目录已经【就是】本会话的产物目录： ' + str(_Path.cwd()),
                '   再拼 outputs/ 前缀会写成 ' + str(_Path.cwd() / _p) + '，',
                '   界面的“产出”侧栏只递归一层，再套一层的路径不会显示；且在会话产物目录里'
                '   再造一个名为 outputs 的目录，本身就说明误解了目录布局。',
                '   正确写法：直接用【裸文件名】（如 --out ' + default_name + '）。',
            ]
            _sys.exit(chr(10).join(_m))
        return _p
    return _resolve_out_dir() / default_name


# --------------------------------------------------------------------------- #
# 证据表落盘路径：同一会话里跑第二次检索，不带 --tag 时旧表会被改名成 .bak 让位（绝不覆盖）
# --------------------------------------------------------------------------- #
_TAG_BAD = re.compile(r"[^0-9A-Za-z一-鿿_.-]+")


def _slug_tag(tag):
    s = _TAG_BAD.sub("-", (tag or "").strip()).strip("-._")
    return s[:40] or "run"


def _backup(path):
    """目标文件已存在就改名让位（<原名>.bak / .bak2 / .bak3 …），绝不覆盖。

    返回 (原名, 备份名) 供调用方告警；文件本来不存在则返回 None。
    """
    if not os.path.exists(path):
        return None
    cand, n = path + ".bak", 1
    while os.path.exists(cand):
        n += 1
        cand = f"{path}.bak{n}"
    os.replace(path, cand)
    return (os.path.basename(path), os.path.basename(cand))


def _out_paths(outdir, explicit=None, tag=None):
    """决定 evidence_table / evidence 的路径；同名旧产物改名成 .bak 让位，绝不覆盖。"""
    if explicit:
        p = _resolve_out_file(explicit, "evidence_table.csv")
        csv_path, md_path = str(p), str(p.with_suffix(".md"))
    elif tag:
        s = _slug_tag(tag)
        csv_path = os.path.join(outdir, f"evidence_table__{s}.csv")
        md_path = os.path.join(outdir, f"evidence__{s}.md")
    else:
        csv_path = os.path.join(outdir, "evidence_table.csv")
        md_path = os.path.join(outdir, "evidence.md")
    moved = [b for b in (_backup(csv_path), _backup(md_path)) if b]
    if moved:
        sys.stderr.write(
            "\n!! 目标文件已存在（上一次检索的产物），【没有覆盖】，先改名备份让位：\n"
            + "".join(f"   {a} → {b}\n" for a, b in moved)
            + "   同一会话里做第 2 次及以后的检索，建议直接加 --tag <短标签>\n"
              "   （写成 evidence_table__<标签>.csv / evidence__<标签>.md），"
              "或用 --out <文件名.csv> 显式指定；\n"
              "   否则下游（idea-forge / grant-proposal / zotero push）按固定名读表，\n"
              "   只会读到最后一次检索的结果，前几轮都躺在 .bak 里没人看。\n\n")
    return csv_path, md_path


def _get(url, **kw):
    """GET，对 429/503 **和网络层异常**都退避重试。

    ★ 网络层那半是补出来的（2026-08-21 三测）：原来只认状态码，`requests.get` 自己抛
      SSLError / ConnectionError 时直接往上冒 —— 实测**奠基文献补捞整趟因一次 SSL 握手失败
      全军覆没**，那一轮证据表 225 条里一篇 NEJM 都没有，前十几名全是纳米颗粒、铁死亡这类
      无关的高被引泛综述。是模型自己看表觉得不对、又补跑 5 轮才凑齐，光检索多花 20 分钟；
      要是它没自查，稿子就退回"凭记忆写引用"的老路 —— 那正是这套改动要根除的东西。
      一次握手失败换掉一趟检索，太贵了；重试三次几乎必然能过去。
    """
    kw.setdefault("headers", UA)
    kw.setdefault("timeout", TIMEOUT)
    r = None
    last_exc = None
    for attempt in range(4):
        try:
            r = requests.get(url, **kw)
        except requests.RequestException as e:      # SSL / 连接重置 / 读超时 / 分块编码错
            last_exc = e
            if attempt == 3:
                raise
            print(f"    ⚠ 网络异常（{type(e).__name__}），{2 * (attempt + 1)}s 后重试（第 {attempt + 2}/4 次）")
            time.sleep(2 * (attempt + 1))
            continue
        if r.status_code in (429, 503):
            time.sleep(2 * (attempt + 1))
            continue
        return r
    if r is None and last_exc is not None:
        raise last_exc
    return r

DESIGN = [
    ("meta-analysis", r"meta-?analysis|systematic review"),
    ("RCT", r"randomi[sz]ed|randomised controlled|double-?blind|placebo-?controlled"),
    ("cohort", r"cohort|prospective|longitudinal"),
    ("case-control", r"case-?control"),
    ("cross-sectional", r"cross-?sectional|survey"),
    ("review", r"\breview\b|narrative review"),
    ("case-report", r"case report|case series"),
    ("preclinical", r"mice|mouse|in vitro|in vivo|rat\b|cell line"),
]


def classify(text):
    t = (text or "").lower()
    for name, pat in DESIGN:
        if re.search(pat, t):
            return name
    return "other"


def classify_design(title, abstract):
    """研究体裁分类：**优先看标题的体裁声明**（标题里 "cohort study/randomized trial"
    才是作者对本文体裁的声明）；标题无体裁词才回退摘要，且摘要里的 meta/RCT 需是**自指**
    短语（"we performed a meta-analysis"）才算——否则 "a prior meta-analysis" 这种顺带提及
    会把一篇 cohort 误抬成最高等级 meta（旧版 bug：证据分级失真）。"""
    t = classify(title)
    if t != "other":
        return t
    ab = (abstract or "").lower()
    # 摘要自指的 meta/系统综述声明才算 meta
    if re.search(r"\b(we|this study|here we|the present)\b[^.]{0,40}"
                 r"(systematic review|meta-?analysis)", ab) or \
       re.search(r"(systematic review and meta-?analysis|this (systematic review|meta-?analysis))", ab):
        return "meta-analysis"
    # 回退摘要分类，但**剔除** meta（裸提及不抬级）；RCT 需 randomized+trial 同现
    a = classify(abstract)
    if a == "meta-analysis":
        return "other"
    if a == "RCT" and not re.search(r"randomi[sz]ed[^.]{0,30}(trial|study)", ab):
        return "other"
    return a


# ---- 墙钟预算（跑飞护栏之二）----
# ★ 2026-08-21 打包版实测：首轮两条并行检索【双双超时、零产物】——命中 14410 条的宽检索式
#   一路翻页，把调用方的 2 分钟超时耗光，进程被杀，那一轮什么都没写下来。
#   条数护栏（SCI_SEARCH_MAX）管不住这件事：5000 条 = 50 页，本来就要好几分钟。
#   零产物是最差的结局 —— 用户白等两分钟、模型还得猜发生了什么。有预算就一定有输出：
#   到点停下、把已取回的写出来、**响亮报告截断**，让下一步是"要不要收窄重跑"而不是"重来一次"。
DEFAULT_BUDGET_SEC = 90
_DEADLINE = None          # 当前【阶段】的截止时刻；None = 不限
_HARD_END = None          # 整次运行的截止时刻（阶段预算再怎么分也不许越过它）
_TIME_TRUNCATED = False   # 有任何一次分页因为到点而停 → 报告里必须说


def _phase(sec):
    """给接下来这个阶段划一段时间预算。

    ★ 必须分阶段，不能全局一个 deadline：实测（第一版改完就撞上）主检索一口气把 90 秒
      全吃光，后面【定向补捞】三趟各取回 0 条 —— 而定向补捞正是这次改动要解决的那件事
      （勾了 RCT 却全是综述、landmark 试验排不上来）。预算不分给它，等于没做。
    """
    global _DEADLINE
    if _HARD_END is None:
        _DEADLINE = None
        return
    _DEADLINE = min(_HARD_END, time.monotonic() + max(5, sec))


def _out_of_time():
    global _TIME_TRUNCATED
    now = time.monotonic()
    for d in (_DEADLINE, _HARD_END):
        if d is not None and now > d:
            _TIME_TRUNCATED = True
            return True
    return False


def _one_pass(query, limit, sort=None):
    """按给定排序取一批（limit 可为 math.inf = 翻到源枯竭）。

    sort=None 用 EPMC 默认顺序（实测等同按时间倒排）。"""
    out, cursor = [], "*"
    while len(out) < limit:
        if _out_of_time():
            print(f"    ⏱ 已达本次检索的时间预算，停在 {len(out)} 条（下面会报告截断）")
            break
        remaining = limit - len(out)
        params = {"query": query, "format": "json",
                  "pageSize": PAGE if remaining == math.inf else min(PAGE, remaining),
                  "cursorMark": cursor, "resultType": "core"}
        if sort:
            params["sort"] = sort
        r = _get(EPMC, params=params)
        r.raise_for_status()
        d = r.json()
        batch = d.get("resultList", {}).get("result", [])
        if not batch:
            break
        out.extend(batch)
        nxt = d.get("nextCursorMark")
        if not nxt or nxt == cursor:
            break
        cursor = nxt
        if len(out) >= PAGE:            # 多页时报进度，别让长检索看着像卡死
            print(f"    …已取 {len(out)} 条")
        time.sleep(0.34)
    return out if limit == math.inf else out[:limit]


def _hit_count(query):
    """先问一句"总共命中多少"。既决定要不要分两趟取，也是 PRISMA 要记的命中数。"""
    r = _get(EPMC, params={"query": query, "format": "json",
                           "pageSize": 1, "resultType": "idlist"})
    r.raise_for_status()
    return int(r.json().get("hitCount") or 0)


# 首屏表单勾的「纳入的研究设计」→ Europe PMC 的检索限定。
# ★ 为什么必须做这件事（2026-08-21 打包版实测）：用户认真勾了「RCT + 队列」，回来的 106 篇里
#   review 36、other 30、cohort 14、meta 12，**RCT 只有 8 篇** —— 勾选完全没有约束检索，
#   在用户眼里这个勾选框就是个摆设。
# ★ 为什么用"补捞"而不是"过滤"：把主检索直接限死在 RCT+队列，会把综述/指南这类
#   写引言与讨论必需的背景文献全挤掉。所以主检索照旧宽召回，另外【每个勾选的设计各跑一趟
#   定向检索、按被引降序取】，把该有的那类文献保证捞回来，再合并去重。
# ★ 顺带治好另一个更严重的毛病：landmark 试验普通检索排不上来（同一次实测里
#   IMbrave150 / ORIENT-32 / HIMALAYA 等八项Ⅲ期原始论文四轮主题检索一篇都没进表，
#   模型只好手写脚本逐条精确标题查回来）。定向趟按 CITED desc 取，实测第一页就是
#   IMbrave150(1345 引)、CheckMate-040、ORIENT-32 —— 领域基石自然回到表里。
DESIGN_FILTERS = {
    "rct": ('PUB_TYPE:"Randomized Controlled Trial" OR TITLE:"randomised" OR TITLE:"randomized"'
            ' OR TITLE:"phase 3" OR TITLE:"phase III"'),
    "cohort": ('PUB_TYPE:"Observational Study" OR TITLE:"cohort" OR TITLE:"prospective"'),
    "casecontrol": ('TITLE:"case-control" OR TITLE:"case control"'),
    "crosssection": ('TITLE:"cross-sectional" OR TITLE:"survey"'),
    "review": ('PUB_TYPE:"Review" OR PUB_TYPE:"Guideline" OR TITLE:"guideline" OR TITLE:"consensus"'),
    "meta": ('PUB_TYPE:"Meta-Analysis" OR TITLE:"meta-analysis" OR TITLE:"systematic review"'),
    "basic": ('TITLE:"in vitro" OR TITLE:"in vivo" OR TITLE:"mice" OR TITLE:"mouse" OR TITLE:"knockout"'),
}
# 定向趟捞回来的记录，落到证据表里应该属于哪个 design 桶（用于事后对账，不覆盖 classify_design）
DESIGN_LABEL = {"rct": "RCT", "cohort": "cohort", "casecontrol": "case-control",
                "crosssection": "cross-sectional", "review": "review",
                "meta": "meta-analysis", "basic": "preclinical"}


def design_topup(base_query, designs, since, per):
    """对每个勾选的研究设计各跑一趟【按被引降序】的定向检索，返回记录列表。"""
    out = []
    n = max(1, len(designs))
    for i, d in enumerate(designs):
        if _HARD_END is not None:                      # 每个设计各分一段，别让第一个吃光
            _phase(max(0.0, _HARD_END - time.monotonic()) / max(1, n - i))
        filt = DESIGN_FILTERS.get(d)
        if not filt:
            print(f"  ⚠ 不认识的研究设计 {d!r}（可选：{'/'.join(DESIGN_FILTERS)}），跳过")
            continue
        q = f"({base_query}) AND ({filt})"
        if since:
            q += f" AND (FIRST_PDATE:[{since}-01-01 TO 3000-12-31])"
        try:
            hits = _hit_count(q)
        except Exception:
            hits = None
        try:
            recs = _one_pass(q, per, sort="CITED desc")
        except Exception as e:
            print(f"  定向检索（{d}）失败：{e}")
            continue
        print(f"  定向检索（{d}）：命中 {hits if hits is not None else '?'} 条，按被引降序取回 {len(recs)} 条")
        out.extend(recs)
    return out


# ---- 奠基文献补捞（landmark）----
# ★ 两轮实测都栽在同一件事上：一篇 HCC 一线免疫综述，**最该引的Ⅲ期原始论文普通检索一篇都排不上来**。
#   首轮八项（IMbrave150 / ORIENT-32 / CARES-310 / HIMALAYA / CheckMate-9DW / LEAP-002 /
#   COSMIC-312 / RATIONALE-301）四轮主题检索全落空，模型只好手写 5 个脚本逐条精确标题查回来；
#   复测加了 --design 定向趟之后大部分回来了，**IMbrave150 的 NEJM 2020 原文与 9DW 的
#   Lancet 2025 原文仍然一张表都没有**，模型是凭记忆写进正文再手动核的（这正是编造 DOI 的温床）。
# 两个真因，所以要两条腿：
#   ① **被时间范围卡掉**：IMbrave150 是 2020 年的，用户选「近 5 年」就直接出局 ——
#      可它是这个方向的地基，综述不引它说不过去。→ 基石趟【不套 --since】。
#   ② **被 AND 掉**：主检索是 `HCC AND (PD-1 OR PD-L1) AND first-line` 三概念取交集，
#      而 NEJM 那篇的题录里既没有 "PD-L1" 也没有 "first-line" → 三概念一 AND 就没它了。
#      → 基石趟只用【第一个概念】（病种/领域），靠 PUB_TYPE 限定 + 被引降序保精度。
#      实测这一趟第 1-4 名：SHARP(10144)、IMbrave150 NEJM(5854)、Asia-Pacific 索拉非尼(4681)、
#      REFLECT(4299) —— 正是任何一篇该方向综述都要引的那几篇。
#   试验名趟补第三种情况：用户/模型已经知道试验叫什么，直接按名字精确捞（9DW、HIMALAYA
#   都能一击命中原始论文），省掉"凭记忆写 DOI"。
LANDMARK_TYPES = 'PUB_TYPE:"Randomized Controlled Trial" OR PUB_TYPE:"Meta-Analysis" OR PUB_TYPE:"Guideline"'
# 试验名的形状：IMbrave150 / ORIENT-32 / LEAP-002 / CARES-310 / CheckMate 9DW / RATIONALE-301
_TRIAL_RE = re.compile(r"\b([A-Za-z][A-Za-z\-]{2,15}[\-\s]?\d{2,4}[A-Za-z]{0,2})\b")


def find_trial_names(queries):
    """从检索概念里认出试验名（只在用户自己写的检索式里认，不做全网猜测）。"""
    names, seen = [], set()
    for q in queries:
        for m in _TRIAL_RE.finditer(q or ""):
            n = m.group(1).strip()
            # PD-1 / PD-L1 / IL-6 这类靶点名不是试验名
            if len(re.sub(r"[^A-Za-z]", "", n)) < 3:
                continue
            if n.lower() in seen:
                continue
            seen.add(n.lower())
            names.append(n)
    return names


def landmark_pass(base_concept, names, per_area, per_trial, failed):
    """奠基文献补捞。**一律不套 --since**（见头注①）。返回记录列表。

    `failed` 是调用方传进来的列表：哪一趟没跑成就往里记一笔 —— 这一趟失败【必须让用户和
    模型都看见】，不能只在过程输出里闪一行。见 main() 末尾那段警告的说明。
    """
    out = []
    if base_concept:
        q = f"({base_concept}) AND ({LANDMARK_TYPES})"
        try:
            recs = _one_pass(q, per_area, sort="CITED desc")
            print(f"  奠基补捞（领域基石，不限年限）：{len(recs)} 篇 —— "
                  f"只用第一个概念 {base_concept!r} + 试验/指南限定 + 被引降序")
            if not recs:
                failed.append(f"领域基石趟（{base_concept}）：一条都没取回")
            out.extend(recs)
        except Exception as e:
            print(f"  ✖ 奠基补捞（领域基石）失败：{type(e).__name__}: {e}")
            failed.append(f"领域基石趟（{base_concept}）：{type(e).__name__}")
    for n in names:
        esc = n.replace('"', "")
        got = 0
        errs = []
        for q in (f'(TITLE:"{esc}" OR ABSTRACT:"{esc}") AND ({LANDMARK_TYPES})',
                  f'TITLE:"{esc}" OR ABSTRACT:"{esc}"'):
            try:
                recs = _one_pass(q, per_trial, sort="CITED desc")
            except Exception as e:
                print(f"  ✖ 奠基补捞（试验 {n}）失败：{type(e).__name__}: {e}")
                errs.append(type(e).__name__)
                continue
            got += len(recs)
            out.extend(recs)
        if errs:
            failed.append(f"试验名「{n}」：{'/'.join(errs)}")
        elif not got:
            failed.append(f"试验名「{n}」：查无结果（名字是不是拼错了？）")
        else:
            print(f"  奠基补捞（试验名 {n}，不限年限）：取回 {got} 条候选")
    return out


def one_query(q, limit, since):
    """取回该检索式的文献。默认【不限条数】：命中多少取多少。

    只有在取不全时（显式 --limit N，或命中数超过跑飞护栏）才分两趟取：
    一趟按被引降序捞经典，一趟默认顺序捞最新 —— 保证被截断的那份仍然两头兼顾。

    ★ 为什么截断时不能只用默认顺序：EPMC 不给 sort 时按时间倒排，于是结果全是当年新文、
      cites 恒为 0，领域基石一篇都进不来（实测 25 篇里 23 篇当年、被引全 0）。医生问一个方向，
      拿回的是一堆零被引新综述，Routy/Baruch 这些必读文献不在里面。
    ★ 为什么不能只按被引降序：那会系统性偏向老文献，把近两年的进展全挤掉 —— 而"最新进展"
      恰恰是综述最要紧的部分。
    ★ 为什么这条比"结果不够好"严重：模型拿不到经典文献时会自己想办法补，实测出现过
      【凭记忆手敲 landmark DOI】，同一轮里它自述"我编造了 DOI"。把经典捞回来就消掉了这个动机。
      —— 默认不限之后这个坑基本消失（全都取回来了），但护栏截断时它照样存在，所以两趟逻辑留着。
    """
    query = q
    if since:
        query += f" AND (FIRST_PDATE:[{since}-01-01 TO 3000-12-31])"
    target = limit if (limit and limit > 0) else _hard_cap()
    try:
        hits = _hit_count(query)
        print(f"  命中 {hits} 条" + ("（全部取回）" if hits <= target else ""))
    except Exception as e:                      # 数不到就直接照 target 取，别为一次探测中断检索
        print(f"  (命中数探测失败：{e}；直接取)")
        hits = None

    if hits is not None and hits <= target:
        return _one_pass(query, math.inf if target == math.inf else target)

    half = max(1, target // 2) if target != math.inf else math.inf
    cited = _one_pass(query, half, sort="CITED desc")
    recent = _one_pass(query, target - len(cited) + half if target != math.inf else math.inf, sort=None)
    merged, seen = [], set()
    for rec in list(cited) + list(recent):          # 经典在前，同一篇只留一次
        key = (rec.get("doi") or "").lower() or (rec.get("pmid") or "") or (rec.get("title") or "")[:80].lower()
        if not key or key in seen:
            continue
        seen.add(key)
        merged.append(rec)
    merged = merged if target == math.inf else merged[:target]
    if hits is not None and hits > target:
        print(f"  ⚠ 命中 {hits} 条 > 本次上限 {target} 条，只取回 {len(merged)} 条"
              f"（一半按被引降序取经典、一半按时间取最新，避免只剩当年新文）。"
              + ("检索式偏宽，建议收窄；要全取请设环境变量 SCI_SEARCH_MAX=0。"
                 if not (limit and limit > 0) else "这是你用 --limit 指定的条数。"))
    return merged


def main():
    ap = argparse.ArgumentParser(description="综述检索 → 证据表")
    ap.add_argument("queries", nargs="+", help="一个或多个检索概念（默认 AND 合成一条聚焦检索）")
    ap.add_argument("--limit", type=int, default=0,
                    help="取多少（AND 模式=总数；--union 模式=每式）。"
                         "默认 0 = 不限，命中多少取多少；只有确实只想要前 N 篇时才给这个参数")
    ap.add_argument("--since", type=int)
    ap.add_argument("--union", action="store_true",
                    help="把多个参数各自独立检索再并集（旧行为；会掺入只命中单个概念的离题文献）")
    ap.add_argument("--outdir", default=None)
    ap.add_argument("--tag", default=None,
                    help="本次检索的短标签，产物写成 evidence_table__<标签>.csv / "
                         "evidence__<标签>.md。同一会话里第 2 次及以后的检索务必带上，"
                         "否则上一次的证据表会被挤成 .bak，手上那张就只剩最后一轮")
    ap.add_argument("--landmark", nargs="?", const="", default=None, metavar="试验名,试验名",
                    help="奠基文献补捞（默认开）：按【第一个检索概念】+ 试验/指南限定 + 被引降序"
                         "捞一趟领域基石，**不受 --since 限制**；可另给逗号分隔的试验名"
                         "（如 IMbrave150,CheckMate 9DW）逐个精确补捞。检索式里出现的试验名会自动认。")
    ap.add_argument("--no-landmark", dest="no_landmark", action="store_true",
                    help="关掉奠基文献补捞（确实只要某个时间窗内的新文时才用）")
    ap.add_argument("--landmark-topup", type=int, default=15,
                    help="领域基石那一趟取多少条（默认 15；每个试验名另取 3 条）")
    ap.add_argument("--design", default="",
                    help="首屏勾的「纳入的研究设计」，逗号分隔："
                         + "/".join(DESIGN_FILTERS)
                         + "。每一类各跑一趟【按被引降序】的定向检索并入结果，"
                           "保证勾了的类型真的在证据表里（主检索照旧宽召回，不做过滤）")
    ap.add_argument("--design-topup", type=int, default=60,
                    help="每个研究设计的定向检索取多少条（默认 60）")
    ap.add_argument("--budget-sec", type=int, default=DEFAULT_BUDGET_SEC,
                    help=f"本次检索的墙钟预算秒数（默认 {DEFAULT_BUDGET_SEC}）。到点停止翻页、"
                         "把已取回的写出来并报告截断 —— 宁可少而有产物，不要超时零产物。0=不限")
    ap.add_argument("--out", default=None,
                    help="直接指定证据表 CSV 的文件名（.md 用同一 stem）；与 --tag 二选一")
    args = ap.parse_args()
    args.outdir = str(_resolve_out_dir(args.outdir))
    os.makedirs(args.outdir, exist_ok=True)
    designs = [d.strip().lower() for d in (args.design or "").split(",") if d.strip()]
    lm_names = [n.strip() for n in (args.landmark or "").split(",") if n.strip()]
    global _HARD_END
    if args.budget_sec and args.budget_sec > 0:
        _HARD_END = time.monotonic() + args.budget_sec

    # 默认：多个概念用 AND 合成一条聚焦检索（取交集）——否则各自并集会掺入大量只命中单个
    # 概念的离题文献（实测 24 篇里 12 篇是纯 CKD 噪声）。要旧的并集行为显式加 --union。
    if len(args.queries) > 1 and not args.union:
        combined = " AND ".join(f"({q})" for q in args.queries)
        print(f"多概念 AND 合成检索式：{combined!r}（如需并集加 --union）")
        run_queries = [combined]
    else:
        run_queries = args.queries

    seen, rows = set(), []
    batches = []
    base = run_queries[0] if len(run_queries) == 1 else " AND ".join(f"({q})" for q in run_queries)
    # ★ 顺序是【奠基 → 定向 → 主检索】，不是反过来。第一版就是反过来写的，实测代价当场出现：
    #   宽检索式（命中 27919）把预算吃到只剩零头，排在后面的试验名精确补捞取回 0 条 ——
    #   而那两趟恰恰是【最便宜、最精确、最不能少】的（各一次查询、十几条结果，
    #   捞的是 IMbrave150 这种"综述不引说不过去"的地基文献）。
    #   把它们放前面，被时间预算截掉的就永远是最不精确的那一趟宽召回 —— 这个取舍才是对的。
    lm_n, lm_failed = 0, []
    if not args.no_landmark:
        if _HARD_END is not None:
            _phase(args.budget_sec * 0.25)
        names = lm_names + [n for n in find_trial_names(args.queries) if n not in lm_names]
        if names:
            print(f"  奠基补捞识别到的试验名：{'、'.join(names)}")
        lm = landmark_pass(args.queries[0], names, args.landmark_topup, 3, lm_failed)
        lm_n = len(lm)
        batches.append(("landmark", lm))
    if designs:
        if _HARD_END is not None:
            _phase(args.budget_sec * 0.25 / max(1, len(designs)))
        batches.append(("main", design_topup(base, designs, args.since, args.design_topup)))
    if _HARD_END is not None:
        _phase(max(0.0, _HARD_END - time.monotonic()))     # 剩下的全给主检索
    for q in run_queries:
        print(f"检索：{q!r}")
        try:
            batches.append(("main", one_query(q, args.limit, args.since)))
        except Exception as e:
            print(f"  (失败：{e})")
            continue
    dropped_old = 0
    for kind, recs in batches:
        for rec in recs:
            key = rec.get("doi") or rec.get("pmid") or rec.get("id")
            if not key or key in seen:
                continue
            # ★ 时间范围兜底过滤。检索式里已经带了 FIRST_PDATE 区间，但记录的 pubYear
            #   与 FIRST_PDATE 并不总是一致（电子预出版、补录），实测放进来 19 篇越界文献，
            #   而用户在首屏明确选了「近 5 年」。这里按 pubYear 再筛一道并【报告筛掉了几篇】——
            #   年份读不出来的不筛（宁可多留，不误杀）。
            # ★ 奠基文献【豁免】时间范围：它们本来就是被时间窗卡在外面的地基文献
            #   （IMbrave150 是 2020 年的，用户选「近 5 年」就出局）——好不容易捞回来，
            #   不能再被自己的兜底过滤剔掉。
            if args.since and kind != "landmark":
                y = rec.get("pubYear")
                try:
                    if y and int(y) < args.since:
                        dropped_old += 1
                        continue
                except (TypeError, ValueError):
                    pass
            seen.add(key)
            # 剥 HTML 标签（Europe PMC 摘要含 <h4>Background</h4>/<sup> 等，否则污染证据表、
            # 破坏 ground_claim 断句）。先去标签再压空白。
            abstract = re.sub(r"<[^>]+>", " ", rec.get("abstractText") or "")
            abstract = re.sub(r"\s+", " ", abstract).strip()
            title = (rec.get("title") or "").strip().rstrip(".")
            rows.append({
                "title": title,
                "year": rec.get("pubYear", ""),
                "journal": rec.get("journalInfo", {}).get("journal", {}).get("title", ""),
                "design": classify_design(title, abstract),
                "doi": rec.get("doi", ""),
                "pmid": rec.get("pmid", ""),
                "cites": rec.get("citedByCount", 0),
                "abstract": abstract,
            })

    if not rows:
        sys.exit("没有命中文献（检查检索式或网络）。")
    def _int(v):
        try:
            return int(v)
        except (TypeError, ValueError):
            return 0
    rows.sort(key=lambda x: (_int(x["year"]), _int(x["cites"])), reverse=True)

    csv_path, md_path = _out_paths(args.outdir, args.out, args.tag)
    with open(csv_path, "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["title", "year", "journal", "design",
                                          "cites", "doi", "pmid", "abstract"])
        w.writeheader()
        w.writerows(rows)

    with open(md_path, "w", encoding="utf-8") as f:
        f.write(f"# 证据清单（{len(rows)} 篇，去重后）\n\n")
        for i, r in enumerate(rows, 1):
            f.write(f"{i}. **{r['title']}** ({r['year']}, {r['journal']}) "
                    f"— *{r['design']}*, cited {r['cites']}x. DOI:{r['doi'] or 'NA'}\n")
            if r["abstract"]:
                f.write(f"   > {r['abstract'][:400]}\n")
            f.write("\n")

    from collections import Counter
    dist = Counter(r["design"] for r in rows)
    print(f"去重后 {len(rows)} 篇。研究类型分布：{dict(dist)}")
    # ---- 对账：勾了的研究设计真的捞到了吗 ----
    if designs:
        want = {DESIGN_LABEL.get(d, d) for d in designs}
        got = sum(v for k, v in dist.items() if k in want)
        share = got / max(1, len(rows))
        print(f"  勾选的研究设计（{'、'.join(sorted(want))}）在表里共 {got} 篇，占 {share:.0%}")
        thin = [w for w in sorted(want) if dist.get(w, 0) < 5]
        if thin:
            print(f"  ⚠ 其中 {'、'.join(thin)} 不足 5 篇 —— 这个方向可能本来就没有那么多该类研究，"
                  f"**如实告诉用户**，别把综述/其他类当成它们充数。")
    # ★ 奠基补捞失败必须【顶到最显眼的位置】，而且要说清后果与该怎么办。
    #   实测（三测）：那一趟因一次 SSL 握手整趟失败，脚本只在过程里闪了一行"失败"就照常
    #   写表收工 —— 于是产出的是一份**看起来很正常、实则缺了领域基石**的证据表
    #   （225 条里一篇 NEJM 都没有，前十几名是纳米颗粒、铁死亡这类无关泛综述）。
    #   那一次是模型自己看表觉得不对才补跑回来的，但**不能把稿子的可信度押在模型自查上**：
    #   它一旦没自查，就退回"凭记忆写引用"——这套改动要根除的正是这件事。
    #   所以：既在这里报，也在 stdout 的最末尾再报一次（模型最常只读结尾几行）。
    if lm_failed:
        print("\n" + "!" * 66)
        print("‼ 奠基文献补捞没跑成（" + str(len(lm_failed)) + " 趟）：" + "；".join(lm_failed))
        print("‼ 后果：这份证据表**很可能缺少本方向的原始Ⅲ期试验与指南**（它们正是靠这一趟捞回来的），"
              "而表面上看不出来——条数照样很多，只是前排会被高被引泛综述占满。")
        # 两类失败的处方不一样，别混着说 —— 指错方向的诊断我们已经吃过一次亏了
        # （refcheck 那句"正文里几乎没识别出引用标记"，真因其实是列表缺 [n] 编号）。
        if any("查无结果" not in x for x in lm_failed):
            print("‼ 怎么办（网络类失败）：把这一趟**重跑一遍**。脚本已自动重试 4 次仍不成，"
                  "多半是网络在抖，隔一会儿重跑通常就好了。")
        if any("查无结果" in x for x in lm_failed):
            print("‼ 怎么办（试验名查无结果）：多半是**名字拼错或写法不同**"
                  "（CheckMate 9DW / CheckMate-9DW、ORIENT-32 / ORIENT32 都试试），"
                  "也可能这个试验的题录里根本没出现过这个代号 —— 那就改用"
                  "「药名 + 适应证 + 期别」精确检索。")
        print("‼ 无论哪种：**绝对不要凭记忆补写这些文献的 DOI/年卷页** —— "
              "那是假引用最高发的场景（前两轮实测里模型都干过，其中一次自述「编造了 DOI」），"
              "引用核查那一步会当场把你打回来。")
        print("!" * 66 + "\n")
    if lm_n:
        old_n = sum(1 for r in rows if args.since and _int(r["year"]) and _int(r["year"]) < args.since)
        print(f"  奠基文献补捞：候选 {lm_n} 条（去重后并入上表）"
              + (f"，其中 {old_n} 篇早于你选的时间范围 —— **保留**：它们是本方向的原始Ⅲ期试验/"
                 f"领域基石，综述不引说不过去。成文时照常引用。" if old_n else ""))
    # ---- 时间范围 ----
    if args.since and dropped_old:
        print(f"  时间范围（{args.since} 年起）：另有 {dropped_old} 篇发表年份越界，已剔除。")
    if not args.since:
        yrs = [_int(r["year"]) for r in rows if _int(r["year"])]
        if yrs:
            newest = max(yrs)
            share_new = sum(1 for y in yrs if y >= newest) / len(yrs)
            print(f"  ⚠ 本次没给 --since（不限年限）：{newest} 年的文献占 {share_new:.0%}。"
                  f"首屏「参考文献时间范围」选了近 N 年的话，这一趟必须带 --since，否则那个选项等于没填。")
    # ---- 语种覆盖：这套检索源【不含】中文数据库，投中文期刊时必须当面说清 ----
    # 实测（2026-08-21）：用户明说投中文核心期刊，106 篇里中文文献 0 篇，而系统全程没提过
    # 一句"我不检索 CNKI/万方"。稿子送审第一条意见就会是"参考文献全是外文"。
    cjk = sum(1 for r in rows if re.search(r"[一-鿿]", r["title"] or ""))
    if cjk == 0:
        print("  ※ 语种：本次 0 篇中文文献。Europe PMC / PubMed **不收录 CNKI / 万方 / 维普**，"
              "中文期刊文献基本检索不到。若目标刊是中文核心，**必须当面告诉用户**："
              "中文参考文献需要他自己补（或用 zotero-library 从他本机文献库取），别让他到送审时才发现。")
    if _TIME_TRUNCATED:
        print(f"  ⚠ 本次检索**因时间预算被截断**（{args.budget_sec}s）：拿到的是已取回的部分，不是全量。"
              f"要么收窄检索式（加限定词/加 --since），要么加大 --budget-sec 重跑。"
              f"**别把这份结果当成'这个方向就这么多文献'**。")
    # 不限条数之后证据表可以是几千篇（evidence.md 上兆）。**别把它整份读进上下文**——
    # 这不是"少读点省钱"，是读了也用不了：几千条摘要会把后面写综述的空间挤没。
    if len(rows) > 300:
        print(f"⚠ 本次 {len(rows)} 篇，evidence.md 约 {os.path.getsize(md_path) // 1024} KB。"
              f"别整份读进上下文：按 design / year / cites 在 evidence_table.csv 里先筛出要用的那部分"
              f"（如只看 meta-analysis + RCT、或近 5 年被引前 100），再读那一段。"
              f"检索式过宽也是原因之一，必要时收窄后重跑。")
    print(f"已写：{csv_path}\n      {md_path}")
    if lm_failed:
        # 结尾再吼一次：长输出里模型往往只读最后几行，而这条比"已写哪两个文件"要紧得多。
        print(f"‼ 再提醒一次：本次**奠基文献补捞有 {len(lm_failed)} 趟失败**，"
              f"上表很可能缺领域基石文献。重跑那一趟再成文，别凭记忆补引用。")


if __name__ == "__main__":
    main()

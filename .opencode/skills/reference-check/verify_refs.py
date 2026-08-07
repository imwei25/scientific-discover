#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
文献真实性核查：把每条引用去 Crossref / Europe PMC 对一遍，
揪出 AI 常编的三类假引用：
  - DOI/PMID 根本不存在（FABRICATED）
  - DOI/PMID 存在但标题对不上（MISMATCH：要么引错号，要么标题是编的）
  - 只有标题、查不到匹配（NOT_FOUND：疑似虚构，需人工确认）
真实且标题吻合的记 OK。

输入（三选一）：
  --input refs.bib / refs.ris / refs.txt   （.txt 每行一条引用）
  位置参数直接给 DOI/PMID/标题： verify_refs.py 10.1038/nature12373 "some title"
输出：
  outputs/reference_check.csv   逐条结果
  outputs/reference_check.md    人读报告（按风险分组）

联网调 api.crossref.org 与 ebi.ac.uk；失败的条目标 ERROR，不中断整体。
"""
import argparse
import csv
import io
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
from difflib import SequenceMatcher

try:
    import requests
except ImportError:
    sys.exit("缺少 requests：请先在仓库根运行 install.ps1（Windows）/ install.sh（Linux/macOS），或让 agent 运行 env-setup 技能")

# Contact email for Crossref/EPMC polite pools (mailto in UA already enrolls us).
# One unified var; older names kept so an already-configured server needs no change.
_EMAIL = (os.environ.get("SCI_CONTACT_EMAIL")
          or os.environ.get("MEDSCI_CONTACT_EMAIL")
          or os.environ.get("CONTACT_EMAIL")
          or "sci-skill@users.noreply.github.com")
UA = {"User-Agent": f"sci-agent-reference-check/1.1 (mailto:{_EMAIL})"}
# Crossref calls also carry the paid Metadata Plus token when CROSSREF_PLUS_TOKEN
# is set (dedicated server pool / higher SLA); free polite pool otherwise.
CROSSREF_HEADERS = dict(UA)
if os.environ.get("CROSSREF_PLUS_TOKEN"):
    CROSSREF_HEADERS["Crossref-Plus-API-Token"] = f"Bearer {os.environ['CROSSREF_PLUS_TOKEN']}"
CROSSREF = "https://api.crossref.org/works/"
EPMC = "https://www.ebi.ac.uk/europepmc/webservices/rest/search"
TIMEOUT = 25


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


def epmc_escape(s):
    r"""Escape Europe PMC query-syntax special chars so a title with quotes/colons
    doesn't break the TITLE:"..." clause."""
    return re.sub(r'(["\\:()])', r"\\\1", s or "")

DOI_RE = re.compile(r"10\.\d{4,9}/[-._;()/:A-Za-z0-9]+", re.I)
PMID_RE = re.compile(r"\bPMID:?\s*(\d{5,9})\b", re.I)

# 撤稿检测开关（--no-retraction 关掉；离线/赶时间时用）。默认开。
RETRACTION_CHECK = True


def _get(url, **kw):
    """带退避重试的 GET：碰到 429/503 就等一会再试（api.crossref 限速常见）。"""
    kw.setdefault("headers", UA)
    kw.setdefault("timeout", TIMEOUT)
    for attempt in range(4):
        r = requests.get(url, **kw)
        if r.status_code in (429, 503):
            time.sleep(2 * (attempt + 1))
            continue
        return r
    return r


def _casefold_cmp(s):
    """比对用的大小写归一化。**只作用于比较副本**——报告里回显给用户的
    claimed_title / found_title 一律保持原文大小写，绝不被这里改动。

    用 casefold() 而不是 lower()：lower() 只做逐字符映射，遇到"一个字母折成两个"
    的情况折不动。踩到的实例：德语全大写著录按排印惯例把 ß 写成 SS，
    `GROSSE GEFÄSSE` 与库里的 `Große Gefäße` 在 lower() 下归一成
    'grosse gef sse' vs 'gro e gef e'，相似度只有 0.80 —— 一条完全正确的引用
    被判成 CHECK（黄，会计入"可疑/存疑"条数）。casefold() 把 ß 折成 ss，
    两边归一结果完全一致 → OK。同类还有 ẞ/ﬅ/ǅ 这些特殊折叠字符。
    所有做标题比对的归一化（norm_title / _norm_for_contain）都从这里过，
    避免两条路径各自 lower 一遍、日后其中一条被改掉而另一条没跟上。
    """
    return (s or "").casefold()


def norm_title(s):
    # 保留 CJK 汉字：旧版只留 [a-z0-9]，中文标题会被剥成空串，于是两个空串
    # SequenceMatcher 判满分 1.0 —— 真·张冠李戴的两个不同中文标题会被误判 OK（漏报）。
    # 大小写与空白：先 casefold（见 _casefold_cmp），再把所有非字母数字压成单个空格，
    # 所以标题比对对**大小写和多余空白/标点都不敏感**。
    return re.sub(r"[^a-z0-9一-鿿]+", " ", _casefold_cmp(s)).strip()


def title_sim(a, b):
    na, nb = norm_title(a), norm_title(b)
    # 任一归一化后为空 → 无法比对，返回 0（绝不返回 1.0）。堵死"空串=满分"的漏报，
    # 也让 title_search 排序不会把无标题记录误当强匹配。
    if not na or not nb:
        return 0.0
    return SequenceMatcher(None, na, nb).ratio()


def compare_titles(claimed, found):
    """比对引用标题与解析出的真实标题，返回 (sim, comparable)。
    comparable=False 表示两者无法做有意义的字符串比对——① 任一为空；
    ② 跨语种（一中一西）且相似度不高：中文期刊常在 Crossref 只存英文标题，
    此时用户中文引用 vs 库内英文标题相似度≈0，若判 MISMATCH 会误伤真文献。
    这类交给人工核（CHECK），既不误伤也不放行。
    两侧一律先过 norm_title（casefold + 空白/标点折叠），所以**纯大小写差异不影响判定**：
    全大写著录、Title Case、句首大写三种写法互相比都是满分。"""
    na, nb = norm_title(claimed), norm_title(found)
    if not na or not nb:
        return 0.0, False
    sim = SequenceMatcher(None, na, nb).ratio()
    cjk_a = bool(re.search(r"[一-鿿]", na))
    cjk_b = bool(re.search(r"[一-鿿]", nb))
    if cjk_a != cjk_b and sim < 0.85:
        return sim, False
    return sim, True


def _norm_for_contain(x):
    """包含式比对用的归一化：大小写折叠、去掉所有非字母数字（含标点/空格/连字符）。
    这样 'Hepatocellular Carcinoma' 与著录里的 'Hepatocellular carcinoma.' 能对上。
    大小写折叠与 norm_title 共用 _casefold_cmp，两条比对路径不会各说各话。"""
    return re.sub(r"[^0-9a-z\u4e00-\u9fff]+", "", _casefold_cmp(x))


def _title_contained(claimed, rt):
    """真标题是否【完整出现】在引用串里。

    ★ 为什么需要这条：纯文本引用列表（refs.txt，SKILL.md 明确支持）里，每行是完整著录——
      作者 + 标题 + 刊名 + 年卷页 + DOI。extract() 拿整行当 claimed_title，再做全串相似度，
      短标题被其余部分稀释，分数暴跌 → 【全对的参考文献被判成"标题是编的"】。
      实测 8 条全真的引用 OK 0 条，其中 N Engl J Med 那条 sim 只有 0.39。
      而这个错误是随机触发的：同一份稿子，生成 refs.bib 就全对、生成 refs.txt 就全错。
    ★ 为什么不会放过张冠李戴：真正引错号时，解析回来的是【另一篇】的标题，它不会逐字出现在
      用户写的引用串里。实测那条埋雷（真 DOI 配错标题）仍被判 MISMATCH。
    """
    a, b = _norm_for_contain(rt), _norm_for_contain(claimed)
    # 太短的标题（如 "COVID-19"）容易碰巧命中，要求有足够长度才认包含
    return len(a) >= 12 and a in b


def _decide_title(claimed, rt, id_kind):
    """据(引用标题, 解析标题)给出 (verdict, sim, note)。claimed 为空=只有标识、无标题可比。"""
    if not claimed:
        # ★ 绝不能判 OK。喂进来的是裸标识符清单时，这里【一条标题都没比对过】，
        #   而「真 DOI 配错标题」正是本工具存在的意义 —— 判 OK 等于把这道闸整个关掉，
        #   且报告长得和真通过一模一样。实测放行了两条编造引用（其中一条指向「桡神经病变」），
        #   agent 据此宣布「质量闸通过」并直接排版出 Word。
        return "UNVERIFIED", 1.0, (
            "该标识真实存在，但【没有可比对的标题】——本条只验证了「这个号存在」，"
            "没有验证「这个号是不是你引用的那篇」。要查张冠李戴，请把引用标题一并给出。")
    if _title_contained(claimed, rt):
        return "OK", 1.0, "标题吻合（解析到的标题完整出现在引用著录中）"
    sim, comparable = compare_titles(claimed, rt)
    if not comparable:
        return "CHECK", round(sim, 2), \
            f"{id_kind} 存在，但标题无法自动比对（跨语种或标题缺失）——请人工核对标识与标题是否一致"
    if sim >= 0.85:
        return "OK", round(sim, 2), "标题吻合"
    if sim < 0.6:
        return "MISMATCH", round(sim, 2), \
            f"{id_kind} 存在但标题对不上(相似度{sim:.2f})——引错号或标题是编的"
    return "CHECK", round(sim, 2), f"{id_kind} 标题部分吻合(相似度{sim:.2f})，请核对"


def _epmc_by_doi(doi):
    """Europe PMC fallback for a DOI (reachable from mainland China when Crossref times out)."""
    params = {"query": f"DOI:{epmc_escape(doi)}", "format": "json", "resultType": "core", "pageSize": 1}
    r = _get(EPMC, params=params)
    r.raise_for_status()
    res = r.json().get("resultList", {}).get("result", [])
    if not res:
        return None, None
    rec = res[0]
    return rec.get("title", ""), {"journal": rec.get("journalTitle", ""), "year": rec.get("pubYear", ""),
                                  "authors": rec.get("authorString", "")}


def _crossref_retracted(msg, title):
    """Crossref 侧的撤稿信号（EPMC pubTypeList 之外的兜底）：
    ① 标题以 RETRACTED/WITHDRAWN 开头（Crossref 对撤稿文常加此前缀）；
    ② update-to 关系里含 retraction/withdrawal 类型。
    前缀判定同样走 _casefold_cmp，`RETRACTED:` / `Retracted:` / `retracted:` 一视同仁。"""
    t = _casefold_cmp(title).strip()
    if t.startswith("retracted") or t.startswith("withdrawn"):
        return True
    for u in (msg.get("update-to") or []):
        if any(k in str(u.get("type", "")).lower() for k in ("retract", "withdraw")):
            return True
    return False


def _doi_org(doi):
    """doi.org 内容协商（CSL-JSON）。作用：① 覆盖 api.crossref.org 未收的 DataCite/mEDRA DOI；
    ② 区分"DOI 号根本不存在"与"真 DOI 但库暂未索引"——后者能在此拿到真元数据，
    避免把刚见刊的真文献误判 FABRICATED（缺口3）。查不到返回 (None, None)。"""
    try:
        r = _get("https://doi.org/" + doi,
                 headers={**UA, "Accept": "application/vnd.citationstyles.csl+json"})
        if r.status_code != 200:
            return None, None
        j = r.json()
        title = j.get("title", "")
        if isinstance(title, list):
            title = title[0] if title else ""
        issued = (j.get("issued", {}) or {}).get("date-parts", [[None]])
        year = issued[0][0] if issued and issued[0] else None
        authors = ", ".join(a.get("family", "") for a in (j.get("author") or [])[:3])
        cont = j.get("container-title", "")
        if isinstance(cont, list):
            cont = cont[0] if cont else ""
        meta = {"journal": cont, "year": year, "authors": authors,
                "retracted_hint": _crossref_retracted(j, title)}
        return (title or ""), meta
    except (requests.RequestException, ValueError):
        return None, None


def resolve_doi(doi):
    """返回 (title, meta) 或 (None, None)。数据源依次：Crossref → doi.org 内容协商 → Europe PMC。
    meta 带 retracted_hint（Crossref/doi.org 侧撤稿信号，供撤稿兜底用）。"""
    doi = doi.rstrip(".,;)")
    try:
        r = _get(CROSSREF + doi, headers=CROSSREF_HEADERS)
        if r.status_code != 404:
            r.raise_for_status()
            msg = r.json()["message"]
            title = (msg.get("title") or [""])[0]
            meta = {
                "journal": (msg.get("container-title") or [""])[0],
                "year": (msg.get("issued", {}).get("date-parts", [[None]])[0][0]),
                "authors": ", ".join(a.get("family", "") for a in msg.get("author", [])[:3]),
                "retracted_hint": _crossref_retracted(msg, title),
            }
            return title, meta
        # Crossref 404：不轻信（它对慢索引的真 DOI 也会 404）。先 doi.org 确认号是否注册，再 EPMC。
    except requests.RequestException:
        pass  # Crossref 限速/不可达 —— 落到 doi.org / EPMC，而非误报 ERROR/FABRICATED
    t, m = _doi_org(doi)
    if t:
        return t, m
    return _epmc_by_doi(doi)


def resolve_pmid(pmid):
    # NO "AND SRC:MED": that filter hides real-but-not-yet-MEDLINE records
    # (ahead-of-print, PMC-only, preprints) and would mislabel a real PMID as FABRICATED.
    params = {"query": f"EXT_ID:{pmid}", "format": "json", "resultType": "core"}
    r = _get(EPMC, params=params)
    r.raise_for_status()
    res = r.json().get("resultList", {}).get("result", [])
    if not res:
        return None, None
    # Prefer the record whose external id actually equals the queried PMID.
    rec = next((x for x in res if str(x.get("pmid", "")) == str(pmid)), res[0])
    meta = {"journal": rec.get("journalTitle", ""), "year": rec.get("pubYear", ""),
            "authors": rec.get("authorString", "")}
    return rec.get("title", ""), meta


def _epmc_title_query(query, probe):
    """跑一次 Europe PMC 检索，按与 probe 的相似度取最佳匹配。"""
    params = {"query": query, "format": "json", "pageSize": 5, "resultType": "core"}
    r = _get(EPMC, params=params)
    r.raise_for_status()
    best = (None, 0.0, None)
    for rec in r.json().get("resultList", {}).get("result", []):
        s = title_sim(probe, rec.get("title", ""))
        if s > best[1]:
            best = (rec.get("title", ""), s,
                    {"journal": rec.get("journalTitle", ""), "year": rec.get("pubYear", ""),
                     "doi": rec.get("doi", ""), "pmid": rec.get("pmid", ""),
                     # ★ 必须带上作者：title-only 命中后要走 _verdict_with_meta 做首作者/年份交叉核对，
                     #   meta 里没有 authors 的话那一步等于白跑（见 verify_one 的 title 分支）。
                     "authors": rec.get("authorString", "")})
    return best


def title_search(title):
    """只有标题时，去 Europe PMC 反查是否真有这篇。返回最佳匹配 (title, sim, meta)。

    ★ 两级检索，缺一不可：
      ① 先用 TITLE:"整串" 做精确短语查 —— 命中率最高、误配最少；
      ② 精确查扑空时，换成 TITLE:(不带引号) 再查一次。
    为什么要 ②：.txt 输入（SKILL.md 明确推荐的「每行一条完整著录」）传进来的 claimed_title
    是【整行著录】（作者+标题+刊名+卷期页），拿它做短语查必然零命中 —— 于是
    **凡是没有 DOI/PMID 的引用一律被判「疑似虚构」**，而中文期刊文献和老文献大量属于这一类。
    实测：一条 100% 正确的 EMPEROR-Reduced 著录被判 NOT_FOUND，只喂裸标题却判 OK。
    一个"查真假"的工具在自己的核心功能上系统性误报，比查不出更糟。
    """
    probe = guess_title(title) or title
    best = _epmc_title_query(f'TITLE:"{epmc_escape(probe)}"', probe)
    if best[0] and best[1] >= 0.85:
        return best
    # 退一步：不加引号，只取前 12 个词（Europe PMC 对超长查询会直接零命中）
    words = re.findall(r"[\w一-鿿]+", probe)[:12]
    if words:
        loose = _epmc_title_query("TITLE:(%s)" % epmc_escape(" ".join(words)), probe)
        if loose[1] > best[1]:
            best = loose
    return best


def check_retraction(doi, pmid):
    """查一篇（已确认存在的）文献是否被撤稿 / 有勘误·编辑关注。
    去 Europe PMC 取 core 记录，看 pubTypeList 里有没有 'Retracted Publication'
    （= 这篇本身被撤稿，医学投稿引到就是硬伤），并从 commentCorrectionList
    捞出撤稿/勘误通知的出处。

    返回 (status, notice)：
      status ∈ {'retracted', 'concern', ''}；notice 是通知文献的引用串（可能为空）。
      任何异常都吞掉返回 ('', '')——撤稿检测失败绝不能拖垮整体核查。
    """
    if not RETRACTION_CHECK or not (doi or pmid):
        return "", ""
    query = f"EXT_ID:{pmid}" if pmid else f"DOI:{epmc_escape(doi)}"
    try:
        r = _get(EPMC, params={"query": query, "format": "json",
                               "resultType": "core", "pageSize": 1})
        r.raise_for_status()
        res = r.json().get("resultList", {}).get("result", [])
        if not res:
            return "", ""
        rec = res[0]
        pubtypes = [str(x).lower() for x in
                    (rec.get("pubTypeList", {}) or {}).get("pubType", []) or []]
        ccl = ((rec.get("commentCorrectionList", {}) or {})
               .get("commentCorrection", []) or [])
        # 找撤稿/勘误/表达关注通知的出处（type 如 'Retraction in' / 'Expression of concern in'）。
        def _notice(kw):
            for c in ccl:
                t = str(c.get("type", "")).lower()
                if kw in t and "in" in t:  # 'retraction in' 指向撤稿它的那篇通知
                    return c.get("reference", "") or ""
            return ""
        if "retracted publication" in pubtypes:
            return "retracted", _notice("retraction")
        # 表达关注（Expression of Concern）——未撤稿但被编辑标注，值得提示
        eoc = _notice("expression of concern") or _notice("concern")
        if eoc or any("concern" in p for p in pubtypes):
            return "concern", eoc
        return "", ""
    except Exception:
        return "", ""


def _apply_retraction(result):
    """对一条已判"存在"的核查结果补跑撤稿检测；命中就把 verdict 抬成 RETRACTED
    （撤稿是"文献真但绝不能引"的独立风险，凌驾于标题吻合与否）。就地改 result。"""
    if not RETRACTION_CHECK:
        return result
    if result.get("verdict") not in ("OK", "CHECK", "MISMATCH"):
        return result
    doi = result.get("doi") or result.get("_match_doi")
    pmid = result.get("pmid") or result.get("_match_pmid")
    status, notice = check_retraction(doi, pmid)
    # 兜底：EPMC 没标撤稿（滞后/未收录），但 Crossref/doi.org 元数据已有撤稿信号 → 仍判撤稿。
    if status != "retracted" and result.get("_retracted_hint"):
        status = "retracted"
        notice = notice or "Crossref/doi.org 元数据标注为 Retracted/Withdrawn"
    if status == "retracted":
        tail = f"；撤稿通知：{notice}" if notice else ""
        result["verdict"] = "RETRACTED"
        result["note"] = "⚠️ 该文献已被撤稿（Retracted Publication）——请勿引用，替换为未撤稿的来源" + tail \
                         + "。（原核查：" + result.get("note", "") + "）"
    elif status == "concern":
        tail = f"（{notice}）" if notice else ""
        result["note"] = result.get("note", "") + f"；⚠️ 该文献被标注'表达关注'(Expression of Concern){tail}，引用前请核实"
    return result


def _first_surname(ca):
    """从各种作者串里取【第一作者的姓】。取不出就回空串（空串 = 不做作者比对，无害）。

    ★ 必须同时吃两种写法，这是踩出来的：
      · bibtex 标准：`Finn, Richard S and Qin, Shukui`
      · **Vancouver 串**：`Finn RS, Qin S, Ikeda M, et al`  ← Europe PMC 的 authorString 就是这个
    原来的写法是"有逗号就取逗号前、否则取最后一个词"，对 Vancouver 串就变成了
    `first` = 整串、`surname` = "finn rs" —— 拿它去 authorString 里找当然永远找不到，
    于是**每一条引用都被判"首作者不符——疑似张冠李戴"**。
    实测后果：一份 31 条【全部真实、标题相似度 1.0】的参考文献被整体降级成 CHECK，
    而 CHECK 现在会打红闸 —— 等于这道闸对着一份干净稿子亮红灯。
    比"漏判"糟得多：模型看到 31/31 全红，要么谎报、要么用话术放行，两条都是明令禁止的。
    """
    if not ca:
        return ""
    first = re.split(r"\s+and\s+", ca)[0].strip()
    first = first.split(",")[0].strip()          # "Finn, Richard S"→"Finn"；"Finn RS, Qin S"→"Finn RS"
    toks = first.split()
    if not toks:
        return ""
    # 末尾是首字母缩写（RS / J / A.）就砍掉，剩下的才是姓；复姓（van der Berg）因此得以保全
    # re.I：调用方虽已 casefold，但缩写本来就该大小写不敏感地认——别让这里的判据依赖调用顺序，
    # 一旦哪天有人直接拿原文调它，`Finn RS` 的 `RS` 认不出来就会退回"每条都判首作者不符"的老 bug。
    if len(toks) > 1 and re.fullmatch(r"[a-z]{1,3}\.?", toks[-1], re.I):
        toks = toks[:-1]
    return " ".join(toks).strip()


def _author_year_flags(entry, meta):
    """Cross-check claimed first-author surname + year against the resolved record.
    Catches 'DOI is real but points to a different paper'. Returns a note fragment or ''."""
    flags = []
    cy = (entry.get("claimed_year") or "").strip()
    my = str((meta or {}).get("year") or "").strip()
    if cy and my and cy.isdigit() and my.isdigit() and abs(int(cy) - int(my)) > 1:
        flags.append(f"年份不符(引用{cy} vs 库{my})")
    # 作者串也走 _casefold_cmp（与标题同一套大小写折叠）：全大写的作者字段
    # `GROSS, PETER` 与库里的 `Gross P` 必须对上，德语姓 `WEISS` / `Weiß` 亦然，
    # 否则又是一条"纯大小写造成的首作者不符"假警报（会把 OK 降成 CHECK 打黄）。
    ca = _casefold_cmp(entry.get("claimed_authors"))
    found_auth = _casefold_cmp((meta or {}).get("authors"))
    # ★ 集体署名（协作组 / consortium / 研究者组）一律跳过作者比对。
    #   两个数据源对同一篇的作者口径【本来就不一样】，实测 Lancet 2022 那篇 SGLT2i 肾脏结局协作 meta：
    #     Europe PMC authorString = "Nuffield Department of Population Health Renal Studies Group, …"
    #     Crossref  author        = [Baigent C, Emberson J, Haynes R, …]（个人名）
    #   证据表取自 EPMC → bib 里是集体名；核查时解析到的是个人名 → 恒判"首作者不符"。
    #   而这类文献（大型协作试验组、consortium meta、指南工作组）恰恰是综述最该引的那种，
    #   一条假阳性就能把闸打红 —— 实测正是它把模型逼进了"在报告里用文字覆盖闸结论"这条路。
    #   取不出就不比对，是本函数一贯的无害路径，这里沿用。
    def _collective(s):
        return bool(re.search(r"\b(group|consortium|investigators?|collaborat\w*|trialists?|"
                              r"network|committee|society|working\s+party|study\s+group)\b", s or "", re.I)
                    or re.search(r"(协作组|研究组|工作组|课题组|学会|联盟)", s or ""))
    if ca and not _collective(ca) and not _collective(found_auth):
        surname = _first_surname(ca)
        if surname and len(surname) > 2 and found_auth and surname not in found_auth:
            flags.append(f"首作者不符(引用{surname})")
    return "；".join(flags)


def _verdict_with_meta(v, base_note, entry, meta):
    """Downgrade an otherwise-OK verdict to CHECK when author/year disagree."""
    extra = _author_year_flags(entry, meta)
    if extra and v == "OK":
        return "CHECK", base_note + "；但" + extra + "——疑似张冠李戴，请核对"
    if extra:
        return v, base_note + "；另" + extra
    return v, base_note


def _id_failed(kind, id_str, claimed, entry):
    """某个 DOI/PMID 查不到时：**按标题反查一次**。
    经常遇到"论文真实存在、但 DOI 是 AI 编造的"——直接判 FABRICATED 会冤枉真论文。
    标题查到强匹配 → ID_FAKE（真论文+假号，附上正确标识供替换）；否则才 FABRICATED。"""
    if claimed:
        ft, tsim, tmeta = title_search(claimed)
        if ft and tsim >= 0.85:
            real_doi = (tmeta or {}).get("doi") or ""
            real_pmid = (tmeta or {}).get("pmid") or ""
            correct = (f"DOI:{real_doi}" if real_doi else
                       (f"PMID:{real_pmid}" if real_pmid else "见下方匹配到的文献"))
            return dict(verdict="ID_FAKE", id=id_str, found_title=ft, sim=round(tsim, 2),
                        note=f"此 {kind} 查无（疑似 AI 伪造），但按标题查到真实文献——正确标识 {correct}；"
                             f"用正确 {kind} 替换即可", **entry)
        return dict(verdict="FABRICATED", id=id_str, found_title=ft or "", sim=round(tsim, 2),
                    note=f"{kind} 查无，且按标题也查不到匹配——疑似整条虚构，请人工确认", **entry)
    return dict(verdict="FABRICATED", id=id_str, found_title="", sim=0.0,
                note=f"{kind} 查无（不存在），且无标题可反查——请人工确认", **entry)


def verify_one(entry):
    """entry: {'raw','claimed_title','doi','pmid',...} -> 结果 dict。"""
    claimed = entry.get("claimed_title", "")
    doi, pmid = entry.get("doi"), entry.get("pmid")
    try:
        if doi:
            rt, meta = resolve_doi(doi)
            if rt is None:
                return _id_failed("DOI", f"doi:{doi}", claimed, entry)
            v, sim, note = _decide_title(claimed, rt, "DOI")
            v, note = _verdict_with_meta(v, note, entry, meta)
            return dict(verdict=v, id=f"doi:{doi}", found_title=rt, sim=sim,
                        note=note, _retracted_hint=(meta or {}).get("retracted_hint"), **entry)
        if pmid:
            rt, meta = resolve_pmid(pmid)
            if rt is None:
                return _id_failed("PMID", f"pmid:{pmid}", claimed, entry)
            v, sim, note = _decide_title(claimed, rt, "PMID")
            v, note = _verdict_with_meta(v, note, entry, meta)
            return dict(verdict=v, id=f"pmid:{pmid}", found_title=rt, sim=sim,
                        note=note, _retracted_hint=(meta or {}).get("retracted_hint"), **entry)
        # 只有标题
        if claimed:
            ft, sim, meta = title_search(claimed)
            if ft and sim >= 0.85:
                extra = f" (匹配 DOI:{meta.get('doi') or 'NA'})" if meta else ""
                # ★ 必须走 _verdict_with_meta —— DOI/PMID 两条分支都走了，唯独这条此前直接 return，
                #   于是"文献真实存在、但著录的期刊/年份是错的"被判成 OK 打绿勾。
                #   实测：.bib 里写着 Lancet 2018，查到的是 NEJM 2020，照样 OK ——
                #   用户会继续把 "Lancet 2018;392" 投出去。
                v, note = _verdict_with_meta("OK", "按标题查到真实文献" + extra, entry, meta)
                return dict(verdict=v, id="title", found_title=ft, sim=round(sim, 2),
                            note=note,
                            _match_doi=(meta or {}).get("doi") or None,
                            _match_pmid=(meta or {}).get("pmid") or None, **entry)
            # 查不到时【不再一口咬定"疑似虚构"】：没有 DOI/PMID 的引用本来就只能靠标题查，
            # 而中文期刊、老文献、会议摘要大量不在 Europe PMC 里 —— 判"虚构"是误报，
            # 而这个误报的代价是用户去删一条真实存在的文献。降级成 CHECK：说清楚是"没查到"，
            # 不是"不存在"。真·编造的条目仍会因为查不到而进人工复核清单，一条都不会漏掉。
            return dict(verdict="CHECK", id="title", found_title=ft or "",
                        sim=round(sim, 2),
                        note="没有 DOI/PMID，按标题也没查到匹配——可能是编造的，也可能只是不在检索库里"
                             "（中文期刊 / 老文献 / 会议摘要常见）。请人工确认这条是否真实存在", **entry)
        return dict(verdict="ERROR", id="", found_title="", sim=0.0,
                    note="没提取到 DOI/PMID/标题", **entry)
    except Exception as e:
        return dict(verdict="ERROR", id=doi or pmid or "", found_title="", sim=0.0,
                    note=f"查询出错：{e}", **entry)


def parse_input(path, positional):
    entries = []
    if positional:
        for tok in positional:
            entries.append(extract(tok))
        return entries
    if not path:
        return entries
    ext = os.path.splitext(path)[1].lower()
    if ext == ".bib":
        import bibtexparser
        with open(path, encoding="utf-8") as f:
            db = bibtexparser.load(f)
        for e in db.entries:
            entries.append({"raw": e.get("title", ""), "claimed_title": e.get("title", ""),
                            "doi": (e.get("doi") or "").strip() or None,
                            "pmid": (e.get("pmid") or "").strip() or None,
                            "claimed_year": (e.get("year") or "").strip() or None,
                            "claimed_authors": (e.get("author") or "").strip() or None})
    elif ext == ".ris":
        import rispy
        with open(path, encoding="utf-8") as f:
            for e in rispy.load(f):
                title = e.get("primary_title") or e.get("title", "")
                entries.append({"raw": title, "claimed_title": title,
                                "doi": (e.get("doi") or "").strip() or None,
                                "pmid": None})
    else:  # 纯文本，每行一条
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line:
                    entries.append(extract(line))
    return entries


_AUTHOR_SEG = re.compile(r"\bet\s+al\b", re.I)
_JOURNALISH = re.compile(r"\d{4}\s*[;:；，,]\s*\d+|\bdoi\b|\bPMID\b|\d+\s*[（(]\d+[)）]\s*[:：]", re.I)


def guess_title(text):
    """从一条【完整著录】里猜出标题那一段；猜不出就原样返回。

    只在检索时用来构造查询词，不改变报告里回显给用户的 claimed_title ——
    猜错了最多是多查一次，绝不能让用户看到一个被程序裁过的"他没写过的标题"。
    """
    t = (text or "").strip()
    if not t:
        return ""
    t = re.sub(r"^\s*[\[\(【]?\d{1,3}[\]\)】.、]\s*", "", t)   # 砍掉 "[1]" / "1." / "(1)" 这类序号
    segs = [s.strip() for s in re.split(r"(?<=[.．。])\s+", t) if s.strip()]
    if len(segs) <= 1:
        return t

    def is_authors(s):
        s2 = s.rstrip(".．。").strip()
        if _AUTHOR_SEG.search(s2):
            return True
        parts = [p.strip() for p in s2.split(",") if p.strip()]
        # "Packer M, Anker SD, Butler J" —— 逗号分隔，每段都是 姓 + 首字母缩写
        return len(parts) >= 2 and all(re.fullmatch(r"[^\s,]+\s+[A-Z]{1,3}", p) for p in parts)

    cands = [s for s in segs if not is_authors(s) and not _JOURNALISH.search(s)]
    if not cands:
        return t
    return max(cands, key=len).rstrip(".．。").strip()


# 年份必须靠【位置】认，不能"取最后一个四位数"。温哥华格式是 `刊名. 2019;381(21):1995-2008.`
# —— 页码在年份【之后】，于是"取最后一个"系统性地取到页码尾数。实测 8 条真实参考文献错 2 条（25%）：
#   · `N Engl J Med. 2019;381(21):1995-2008.` → 抽成 2008（页码），把一条完全正确的引用判成
#     "年份不符(引用2008 vs 库2019)——疑似张冠李戴"；
#   · `doi:10.1016/j.jacc.2007.05.014` → 抽成 2007，而那恰好等于库里那篇被引错文献的年份，
#     于是真正该报的"引用2017 vs 库2007"被静默吞掉（同一个 bug 的假阴性面）。
# 而 CHECK 现在会打红闸，一条页码造成的假 CHECK 就能让一份全真的稿件过不了闸。
# 判据：年份后面紧跟 `;卷(期):页` 或 `:` —— 在实测那 8 条上 8/8 正确。
# ★ 抽不到宁可留空：claimed_year 为空只是不做年份交叉核对（无害），抽错则直接制造假警报。
_YEAR_POS = re.compile(r"(?:^|[.;,．。]\s*|\(\s*)((?:19|20)\d{2})\s*[;:：)]")


def guess_year(text):
    """从一条著录里抽发表年份；抽不出就回空串（绝不猜）。"""
    t = re.sub(r"\bdoi\s*[:：]?\s*10\.\S+", " ", text or "", flags=re.I)   # DOI 里常含年份，先剔掉
    m = _YEAR_POS.search(t)
    return m.group(1) if m else ""


def extract(text):
    """从一行文字里抽 DOI/PMID/标题。"""
    doi = DOI_RE.search(text)
    pmid = PMID_RE.search(text)
    claimed = text
    # 若整行就是个裸标识符，则不当标题
    if doi and text.strip().rstrip(".,;)") == doi.group(0).rstrip(".,;)"):
        claimed = ""
    if pmid and re.fullmatch(r"PMID:?\s*\d+", text.strip(), re.I):
        claimed = ""
    return {"raw": text, "claimed_title": claimed,
            "claimed_year": guess_year(text),
            "doi": doi.group(0) if doi else None,
            "pmid": pmid.group(1) if pmid else None}


def _looks_like_citation(line):
    """这一行像不像一条文献著录。判据宽松：宁可放过噪声，也别把真引用挡在外面。"""
    t = (line or "").strip()
    if not t:
        return False
    if re.search(r"10\.\d{4,9}/\S+", t) or re.search(r"\bPMID\s*[:：]?\s*\d{6,}", t, re.I):
        return True          # 带 DOI/PMID 的一定算
    if re.match(r"^\s*#{1,6}\s", t) or t.startswith(">") or t.startswith("```"):
        return False         # markdown 标题 / 引用块 / 代码围栏，一定不算
    # 著录的典型特征：有年份，且有期刊/卷期/页码那一类结构
    has_year = bool(re.search(r"(19|20)\d{2}", t))
    has_struct = bool(re.search(r"\d+\s*[（(]\d+[)）]|\d+\s*:\s*\d+|;\s*\d+|et al\.?|等[\.，,]", t, re.I))
    return has_year and has_struct


def check_input_shape(entries, raw_lines):
    """输入体检：像稿件正文而不是参考文献列表时，拒跑并说清楚该喂什么。

    ★ 为什么要拒跑而不是"跑完再提示"：跑完就已经产生了十几条假「疑似虚构」，
      医生看到 `## 摘要 —— 疑似虚构` 只会认为工具坏了；而且闸会据此判红（假红）。
      白烧的 API 往返还是次要的。
    """
    n = len(entries)
    if n < 5:
        return                       # 条目少，噪声也有限，交给人眼
    good = sum(1 for ln in raw_lines if _looks_like_citation(ln))
    ratio = good / max(1, len(raw_lines))
    if ratio >= 0.5:
        return
    sys.exit(
        "!! 这份输入看起来【不是参考文献列表】：%d 行里只有 %d 行像文献著录（%.0f%%）。\n"
        "   直接跑下去，稿件的标题行和正文段落都会被当成引用去核，出一堆「查不到、疑似虚构」的假警报，\n"
        "   而真正的引用反而被淹掉。\n"
        "   请只把【参考文献部分】单独存成一个文件再喂进来，每行一条完整著录，例如：\n"
        "     [1] Villanueva A. Hepatocellular carcinoma. N Engl J Med. 2019;380(15):1450-1462. doi:10.1056/NEJMra1713263\n"
        "   .bib / .ris 也可以（会按字段解析，更准）。\n"
        "   确实要按当前输入硬跑，加 --no-shape-check。"
        % (len(raw_lines), good, ratio * 100))


def main():
    ap = argparse.ArgumentParser(description="文献真实性核查")
    ap.add_argument("ids", nargs="*", help="直接给 DOI/PMID/标题（可多个）")
    ap.add_argument("--input", help="refs.bib / refs.ris / refs.txt")
    ap.add_argument("--no-shape-check", action="store_true",
                    help="跳过输入形态体检（确实要拿整篇稿子硬跑时用）")
    ap.add_argument("--outdir", default=None)
    ap.add_argument("--no-retraction", action="store_true",
                    help="跳过撤稿检测（离线/赶时间；默认开启）")
    args = ap.parse_args()
    args.outdir = str(_resolve_out_dir(args.outdir))

    global RETRACTION_CHECK
    RETRACTION_CHECK = not args.no_retraction

    entries = parse_input(args.input, args.ids)

    # ★ 形态体检只对 .txt 有意义。它读的是【物理行】，而 .bib/.ris 的绝大多数行长这样：
    #   `  journal = {Lancet},` —— 当然不像文献著录，于是一个完全合法的 8 条目 .bib
    #   会被判成"只有 9% 的行像著录"直接 sys.exit，而它吐的错误提示里偏偏还写着"用 .bib 更准"。
    #   实测后果：agent 只好加 --no-shape-check 硬闯，等于被这条提示诱导着关掉一个真实存在的安全网。
    #   结构化格式本来就有条目数可查，不需要形态启发式。
    _ext = os.path.splitext(args.input or "")[1].lower()
    if not args.no_shape_check and _ext not in (".bib", ".ris"):

        try:

            _raw = [l for l in io.open(args.input, encoding='utf-8', errors='ignore').read().splitlines() if l.strip()]

        except Exception:

            _raw = []

        if _raw:

            check_input_shape(entries, _raw)
    if not entries:
        sys.exit("没有输入。给 --input 文件，或直接列 DOI/PMID/标题。")
    os.makedirs(args.outdir, exist_ok=True)

    print(f"核查 {len(entries)} 条 …")
    results = []
    for i, e in enumerate(entries, 1):
        r = verify_one(e)
        _apply_retraction(r)
        results.append(r)
        print(f"  [{i}/{len(entries)}] {r['verdict']:10} {(r['claimed_title'] or r['id'])[:60]}")
        time.sleep(0.2)

    # CSV
    cols = ["verdict", "sim", "claimed_title", "found_title", "id", "note", "raw"]
    with open(os.path.join(args.outdir, "reference_check.csv"), "w",
              encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=cols, extrasaction="ignore")
        w.writeheader()
        w.writerows(results)

    # Markdown 报告（按风险排序）
    order = {"RETRACTED": 0, "FABRICATED": 1, "ID_FAKE": 2, "NOT_FOUND": 3,
             "MISMATCH": 4, "CHECK": 5, "ERROR": 6, "UNVERIFIED": 7, "OK": 8}
    results.sort(key=lambda r: order.get(r["verdict"], 9))
    from collections import Counter
    dist = Counter(r["verdict"] for r in results)
    unver = dist.get("UNVERIFIED", 0)
    with open(os.path.join(args.outdir, "reference_check.md"), "w", encoding="utf-8") as f:
        f.write(f"# 文献真实性核查报告（{len(results)} 条）\n\n")
        f.write("统计：" + "，".join(f"{k} {v}" for k, v in dist.items()) + "\n\n")
        if unver:
            f.write(
                f"> ⚠️ **本次有 {unver}/{len(results)} 条只验证了标识符存在、没有比对标题**"
                "（输入里没有给出引用标题，例如喂的是裸 DOI 清单）。\n"
                "> 这意味着**查不出「真 DOI 配错标题」这类张冠李戴** —— 而那正是假引用最常见的形态。\n"
                "> **不要据此宣布「引用核查全绿 / 质量闸通过」**。要真查，请把「标题 + DOI」成对"
                "喂进来（每行一条完整著录即可）。\n\n")
        for r in results:
            f.write(f"- **{r['verdict']}** — {r['claimed_title'] or r['id']}\n")
            f.write(f"  - {r['note']}\n")
            if r["found_title"] and r["found_title"] != r["claimed_title"]:
                f.write(f"  - 实际匹配到：{r['found_title']}\n")

    # CHECK 必须计入。它现在承载两种真正要人看的情况：① 没有 DOI/PMID 且按标题没查到
    # （可能编造、也可能只是不在库里）；② 查到了但年份/首作者对不上（张冠李戴）。
    # 不计的话，一份含 2 条存疑引用的报告会在末尾打出"可疑/存疑 0 条"，把人直接劝走。
    bad = sum(dist.get(k, 0) for k in ("RETRACTED", "FABRICATED", "ID_FAKE", "NOT_FOUND", "MISMATCH", "CHECK"))
    print("-" * 50)
    print(f"结果：{dict(dist)}")
    print(f"可疑/存疑 {bad} 条。报告见 {args.outdir}/reference_check.md / .csv")
    if unver:
        print(f"!! 注意：{unver}/{len(results)} 条【只验了存在性、没比对标题】（输入没给引用标题）。"
              "这查不出「真 DOI 配错标题」，不要当成核查通过。")


if __name__ == "__main__":
    main()

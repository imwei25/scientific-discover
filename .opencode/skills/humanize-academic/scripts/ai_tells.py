#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""AI 味体检：把"读起来还像 AI"从模型自评变成机械可测的指标。

背景（别删这段，它解释了每个检测项为什么存在）：
2026-08 一份被外部 AI 检测器逐条点评的中文综述暴露了本技能的盲区——它列的七条依据里，
有四条是**能数出来**的，而当时的技能全靠模型"感觉还像不像 AI"：
  B 段落结尾句式高度重复（"这一发现提示，…"出现 8 次以上，几乎每段都以"引文+一句推论"收尾）
  D 语言平滑、句长分布均匀（low burstiness）、连接词重复
  E 结论部分"第一…第二…第三…"与"①②③④"式对仗枚举
  F 西里尔字母 и 混入中文、`underlying的`/`clinicallyrelevantSVs` 式中英夹生残留
另外两条（C 观点空泛靠类比外推、G 引文装饰性挂靠）**润色改不掉**——那是素材与引用的问题，
本脚本只把它们标成"上报项"，提醒回上游而不是把空话换个说法。

★ 定位是 signal not verdict：本脚本**不判定"这是 AI 写的"**（检测器本身就不可靠），
  它只回答"哪几段的哪个特征在统计上异常、行号在哪"，让改写有靶子、让终检有据可查。
  单文件模式恒退 0（只报告）；只有 --before/--after 闸模式才会因"改写后指标恶化"退 3。

★ 为什么必须有闸模式：B 那条同构收尾，很可能**正是"两遍改写"自己引入的**——
  模型一被要求"去 AI 味"，就爱给每段补一句点评式升华。不做前后对比，越润越同构。

用法：
  # ① 改写前定靶（改写时按报告点名的段落下手）
  python ai_tells.py manuscript_src.md
  # ② 改写后当闸（任何一项比改写前差就 FAIL，退出码 3）
  python ai_tells.py --before manuscript_src.md --after manuscript_humanized.md
  # 其他
  python ai_tells.py draft.txt --reflow            # PDF 抽出来的硬换行文本
  python ai_tells.py x.md --json tells.json        # 机读
  python ai_tells.py x.md --terms "UroVysion,EpiCheck,cfDNA"   # 术语白名单，免得误报夹生英文

输入格式自动识别三种：
  1) `[[p0007]] 正文…` 的段落清单（docx_extract.py 的产物）—— 一行一段
  2) markdown / 纯文本 —— 空行分段
  3) `--reflow` —— PDF 抽出的硬换行文本，按"短行且以句号收尾"猜段落边界（近似，会有误差）
"""
import argparse
import json
import re
import statistics
import sys
from collections import Counter, defaultdict
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

# ─────────────────────────── 词表 ───────────────────────────

# 段末"升华点评"的信号词。人类学术写作里这些不是不能用，问题在**每段都用**。
UPLIFT_WORDS = [
    "提示", "表明", "说明", "强调", "意味着", "反映出", "凸显", "揭示", "证实",
    "值得注意", "不难看出", "由此可见", "综上", "总的来说", "进一步支持", "为.{0,8}提供了",
]
UPLIFT_RE = re.compile("|".join(UPLIFT_WORDS))

# 段末点评的**引导语骨架**：句首到第一个逗号为止的那截，就是"这一发现提示，""该研究强调，"住的地方。
LEAD_SPLIT_RE = re.compile(r"[，,：:]")

# 过渡词（中文）。统计密度与"段首即过渡词"的比例。
TRANS_CN = ["然而", "此外", "同时", "因此", "并且", "而且", "另外", "与此同时",
            "值得注意的是", "综上所述", "总的来说", "首先", "其次", "再次", "最后",
            "一方面", "另一方面", "基于现有证据", "总体而言", "需要指出的是"]
TRANS_CN_RE = re.compile("|".join(TRANS_CN))
TRANS_EN = ["However", "Moreover", "Furthermore", "Additionally", "In addition",
            "Notably", "Importantly", "Overall", "In conclusion", "Therefore"]
TRANS_EN_RE = re.compile(r"\b(?:" + "|".join(TRANS_EN) + r")\b")

# 空转套话（依据 C/D 的一部分，改写时应删或换具体内容）
CLICHE_CN = [
    r"随着.{0,12}的?不断发展", r"随着.{0,12}的?日益", r"在.{0,12}的大背景下",
    r"众所周知", r"不难看出", r"具有重要的?(?:理论和?现实)?意义", r"为.{0,10}提供了新(?:的)?思路",
    r"进一步推动了", r"日益受到(?:广泛)?关注", r"已成为.{0,10}的重要研究方向",
    r"仍需(?:进一步)?(?:深入)?研究", r"尚需更多研究(?:加以)?证实",
]
CLICHE_CN_RE = re.compile("|".join(CLICHE_CN))

# 类比外推标记（依据 C）：文章没有一手材料时，AI 靠"把国外结论延伸到我国"填充论证。
EXTRAPOLATION_RE = re.compile(
    r"将(?:这|此|该)一?(?:逻辑|结论|经验|发现|结果|模式)(?:延伸|外推|应用|推广)"
    r"|(?:借鉴|参照).{0,12}(?:经验|做法)"
    r"|(?:类似地?|同理)[，,].{0,10}(?:我国|国内)"
    r"|可以(?:合理)?推测"
)

# 枚举/对仗收尾（依据 E）
ORDINAL_RE = re.compile(r"第[一二三四五六七八九十]+[，,、]")
CIRCLED_RE = re.compile(r"[①-⑳㉑-㊿]")     # ①-⑳ 及扩展
SEQ_WORDS_RE = re.compile(r"首先|其次|再次|最后|第一|第二|第三")

# 引用标记（依据 G，只报不改；与 check_invariants.py 保持一致的写法）
CITE_RE = re.compile(r"\[\d+(?:\s*[-,]\s*\d+)*\]|\([A-Z][A-Za-z\-]+(?:\s+et\s+al\.?)?,?\s*\d{4}[a-z]?\)")

# 异文字（依据 F）。希腊字母在医学里是正当的（α/β/γ/κ/λ/μ/Δ…），单列白名单；
# 西里尔字母在中文医学稿里**没有任何正当用途**，一个都不该有。
CYRILLIC_RE = re.compile(r"[Ѐ-ӿ]")
GREEK_OK = set("αβγδεζηθικλμνξοπρστυφχψωΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩ")
GREEK_RE = re.compile(r"[Ͱ-Ͽ]")
FULLWIDTH_LATIN_RE = re.compile(r"[Ａ-Ｚａ-ｚ]")
# 中英夹生：小写英文单词直接粘中文（`underlying的染色体重排`）。
# 只抓**小写起头**的普通词——全大写是缩写（DNA/FISH/PCR），本来就该原样留。
MIXED_LOWER_RE = re.compile(r"(?<![A-Za-z])[a-z]{3,}(?=[一-龥])")
MIXED_LOWER_AFTER_RE = re.compile(r"(?<=[一-龥])[a-z]{4,}(?![A-Za-z])")
# 粘连驼峰（`clinicallyrelevantSVs`）：≥14 字符且至少有一次小写→大写跳变，才算漏空格。
# 为什么不是「≥2 次跳变」：实测样例 clinicallyrelevantSVs 只有 tS 一次跳变，卡 2 次就永远抓不到。
# 为什么不抓纯小写长串：immunohistochemistry / hypermethylation / electrophoresis 都是本领域的正当长词。
# cfDNA / microRNA / UroVysion / EpiCheck 长度不够 14，天然不进这一闸。
# ★ 边界必须写成 lookaround 而不是 \b：Python 的 \w 把汉字也算词字符，
#   「该平台报告的clinicallyrelevantSVs比例」里中文与英文之间**没有** \b，
#   用 \b 时这个最典型的粘连样例一个都抓不到。
GLUE_RE = re.compile(r"(?<![A-Za-z])[A-Za-z]{14,}(?![A-Za-z])")

# 句子终止符
SENT_END = "。！？!?；;"
CJK_RE = re.compile(r"[一-龥]")


# ─────────────────────────── 切分 ───────────────────────────

PARA_ID_RE = re.compile(r"^\[\[(p\d+)\]\]\s?(.*)$")
HEADING_RE = re.compile(r"^\s*(?:#{1,6}\s|\d+(?:\.\d+)*\s+\S|摘\s*要|关键词|参考文献|References?\b|致\s*谢)")
REF_START_RE = re.compile(r"^\s*(?:#{1,6}\s*)?(?:参考文献|References?)\s*$")
IMG_RE = re.compile(r"^\s*!\[")
TABLE_RE = re.compile(r"^\s*\|")


def load_paragraphs(text, reflow=False):
    """→ [(label, 正文)]，已剔除标题行、图表行、参考文献区。label 用于报告定位。"""
    lines = text.splitlines()

    # 形态 1：docx_extract.py 的段落清单
    if sum(1 for ln in lines[:80] if PARA_ID_RE.match(ln)) >= 3:
        out = []
        for ln in lines:
            m = PARA_ID_RE.match(ln)
            if not m:
                continue
            body = m.group(2).strip()
            if body and not HEADING_RE.match(body):
                out.append((m.group(1), body))
        return out

    # 砍掉参考文献之后的一切（那里全是格式化条目，任何文体指标都没意义）
    for i, ln in enumerate(lines):
        if REF_START_RE.match(ln):
            lines = lines[:i]
            break

    if reflow:
        return _reflow(lines)

    # 形态 2：空行分段
    out, buf, start = [], [], 1
    for i, ln in enumerate(lines, 1):
        if not ln.strip():
            if buf:
                out.append((f"L{start}", " ".join(buf)))
                buf = []
            continue
        if HEADING_RE.match(ln) or IMG_RE.match(ln) or TABLE_RE.match(ln):
            if buf:
                out.append((f"L{start}", " ".join(buf)))
                buf = []
            continue
        if not buf:
            start = i
        buf.append(ln.strip())
    if buf:
        out.append((f"L{start}", " ".join(buf)))
    return [(a, b) for a, b in out if len(b) >= 20]


def _reflow(lines):
    """PDF 抽出来的硬换行文本：按'行宽'猜段落边界。近似，报告里会声明。"""
    body = [ln.rstrip() for ln in lines if ln.strip()]
    # 页眉/页脚：整份文档里重复出现 ≥3 次的短行，以及纯页码
    cnt = Counter(ln.strip() for ln in body if len(ln.strip()) <= 60)
    noise = {k for k, v in cnt.items() if v >= 3} | {k for k in cnt if k.isdigit()}
    body = [(i, ln) for i, ln in enumerate(body, 1) if ln.strip() not in noise]
    if not body:
        return []
    width = statistics.median(len(ln) for _, ln in body) or 1
    out, buf, start = [], [], body[0][0]
    for i, ln in body:
        s = ln.strip()
        if HEADING_RE.match(s):
            if buf:
                out.append((f"L{start}", "".join(buf)))
                buf = []
            continue
        if not buf:
            start = i
        # ★ 跨行拼接时，两端都是拉丁字母/数字就补一个空格。
        #   PDF 里 "Cancer Genomics\nConsortium" 直接首尾相接会拼成 GenomicsConsortium，
        #   被下面的"粘连缺空格"闸当成硬伤报出来——这是本脚本自己造的假阳性，实测踩过。
        #   中文之间不补（中文本来就不用空格），中英之间也不补（那正是要查的夹生写法）。
        if buf and s and re.match(r"[A-Za-z0-9]", s) and re.search(r"[A-Za-z0-9]$", buf[-1]):
            buf.append(" ")
        buf.append(s)
        # 段落收尾的长相：以句末标点结束，且这一行明显短于正文行宽（末行不满行）
        if s and s[-1] in SENT_END and len(s) < width * 0.9:
            out.append((f"L{start}", "".join(buf)))
            buf = []
    if buf:
        out.append((f"L{start}", "".join(buf)))
    return [(a, b) for a, b in out if len(b) >= 20]


def split_sentences(para):
    out, buf = [], []
    for ch in para:
        buf.append(ch)
        if ch in SENT_END:
            s = "".join(buf).strip()
            if s:
                out.append(s)
            buf = []
    s = "".join(buf).strip()
    if s:
        out.append(s)
    return out


def strip_noise(s):
    """去掉引用标记、数字、括注，留下句式骨架用于比对'长得一样不一样'。"""
    s = CITE_RE.sub("", s)
    s = re.sub(r"[（(][^）)]{0,40}[）)]", "", s)
    s = re.sub(r"[0-9]+(?:\.[0-9]+)?%?", "N", s)
    return s.strip()


# ─────────────────────────── 检测项 ───────────────────────────

def detect(text, terms=(), reflow=False):
    paras = load_paragraphs(text, reflow=reflow)
    n_para = len(paras)
    sents = []                       # [(label, 句)]
    for lab, p in paras:
        for s in split_sentences(p):
            sents.append((lab, s))
    n_sent = len(sents)
    # ★ 字符类 / 词表类检测只扫**正文段落**，不扫参考文献与标题：
    #   文献条目里的 "2026;16(1):25" 全是外文与半角符号，扫进来会把整份报告淹掉，
    #   而那里本来就不归润色管（引用是硬约束、一个字不许动）。
    body = "\n".join(p for _, p in paras)
    n_chars = len(CJK_RE.findall(body)) + len(re.findall(r"[A-Za-z]+", body))
    kchars = max(n_chars, 1) / 1000.0

    R = {"stats": {"paragraphs": n_para, "sentences": n_sent, "chars": n_chars},
         "findings": {}}
    if n_para == 0:
        return R

    # ── B1 段末引导语模板重复 ──────────────────────────────
    lead_hits = defaultdict(list)
    for lab, p in paras:
        ss = split_sentences(p)
        if not ss:
            continue
        last = strip_noise(ss[-1])
        lead = LEAD_SPLIT_RE.split(last, 1)[0]
        lead = re.sub(r"^[\s、；;]*", "", lead)
        if 2 <= len(lead) <= 14:
            lead_hits[lead].append(lab)
    dup_leads = sorted(((k, v) for k, v in lead_hits.items() if len(v) >= 3),
                       key=lambda x: -len(x[1]))
    R["findings"]["tail_lead_repeat"] = {
        "metric": max((len(v) for _, v in dup_leads), default=0),
        "share": round(sum(len(v) for _, v in dup_leads) / n_para, 3),
        "items": [{"pattern": k, "count": len(v), "at": v[:12]} for k, v in dup_leads[:8]],
    }

    # ── B2 "每段必升华"：段末句带点评词的比例 ────────────────
    uplift = [lab for lab, p in paras
              for ss in [split_sentences(p)] if ss and UPLIFT_RE.search(ss[-1])]
    R["findings"]["uplift_ending"] = {
        "metric": round(len(uplift) / n_para, 3),
        "count": len(uplift), "at": uplift[:20],
    }

    # ── D 句长突发性 ───────────────────────────────────────
    lens = [len(s) for _, s in sents if len(s) >= 4]
    cv = (statistics.pstdev(lens) / statistics.mean(lens)) if len(lens) >= 5 and statistics.mean(lens) else 0.0
    worst = []
    for lab, p in paras:
        ls = [len(s) for s in split_sentences(p) if len(s) >= 4]
        if len(ls) >= 4 and statistics.mean(ls):
            worst.append((round(statistics.pstdev(ls) / statistics.mean(ls), 3), lab, len(ls)))
    worst.sort()
    R["findings"]["burstiness"] = {
        "metric": round(cv, 3),
        "mean_len": round(statistics.mean(lens), 1) if lens else 0,
        "flattest_paragraphs": [{"at": l, "cv": c, "sentences": n} for c, l, n in worst[:5]],
    }

    # ── D2 过渡词密度 / 段首即过渡词 ────────────────────────
    trans_n = len(TRANS_CN_RE.findall(body)) + len(TRANS_EN_RE.findall(body))
    head_trans = [lab for lab, p in paras
                  if TRANS_CN_RE.match(p.lstrip()) or TRANS_EN_RE.match(p.lstrip())]
    top_trans = Counter(TRANS_CN_RE.findall(body) + TRANS_EN_RE.findall(body)).most_common(8)
    R["findings"]["transitions"] = {
        "metric": round(trans_n / kchars, 2),          # 次 / 千字
        "paragraph_initial_share": round(len(head_trans) / n_para, 3),
        "top": [{"word": w, "count": c} for w, c in top_trans],
        "at": head_trans[:15],
    }

    # ── E 枚举/对仗收尾 ────────────────────────────────────
    enum_items = []
    for lab, p in paras:
        o, c = len(ORDINAL_RE.findall(p)), len(CIRCLED_RE.findall(p))
        w = len(set(SEQ_WORDS_RE.findall(p)))
        # o/c ≥3 是硬对仗（第一…第三、①②③）；序列词放宽到 ≥4 才算——
        # 「首先/其次/最后」三连是正当中文学术写法，w≥3 会把它误判成 AI 腔。
        if o >= 3 or c >= 3 or w >= 4:
            enum_items.append({"at": lab, "ordinal": o, "circled": c, "seq_words": w,
                               "preview": p[:40]})
    R["findings"]["enumeration"] = {
        "metric": len(enum_items),
        "total_ordinal": len(ORDINAL_RE.findall(body)),
        "total_circled": len(CIRCLED_RE.findall(body)),
        "items": enum_items[:10],
    }

    # ── F 异文字 / 中英夹生（硬伤，一处都不该有）────────────
    tset = {t.strip().lower() for t in terms if t.strip()}
    charset = []

    def ctx(m, src):
        return src[max(0, m.start() - 14):m.end() + 14].replace("\n", " ")

    for m in CYRILLIC_RE.finditer(body):
        charset.append({"kind": "西里尔字母", "char": m.group(), "ctx": ctx(m, body)})
    notes = []
    for m in GREEK_RE.finditer(body):
        if m.group() in GREEK_OK:
            continue
        if m.group() == ";":
            # U+037E 希腊问号与半角分号不只是长得像——**它们规范等价**（NFC(U+037E)=U+003B）。
            # 所以从 PDF 抽文本时经常整篇冒出来：实测两份 pandoc→LaTeX→dvipdfmx 出的 PDF，
            # 半角 ";" 零个、U+037E 三十几个，而源文里其实全是正常分号——是 PDF 取字时
            # 在两个等价码位里挑错了那一个，不是稿子的毛病。
            # → 不计入硬伤，只作提示；真要判它，拿 .docx/.md 源文查，别拿 PDF 抽出来的文本。
            notes.append({"kind": "U+037E（与半角分号规范等价）", "ctx": ctx(m, body)})
            continue
        charset.append({"kind": "罕用希腊字母", "char": m.group(), "ctx": ctx(m, body)})
    for m in FULLWIDTH_LATIN_RE.finditer(body):
        charset.append({"kind": "全角拉丁字母", "char": m.group(), "ctx": ctx(m, body)})
    mixed = []
    for rx in (MIXED_LOWER_RE, MIXED_LOWER_AFTER_RE):
        for m in rx.finditer(body):
            if m.group().lower() in tset:
                continue
            mixed.append({"word": m.group(), "ctx": ctx(m, body)})
    glue = []
    for m in GLUE_RE.finditer(body):
        w = m.group()
        if w.lower() in tset or w.isupper() or w.islower():
            continue
        if len(re.findall(r"[a-z][A-Z]", w)) >= 1:
            glue.append({"word": w, "ctx": ctx(m, body)})
    R["findings"]["charset"] = {
        "metric": len(charset) + len(mixed) + len(glue),
        "foreign_chars": charset[:20], "mixed_words": mixed[:20], "glued_words": glue[:20],
        "notes": notes[:5], "notes_total": len(notes),
    }

    # ── 空转套话 ───────────────────────────────────────────
    cliche = [{"hit": m.group(), "ctx": ctx(m, body)} for m in CLICHE_CN_RE.finditer(body)]
    R["findings"]["cliche"] = {"metric": len(cliche), "items": cliche[:15]}

    # ── C 类比外推（上报项：润色改不掉，是素材问题）─────────
    extrap = [{"hit": m.group(), "ctx": ctx(m, body)} for m in EXTRAPOLATION_RE.finditer(body)]
    R["findings"]["extrapolation"] = {"metric": len(extrap), "report_only": True,
                                      "items": extrap[:15]}

    # ── G 引文装饰性（上报项：本技能不许动引用）─────────────
    tail_cite = sum(1 for _, s in sents if CITE_RE.search(s[-12:]))
    all_cited = [lab for lab, p in paras
                 for ss in [split_sentences(p)]
                 if len(ss) >= 3 and all(CITE_RE.search(s) for s in ss)]
    R["findings"]["citation_decor"] = {
        "metric": round(tail_cite / max(n_sent, 1), 3), "report_only": True,
        "sentences_with_tail_citation": tail_cite,
        "fully_cited_paragraphs": len(all_cited), "at": all_cited[:10],
    }
    return R


# ─────────────────────────── 判级与报告 ───────────────────────────
# 阈值来源：在真实中文医学综述上标定（见 tests/）。定得偏松——本脚本是定靶工具，
# 假阳性会让改写去改本该保留的正当表达，比漏报更贵。
# (key, 中文名, 取值方向, warn, fail, 单位说明)
RULES = [
    ("tail_lead_repeat",  "段末引导语雷同",   "high", 3,    5,    "同一句式骨架的最高出现次数"),
    ("uplift_ending",     "每段必升华",       "high", 0.40, 0.60, "段末带点评词的段落占比"),
    ("burstiness",        "句长突发性偏低",   "low",  0.42, 0.32, "句长变异系数 CV（越低越像 AI）"),
    ("transitions",       "过渡词密度",       "high", 9.0,  14.0, "次/千字"),
    ("enumeration",       "对仗枚举段",       "high", 1,    3,    "含 ≥3 项枚举的段落数"),
    ("charset",           "异文字/中英夹生",  "high", 1,    1,    "处（硬伤，一处即红）"),
    ("cliche",            "空转套话",         "high", 3,    8,    "处"),
]
REPORT_ONLY = {
    "extrapolation":  ("类比外推填充（素材问题）", "处"),
    "citation_decor": ("引文装饰性挂靠",           "句末带引文的句子占比"),
}


def grade(key, val):
    for k, name, direction, warn, fail, _ in RULES:
        if k != key:
            continue
        if direction == "high":
            return "FAIL" if val >= fail else ("WARN" if val >= warn else "OK")
        return "FAIL" if val <= fail else ("WARN" if val <= warn else "OK")
    return "OK"


def render(R, title="", show_items=True):
    L = []
    st = R["stats"]
    L.append(f"═══ AI 味体检{('：' + title) if title else ''} ═══")
    L.append(f"段落 {st['paragraphs']} · 句子 {st['sentences']} · 字数 {st['chars']}")
    if st["paragraphs"] == 0:
        L.append("[!] 没切出任何段落——检查输入格式，或对 PDF 抽出的文本加 --reflow")
        return "\n".join(L)
    L.append("")
    worst = "OK"
    for key, name, _d, warn, fail, unit in RULES:
        f = R["findings"].get(key, {})
        val = f.get("metric", 0)
        g = grade(key, val)
        if ["OK", "WARN", "FAIL"].index(g) > ["OK", "WARN", "FAIL"].index(worst):
            worst = g
        L.append(f"[{g:4}] {name:<16} {val:<8} （{unit}；warn {warn} / fail {fail}）")
        if not show_items or g == "OK":
            continue
        if key == "tail_lead_repeat":
            for it in f.get("items", [])[:5]:
                L.append(f"        「{it['pattern']}…」×{it['count']}  @ {', '.join(it['at'][:8])}")
        elif key == "uplift_ending":
            L.append(f"        {f['count']}/{st['paragraphs']} 段以点评句收尾 @ {', '.join(f['at'][:10])}")
        elif key == "burstiness":
            for it in f.get("flattest_paragraphs", [])[:3]:
                L.append(f"        最平段落 @ {it['at']}  CV={it['cv']}  {it['sentences']} 句")
        elif key == "transitions":
            L.append("        高频：" + "、".join(f"{i['word']}×{i['count']}" for i in f.get("top", [])[:6]))
            L.append(f"        段首即过渡词：{f['paragraph_initial_share']:.0%} @ {', '.join(f['at'][:8])}")
        elif key == "enumeration":
            for it in f.get("items", [])[:4]:
                L.append(f"        @ {it['at']}  第X，×{it['ordinal']} 圈码×{it['circled']}  「{it['preview']}…」")
        elif key == "charset":
            for it in f.get("foreign_chars", [])[:6]:
                L.append(f"        {it['kind']} “{it['char']}”  …{it['ctx']}…")
            for it in f.get("mixed_words", [])[:6]:
                L.append(f"        中英夹生 “{it['word']}”  …{it['ctx']}…")
            for it in f.get("glued_words", [])[:6]:
                L.append(f"        粘连缺空格 “{it['word']}”  …{it['ctx']}…")
            if f.get("notes_total"):
                L.append(f"        （另有 {f['notes_total']} 处 U+037E：与半角分号规范等价，"
                         f"多为 PDF 取字所致，不计入硬伤；要判它请拿 .docx/.md 源文查）")
        elif key == "cliche":
            for it in f.get("items", [])[:6]:
                L.append(f"        「{it['hit']}」  …{it['ctx']}…")
    L.append("")
    L.append("── 上报项（本技能改不掉，别硬改；见下方处置）──")
    for key, (name, unit) in REPORT_ONLY.items():
        f = R["findings"].get(key, {})
        L.append(f"[报告] {name:<16} {f.get('metric', 0)}   （{unit}）")
        if key == "extrapolation" and f.get("items"):
            for it in f["items"][:4]:
                L.append(f"        …{it['ctx']}…")
            L.append("        → 素材空心，不是文风问题：润色只会把空话换个说法。"
                     "回 literature-review 补一手/国内证据，或按 §二 判级铁律记 Minor 并如实告知用户。")
        if key == "citation_decor":
            L.append(f"        整段每句都挂引文的段落：{f.get('fully_cited_paragraphs', 0)} 个"
                     f" @ {', '.join(f.get('at', [])[:6])}")
            L.append("        → 引用是硬约束、本技能不许动：交给 "
                     "reference-check --manuscript 稿件.md 核对引文与论断是否真的对得上。")
    L.append("")
    L.append(f"总判：{worst}" + ("（signal not verdict：这不是'判定 AI 写的'，是告诉你该改哪几段）"
                                 if worst != "OK" else ""))
    return "\n".join(L)


def compare(before, after):
    """闸模式：任何一项比改写前差 → FAIL。专治'润色自己引入新的同构句'。"""
    L, bad = ["═══ 改写前后对比闸 ═══"], []
    for key, name, direction, _w, _f, unit in RULES:
        b = before["findings"].get(key, {}).get("metric", 0)
        a = after["findings"].get(key, {}).get("metric", 0)
        worse = (a > b) if direction == "high" else (a < b)
        # 允许一点噪声：比例类指标 0.02 以内、密度类 0.5 以内不算恶化
        tol = 0.02 if isinstance(b, float) and b <= 1 else (0.5 if key == "transitions" else 0)
        if worse and abs(a - b) <= tol:
            worse = False
        # 已经 OK 且没变差的项不必啰嗦
        tag = "变差" if worse else ("改善" if a != b else "持平")
        L.append(f"[{('FAIL' if worse else 'ok'):4}] {name:<16} {b} → {a}  {tag}  （{unit}）")
        if worse:
            bad.append(name)
    L.append("")
    if bad:
        L.append("FAIL：" + "、".join(bad) + " —— 改写把这些指标改差了，不许交付。"
                 "常见成因：为'去 AI 味'给每段补了点评式收尾，或把长句统一切成中等句。")
    else:
        L.append("PASS：没有任何指标在改写中恶化。")
    return "\n".join(L), bad


def main():
    ap = argparse.ArgumentParser(description="AI 味体检（signal not verdict）")
    ap.add_argument("file", nargs="?", help="待检文本（.md / .txt / 段落清单）")
    ap.add_argument("--before", help="改写前（闸模式）")
    ap.add_argument("--after", help="改写后（闸模式）")
    ap.add_argument("--reflow", action="store_true", help="输入是 PDF 抽出的硬换行文本")
    ap.add_argument("--terms", default="", help="术语白名单，逗号分隔（免得正当英文词被判夹生）")
    ap.add_argument("--json", dest="json_out", help="把结果写成 JSON")
    ap.add_argument("--quiet", action="store_true", help="只打分级，不列具体位置")
    a = ap.parse_args()

    terms = [t for t in a.terms.split(",") if t.strip()]

    def load(p):
        return Path(p).read_text(encoding="utf-8", errors="replace")

    if a.before and a.after:
        rb = detect(load(a.before), terms, a.reflow)
        ra = detect(load(a.after), terms, a.reflow)
        print(render(ra, title=Path(a.after).name, show_items=not a.quiet))
        print()
        txt, bad = compare(rb, ra)
        print(txt)
        if a.json_out:
            Path(a.json_out).write_text(
                json.dumps({"before": rb, "after": ra, "worsened": bad},
                           ensure_ascii=False, indent=2), encoding="utf-8")
        sys.exit(3 if bad else 0)

    if not a.file:
        ap.error("给一个文件，或用 --before/--after 跑闸模式")
    R = detect(load(a.file), terms, a.reflow)
    print(render(R, title=Path(a.file).name, show_items=not a.quiet))
    if a.json_out:
        Path(a.json_out).write_text(json.dumps(R, ensure_ascii=False, indent=2), encoding="utf-8")
    sys.exit(0)   # 单文件模式恒退 0：它是定靶工具，不是判决


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""立项依据「空洞度」体检：把"这稿子写得空"从主观感受变成可复算的信号。

标书最常见的失败不是格式错，是**立项依据退化成文献综述**——
"A 报道了…B 发现了…然而机制尚不清楚，亟待进一步阐明"。每句都没错，
评审读完却不知道哪一步卡住、为什么至今没解决、你凭什么能解决。

本脚本查五件事（判据见 references/rationale-and-innovation.md）：

  1) 空话词密度 —— "具有重要意义/亟待阐明/造福患者"这类对任何课题都成立的句子
  2) 引文承载率 —— **最硬的一条**：被引文献有多少落在"失效点/局限"语境里。
     文献在立项依据里的唯一职责是替你论证"现有解法在什么条件下失效"；
     只用来铺背景的引用就是填充物。低于阈值 = 罗列式写法。
  3) 段落落点率 —— 每段末句有没有落回本课题（"因此……故无法回答本课题的问题"）
  4) 创新点对照率 —— 每条创新点是否绑定了**别人的**对照工作与引文
     （没有对照物的"首次/填补空白"是无法证伪的断言，评审一眼看穿）
  5) 无引用强断言 —— "是关键调控因子""证明了X"却不给出处

另附 --sections：按章节统计字数占比，用于核对笔墨预算
（立项依据内部建议：痛点 10-15% / 失效分析 35-40% / 科学问题 ≤5% / 假说 25-30% / 价值 10%）。

★ signal not verdict：本脚本**只出信号、不下判决**。命中的每一条都要回读原文确认——
  正常的背景引用、领域惯用表述都可能被点名。改法是回 rationale-and-innovation.md
  对应节重写论证，**不是把"亟待阐明"换成"尚需探索"来骗过词表**（那过不了引文承载率）。

用法：
  python hollowness_check.py proposal.md
  python hollowness_check.py proposal.md --sections              # 附章节字数占比
  python hollowness_check.py proposal.md --section 立项依据       # 只体检某一节
  python hollowness_check.py proposal.md --cite-ratio 0.5        # 放宽引文承载率阈值

退出码：有信号=1，全部达标=0。
"""
import argparse
import re
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


# ---------------------------------------------------------------- 词表与正则

# 空话：对任何疾病/任何课题都成立，因而对本课题零信息量。
HOLLOW_PATTERNS = [
    (r"具有重要(?:的)?(?:科学|理论|临床|现实)?意义", "空泛意义"),
    (r"(?:重要|重大)(?:的)?(?:理论|应用|临床|社会)?价值", "空泛价值"),
    (r"亟(?:待|需)(?:解决|阐明|研究|探索|深入|明确)", "亟待式"),
    (r"尚(?:不|未)(?:清楚|明确|明晰|阐明|完全清楚)", "尚不清楚式"),
    (r"有待(?:进一步)?(?:阐明|明确|研究|探索|完善|深入)", "有待式"),
    (r"(?:进一步|深入)(?:阐明|探讨|探究|研究|揭示)", "深入探讨式"),
    (r"广阔(?:的)?(?:应用)?前景", "前景式"),
    (r"奠定(?:坚实)?(?:的)?基础", "奠定基础式"),
    (r"提供(?:了)?(?:新的)?(?:理论|科学|实验)(?:依据|基础)", "提供依据式"),
    (r"造福(?:广大)?(?:患者|人类|人民)", "造福式"),
    (r"严重(?:威胁|危害)(?:着)?(?:人类|人民|患者)?(?:的)?(?:健康|生命)", "严重威胁式"),
    (r"发病率(?:呈)?逐年(?:上升|升高|增加|增高)", "发病率逐年式"),
    (r"(?:国内外|目前)(?:尚|均)?(?:无|未见)(?:相关)?报道", "无人报道式"),
    (r"填补(?:了)?(?:国内|国际|本领域|该领域)?(?:的)?空白", "填补空白式"),
    (r"(?:国际|国内)(?:领先|一流|先进)水平", "领先式"),
    (r"突破性(?:的)?(?:进展|成果|意义)", "突破性式"),
    (r"(?:日益|越来越)(?:受到|引起)(?:广泛)?关注", "备受关注式"),
    (r"(?:成为|是)(?:当前|近年来)?(?:的)?(?:研究)?热点", "研究热点式"),
    (r"取得了(?:长足|一定|重要)(?:的)?进展", "取得进展式"),
    (r"为(?:后续|今后)(?:的)?研究(?:提供|奠定)", "推给后人式"),
]

# 失效点语境：引用落在这些词附近，才算在替你论证"现有解法为何不够"。
# 覆盖 rationale-and-innovation.md §2 的八类失配。
FAILURE_CUES = (
    r"局限|不足|缺陷|未能|无法|不能|难以|受限|仅(?:限|纳入|观察|测)|"
    r"样本量|把握度|统计效能|偏倚|混杂|选择性|替代终点|外推|推广性|"
    r"横断面|单中心|回顾性|单时点|随访(?:时间)?(?:短|不足)|"
    r"未(?:做|纳入|控制|区分|排除|检验|测量)|排除不了|无法排除|"
    r"误差|精度|重复性|解离|阴性|假阴性|失效|不适用|不成立|"
    r"相反|矛盾|不一致|争议|分歧|未(?:被)?裁决|存疑|"
    r"只(?:回答|覆盖|针对|能)|滞后|错过|等待|依赖|间接|止步|"
    r"但|然而|尽管|虽然"
)
FAILURE_RE = re.compile(FAILURE_CUES)

# 落点：段末回到本课题，而不是停在别人的工作上。
# 后半段是**指标驱动渠道**（重点研发、四大慢病重大专项）的落点形态——那里的段落落回的是
# 考核指标而非科学问题，只认"本课题"会把写得很扎实的指标型标书误判成没落点。
LANDING_RE = re.compile(
    r"因此|因而|故(?:此|该|本)?|所以|这(?:意味着|表明|提示|说明)|由此|据此|"
    r"本(?:课题|项目|研究|申请)|无法回答|不能回答|正是|从而|使得|拟(?:回答|解决|检验|突破)|"
    r"仍未(?:被)?回答|留下(?:的)?问题|综上|总之|可见|主因|归因于|"
    r"指标|指南(?:要求|方向)|兑现|达不到|未达|超出|缺口|"
    r"领跑|并跑|跟跑|本(?:技术)?路线|本方案|本创新点|被(?:推翻|否定|证伪)"
)

# 引用标记：[1] / [1,2] / (Smith, 2024) / （张三等，2020） / DOI / PMID
CITE_RES = [
    re.compile(r"\[\d+(?:\s*[-,，]\s*\d+)*\]"),
    re.compile(r"\([A-Z][A-Za-z\-']+(?:\s+(?:et\s+al\.?|and|&)\s*[A-Za-z\-']*)?[,，]?\s*\d{4}[a-z]?\)"),
    re.compile(r"[（(][一-龥A-Za-z][^（()）]{0,40}?\d{4}[a-z]?[)）]"),
    re.compile(r"10\.\d{4,9}/[-._;()/:A-Za-z0-9]+", re.I),
    re.compile(r"\bPMID:?\s*\d{5,9}\b", re.I),
]

# 强断言：说得很满，必须给出处。
STRONG_CLAIM_PATTERNS = [
    (r"首次(?:提出|发现|证实|报道|实现|建立)", "首次式"),
    (r"填补(?:了)?[^。；\n]{0,12}空白", "填补空白"),
    (r"(?:是|为)[^。；\n]{0,20}(?:的)?(?:关键|核心|决定性)(?:调控)?(?:因子|分子|靶点|环节|机制|因素)", "断言关键因子"),
    (r"起(?:到)?(?:了)?[^。；\n]{0,10}(?:关键|决定性|核心)(?:性)?作用", "断言关键作用"),
    (r"(?:证明|证实)了", "断言已证实"),
    (r"必然(?:会)?(?:导致|引起|发生)", "断言必然"),
    (r"显著优于|明显优于|远优于", "断言优于"),
    (r"(?:是|为)(?:目前)?最(?:有效|理想|可靠|准确)", "断言最优"),
]

# 创新点块的起始行
INNOV_HEAD_RE = re.compile(
    r"^\s*(?:[#>*\-\d.、]*\s*)?(?:创新点|特色与创新|创新之处|本项目的创新|Innovation)\s*[N\d一二三四五六]*\s*[:：、.]?",
    re.I,
)
# 参考文献/附录节：统计时排除（一整列引用会把承载率算穿）
SKIP_SECTION_RE = re.compile(r"参考文献|References|文献目录|附录|Appendix|代表性(?:论著|成果)", re.I)

CJK_STRIP_RE = re.compile(r"[\s*#>`|\[\]]")
SENT_SPLIT_RE = re.compile(r"(?<=[。！？；!?;])")


def norm_len(text):
    """与 SKILL.md 一致的字数口径：汉字/数字/字母/标点各算 1，只剥空白与 Markdown 标记。"""
    return len(CJK_STRIP_RE.sub("", text))


def sentences(text):
    out = []
    for line in text.splitlines():
        for s in SENT_SPLIT_RE.split(line):
            s = s.strip()
            if s:
                out.append(s)
    return out


def count_cites(s):
    return sum(len(r.findall(s)) for r in CITE_RES)


# ---------------------------------------------------------------- 文档切分

def split_sections(text):
    """按 Markdown 标题切成 [(level, title, body), ...]；无标题时整篇算一节。"""
    lines = text.splitlines()
    secs, cur = [], [0, "（全文）", []]
    for ln in lines:
        m = re.match(r"^(#{1,6})\s+(.*)$", ln)
        if m:
            secs.append((cur[0], cur[1], "\n".join(cur[2])))
            cur = [len(m.group(1)), m.group(2).strip(), []]
        else:
            cur[2].append(ln)
    secs.append((cur[0], cur[1], "\n".join(cur[2])))
    return [s for s in secs if s[2].strip() or s[0]]


def pick_section(secs, keyword):
    """取标题含 keyword 的节及其所有下级节的正文。"""
    buf, taking, lvl = [], False, 0
    for level, title, body in secs:
        if taking and level and level <= lvl:
            break
        if not taking and keyword in title:
            taking, lvl = True, level
            buf.append(body)
            continue
        if taking:
            buf.append(body)
    return "\n".join(buf) if buf else None


def analyzable_text(text):
    """剔除代码块与参考文献节，剩下的才拿去体检。"""
    text = re.sub(r"```.*?```", "", text, flags=re.S)
    kept = []
    skipping, skip_lvl = False, 0
    for level, title, body in split_sections(text):
        if skipping and level and level <= skip_lvl:
            skipping = False
        if level and SKIP_SECTION_RE.search(title):
            skipping, skip_lvl = True, level
            continue
        if not skipping:
            kept.append(body)
    return "\n".join(kept)


def paragraphs(text):
    """成段的正文块（排除标题、表格、纯列表、纯引用条目）。"""
    out = []
    for blk in re.split(r"\n\s*\n", text):
        b = blk.strip()
        if not b or b.startswith("#") or "|" in b:
            continue
        # 创新点块交给 [4] 专项查（它是要素清单不是论述段），别在落点率里重复扣分
        if INNOV_HEAD_RE.match(b.splitlines()[0]):
            continue
        if all(re.match(r"^\s*(?:[-*+]|\d+[.、)]|\[\d+\])", ln) for ln in b.splitlines() if ln.strip()):
            continue
        if norm_len(b) >= 80:
            out.append(b)
    return out


def innovation_blocks(text):
    """抓创新点块：从"创新点N/特色与创新"行起，到下一个同类行或空行分隔的下一块止。"""
    blocks, cur = [], None
    for ln in text.splitlines():
        if INNOV_HEAD_RE.match(ln):
            if cur:
                blocks.append("\n".join(cur))
            cur = [ln]
            continue
        if cur is not None:
            # 遇到新的标题行则收束（避免把后续整节都吞进来）
            if re.match(r"^#{1,6}\s+", ln):
                blocks.append("\n".join(cur))
                cur = None
                continue
            cur.append(ln)
    if cur:
        blocks.append("\n".join(cur))
    # 只保留有实质内容的块；"特色与创新"这类节标题若后面跟的是多条创新点，会被逐条切开
    return [b for b in blocks if norm_len(b) >= 20]


# ---------------------------------------------------------------- 五项检查

def check_hollow_words(text, per_k):
    hits = []
    for s in sentences(text):
        for pat, label in HOLLOW_PATTERNS:
            for m in re.finditer(pat, s):
                hits.append((label, m.group(0), s))
    n = norm_len(text) or 1
    density = len(hits) * 1000.0 / n
    ok = density <= per_k
    print(f"\n[1] 空话词密度：{len(hits)} 处 / {n} 字 = {density:.2f} 每千字"
          f"（阈值 ≤{per_k:.2f}）{'  ✅' if ok else '  ⚠️'}")
    if hits:
        seen = set()
        for label, frag, s in hits[:12]:
            key = (label, frag)
            if key in seen:
                continue
            seen.add(key)
            print(f"    - [{label}] 「{frag}」 ← {s[:60]}{'…' if len(s) > 60 else ''}")
        if len(hits) > 12:
            print(f"    …另有 {len(hits) - 12} 处")
    return ok


def check_cite_carry(text, thresh):
    """引用句 + 紧随其后的一句 一起看：真实写法常是"它做了X[n]。但该工作在⟨条件⟩下失效"，
    失效点落在下一句——只看本句会把这种正确写法误判成罗列。"""
    cited, carrying, idle = 0, 0, []
    ss = sentences(text)
    for i, s in enumerate(ss):
        if count_cites(s) == 0:
            continue
        cited += 1
        window = s + (ss[i + 1] if i + 1 < len(ss) else "")
        if FAILURE_RE.search(window):
            carrying += 1
        else:
            idle.append(s)
    if cited == 0:
        print("\n[2] 引文承载率：**全文未检出任何引用标记** ⚠️")
        print("    立项依据没有引用，等于没有论敌——现有工作的失效点无从谈起。")
        print("    （① 本稿若为无引用的初稿框架，补引用后须重跑本项；")
        print("     ② 小额表格化渠道（卫健委课题 / 院级基金）正文本就少引文献，其失效分析对标的是"
              "**本地现行做法**而非文献——此项可放宽，但 [1][4][5] 照跑不误。）")
        return False
    ratio = carrying / cited
    ok = ratio >= thresh
    print(f"\n[2] 引文承载率（五项中最硬的一条）：{carrying}/{cited} = {ratio:.0%} 的引用落在失效点语境"
          f"（阈值 ≥{thresh:.0%}）{'  ✅' if ok else '  ⚠️'}")
    if not ok:
        print("    → 低承载率 = 文献被当背景板堆着，而不是在论证"
              "「现有解法在什么条件下失效」。")
        print("    → 改法见 rationale-and-innovation.md §2 失效点分类学（八类失配），"
              "逐条把引用改写成「它做了X，在⟨条件⟩下失效，因而无法回答本课题的问题」。")
    if idle:
        print(f"    只作背景铺陈的引用句（前 6 条）：")
        for s in idle[:6]:
            print(f"    - {s[:70]}{'…' if len(s) > 70 else ''}")
    return ok


def check_landing(text, thresh):
    paras = paragraphs(text)
    if not paras:
        print("\n[3] 段落落点率：无足够长的成段正文，跳过")
        return True
    landed, missing = 0, []
    for p in paras:
        ss = sentences(p)
        tail = "".join(ss[-2:]) if len(ss) >= 2 else "".join(ss)
        if LANDING_RE.search(tail):
            landed += 1
        else:
            missing.append(ss[-1] if ss else p[:60])
    ratio = landed / len(paras)
    ok = ratio >= thresh
    print(f"\n[3] 段落落点率：{landed}/{len(paras)} = {ratio:.0%} 的段落末句落回本课题"
          f"（阈值 ≥{thresh:.0%}）{'  ✅' if ok else '  ⚠️'}")
    for s in missing[:6]:
        print(f"    - 段末停在别人的工作上：{s[:70]}{'…' if len(s) > 70 else ''}")
    return ok


def check_innovation(text):
    blocks = innovation_blocks(text)
    if not blocks:
        print("\n[4] 创新点对照率：**未检出创新点段落** ⚠️")
        print("    渠道普遍把「与现有工作比新在哪」当核心评价维；"
              "NSFC 2026 新格式要求创新点提炼进「研究内容」。")
        print("    → 按 rationale-and-innovation.md §6 的五要素格式补写。")
        return False
    bad = []
    for i, b in enumerate(blocks, 1):
        head = b.splitlines()[0].strip()
        has_cite = count_cites(b) > 0
        has_ref = "对照" in b or "相比" in b or "相较" in b or "较之" in b or "现有" in b
        missing = []
        if not (has_cite or has_ref):
            missing.append("对照物+引文")
        if not re.search(r"增量类型|方法|人群|机制层次|尺度|裁决", b):
            missing.append("增量类型")
        if not re.search(r"证伪|否定|若观察到|若未(?:能)?观察|检验", b):
            missing.append("可证伪的检验")
        if missing:
            bad.append((i, head, missing, has_cite or has_ref))
    hard_bad = [x for x in bad if not x[3]]
    ok = not hard_bad
    print(f"\n[4] 创新点对照率：检出 {len(blocks)} 条创新点，"
          f"{len(blocks) - len(hard_bad)} 条绑定了对照物"
          f"{'  ✅' if ok else '  ⚠️'}")
    for i, head, missing, _ in bad:
        print(f"    - 第{i}条「{head[:40]}」缺：{'、'.join(missing)}")
    if hard_bad:
        print("    → 无对照物的创新点是不可证伪的断言（"
              "「首次」「填补空白」离开对照物就没有意义）。")
        print("    → 对照物必须是**别人的**工作；只找得到自己团队的 = new to me 不是 new to field。")
    return ok


def check_strong_claims(text):
    bare = []
    for s in sentences(text):
        if count_cites(s) > 0:
            continue
        for pat, label in STRONG_CLAIM_PATTERNS:
            m = re.search(pat, s)
            if m:
                bare.append((label, s))
                break
    ok = not bare
    print(f"\n[5] 无引用强断言：{len(bare)} 处{'  ✅' if ok else '  ⚠️'}")
    for label, s in bare[:8]:
        print(f"    - [{label}] {s[:70]}{'…' if len(s) > 70 else ''}")
    if bare:
        print("    → 说得越满越要给出处；给不出就降级措辞或标 [待补充]（属 Minor，不阻断交付）。")
    return ok


def report_sections(text):
    secs = [(l, t, b) for l, t, b in split_sections(text) if l]
    if not secs:
        print("\n[附] 章节字数占比：文档无 Markdown 标题，跳过")
        return
    total = sum(norm_len(b) for _, _, b in secs) or 1
    print(f"\n[附] 章节字数占比（笔墨预算核对，总计 {total} 字）：")
    for level, title, body in secs:
        n = norm_len(body)
        if n == 0:
            continue
        bar = "█" * max(1, round(n * 40 / total))
        print(f"    {'  ' * (level - 1)}{title[:28]:<30} {n:>6} 字  {n / total:>5.1%}  {bar}")
    print("    立项依据内部建议：痛点 10-15% ／ **失效分析 35-40%** ／ 科学问题 ≤5% ／ 假说 25-30% ／ 价值 10%")


# ---------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser(description="立项依据空洞度体检（signal not verdict）")
    ap.add_argument("file", help="待检 Markdown 稿（如 proposal.md）")
    ap.add_argument("--section", help="只体检标题含该关键词的一节（如 立项依据）")
    ap.add_argument("--sections", action="store_true", help="附章节字数占比表")
    ap.add_argument("--hollow-per-k", type=float, default=1.5, help="空话词密度上限（每千字，默认 1.5）")
    ap.add_argument("--cite-ratio", type=float, default=0.6, help="引文承载率下限（默认 0.6）")
    ap.add_argument("--landing-ratio", type=float, default=0.6, help="段落落点率下限（默认 0.6）")
    args = ap.parse_args()

    try:
        raw = open(args.file, encoding="utf-8").read()
    except OSError as e:
        print(f"[FAIL] 读不到文件：{e}")
        sys.exit(2)

    scope = raw
    if args.section:
        picked = pick_section(split_sections(raw), args.section)
        if picked is None:
            print(f"[FAIL] 未找到标题含「{args.section}」的章节。"
                  f"去掉 --section 可体检全文。")
            sys.exit(2)
        scope = picked

    text = analyzable_text(scope)
    n = norm_len(text)
    print("=" * 66)
    print(f"立项依据空洞度体检　{args.file}"
          f"{'　[节：' + args.section + ']' if args.section else ''}　正文 {n} 字")
    print("=" * 66)
    if n < 200:
        print("[!] 正文不足 200 字，统计不稳定，结果仅供参考。")

    results = [
        check_hollow_words(text, args.hollow_per_k),
        check_cite_carry(text, args.cite_ratio),
        check_landing(text, args.landing_ratio),
        check_innovation(text),
        check_strong_claims(text),
    ]
    if args.sections:
        report_sections(scope)

    failed = results.count(False)
    print("\n" + "-" * 66)
    if failed:
        print(f"[信号] {failed}/5 项未达阈值——**这不是判决**，逐条回读原文确认。")
        print("       改法回 references/rationale-and-innovation.md 对应节重写论证；")
        print("       别只替换词面（把「亟待阐明」换成「尚需探索」过不了引文承载率这一关）。")
        sys.exit(1)
    print("[OK] 五项均达阈值。仍需人读一遍：脚本查的是论证的**形状**，不是它对不对。")


if __name__ == "__main__":
    main()

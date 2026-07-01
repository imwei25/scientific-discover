"""去 AI 味 第一步: 启发式扫描器(纯 Python, 不调 LLM, 确定性可测)。

职责: 把一份 Markdown 产出切成块, 只在"散文块"里逐句打分, 标出 AI 味较重的句子,
供前端展示"发现 N 处"并让用户决定是否交给大模型改写(改写是第二步, 见 rewrite)。

设计取向(和本项目 searchfilters 质量预筛一脉相承):
  - 只做"打分 + 提示", 不替用户强改; 阈值以上才标记。
  - 宁可漏标, 不要误伤真正的科研表达。因此:
      * 具有合法统计含义的词(显著/significant/相关/comprehensive 等)要么不收,
        要么只给"软权重"——单次出现不足以触发, 只有扎堆才标。
      * 标题/表格/代码块/参考文献链接不参与打分(那里没有 AI 腔可言)。
  - 只依赖标准库, 保持可离线单测。

对外:
  - segment_blocks(md)   → 全量块列表(prose/skip, 带精确字符偏移), 供改写按 start/end 原地拼回。
  - scan_ai_flavor(md)   → {spans, flagged_blocks, stats}。
  - stream_rewrite(md, blocks) → 异步逐块流式改写(仅改指定块), 复用 llm.stream_chat。
"""
from __future__ import annotations

import re
from typing import AsyncIterator

from .llm import stream_chat

# ── 词表 ────────────────────────────────────────────────────────────
# 权重: 强信号(明显的 AI 套话)=2, 软信号(科研里也常用、单次不足为凭)=1。
# 触发标记的分数阈值见 FLAG_THRESHOLD。

# 中文套话(强): 命中即 +2。挑的都是"填充式、几乎不承载信息"的表达。
# 刻意不收: 显著、综述、相关、具有统计学意义 等有合法学术含义的词。
_CLICHE_CN: dict[str, int] = {
    "至关重要": 2, "值得注意的是": 2, "值得一提的是": 2, "需要指出的是": 2,
    "综上所述": 2, "总而言之": 2, "总的来说": 2, "总的来看": 2,
    "不言而喻": 2, "显而易见": 2, "众所周知": 2, "由此可见": 2, "不难发现": 2,
    "深入探讨": 2, "具有重要意义": 2, "重要意义": 2, "重大意义": 2,
    "发挥着重要作用": 2, "起着重要作用": 2, "扮演着重要角色": 2,
    "不可或缺": 2, "保驾护航": 2, "日新月异": 2, "方兴未艾": 2,
    "息息相关": 2, "在当今社会": 2, "在当今": 2, "在现代社会": 2,
    "开创性": 2, "革命性": 2, "前所未有": 2, "堪称": 2,
}

# 中文空洞措辞(软→给 1, 但"值得深思/发人深省"这类纯感叹给 2)。
_HEDGE_CN: dict[str, int] = {
    "在一定程度上": 2, "某种程度上": 2, "一定程度上": 2,
    "值得深思": 2, "引人深思": 2, "发人深省": 2, "耐人寻味": 2,
    "具有一定的": 1, "起到了一定的": 1, "方方面面": 2,
}

# 中文套式过渡词: 出现在句首时是经典 AI 结构信号(首先/其次/最后…), 句首 +2, 句中 +1。
_TRANSITION_CN: tuple[str, ...] = (
    "首先", "其次", "再次", "然后", "此外", "另外", "除此之外",
    "与此同时", "综上", "总之", "不仅如此", "更重要的是", "最后",
)

# "随着…的发展/推进/深入" 这类万能开头。
_PATTERNS_CN: list[tuple[re.Pattern[str], int, str]] = [
    (re.compile(r"随着.{0,24}?(的(不断|快速|迅速)?(发展|推进|深入|进步)|日益|不断增长)"),
     2, "套式开头「随着…」"),
]

# 英文套话(强, 词边界匹配, 忽略大小写): 命中即 +2。
_CLICHE_EN_STRONG: tuple[str, ...] = (
    "delve", "tapestry", "underscore", "underscores", "realm", "pivotal",
    "meticulous", "meticulously", "showcase", "showcases", "testament",
    "seamless", "seamlessly", "myriad", "plethora", "embark", "ever-evolving",
    "ever-changing", "resonate", "resonates", "spearhead", "cutting-edge",
    "groundbreaking", "game-changer", "intricate", "intricacies", "paramount",
)
# 英文软信号(科研中也常见, +1): 只有扎堆才会触发标记。
_CLICHE_EN_SOFT: tuple[str, ...] = (
    "leverage", "harness", "foster", "fostering", "elevate", "robust",
    "comprehensive", "holistic", "navigate", "navigating", "unlock",
    "unlocking", "crucial", "crucially", "vital",
)
# 英文套式过渡短语/词: 句首 +2, 句中 +1。
_TRANSITION_EN: tuple[str, ...] = (
    "furthermore", "moreover", "additionally", "notably", "importantly",
    "consequently", "in conclusion", "it is worth noting", "it is important to note",
    "on the other hand", "that being said", "in today's",
)


def _en_regex(words: tuple[str, ...]) -> re.Pattern[str]:
    return re.compile(r"\b(" + "|".join(re.escape(w) for w in words) + r")\b", re.IGNORECASE)


_RE_EN_STRONG = _en_regex(_CLICHE_EN_STRONG)
_RE_EN_SOFT = _en_regex(_CLICHE_EN_SOFT)
_RE_EN_TRANS = _en_regex(_TRANSITION_EN)

# 分数达到该值即标记为"AI 味较重"。
FLAG_THRESHOLD = 2
# 单句返回的原因标签上限(保持提示简洁)。
_MAX_REASONS = 5


# ── 分块 ────────────────────────────────────────────────────────────

def _classify(lines: list[str], is_code: bool) -> str:
    """判断一个块是散文(prose)还是应跳过(skip)。"""
    if is_code:
        return "skip"
    stripped = [ln.strip() for ln in lines if ln.strip()]
    if not stripped:
        return "skip"
    first = stripped[0]
    if first.startswith("#"):
        return "skip"  # 标题
    if re.fullmatch(r"[-*_]{3,}", first):
        return "skip"  # 分隔线
    # 表格: 半数以上行以 | 开头
    if sum(1 for ln in stripped if ln.startswith("|")) * 2 >= len(stripped):
        return "skip"
    # 纯链接/参考文献列表行(如 "- [Author (2020). 标题](http...)"): 半数以上是 markdown 链接项
    if sum(1 for ln in stripped if re.match(r"[-*]\s*\[.*\]\(https?://", ln)) * 2 >= len(stripped):
        return "skip"
    return "prose"


def segment_blocks(md: str) -> list[dict]:
    """把 Markdown 切成全量块序列(空行分隔; 围栏代码块整段视为一块)。

    返回每块 {"index", "kind": "prose"|"skip", "text", "start_line", "end_line",
             "start", "end"}。其中 md[start:end] == text(精确原文子串), 便于改写后
     按 start/end 从右向左原地替换、不改动其余内容与分隔。
    index 覆盖所有块(含 skip)。
    """
    md = md or ""
    blocks: list[dict] = []
    lines = md.split("\n")
    # 每行在原文中的起始字符位置(split 掉的 "\n" 计回长度)
    line_start: list[int] = []
    pos = 0
    for ln in lines:
        line_start.append(pos)
        pos += len(ln) + 1

    cur: list[int] = []  # 当前块累积的行号
    in_code = False

    def flush(end_is_code: bool) -> None:
        nonlocal cur
        if cur and any(lines[i].strip() for i in cur):
            a, b = cur[0], cur[-1]
            start = line_start[a]
            end = line_start[b] + len(lines[b])
            blocks.append({
                "index": len(blocks),
                "kind": _classify([lines[i] for i in cur], end_is_code),
                "text": md[start:end],
                "start_line": a,
                "end_line": b + 1,
                "start": start,
                "end": end,
            })
        cur = []

    for i, ln in enumerate(lines):
        if ln.lstrip().startswith("```"):
            if not in_code:
                if cur:
                    flush(False)  # 进代码块前先收尾已累积的散文
                in_code = True
                cur.append(i)
            else:
                cur.append(i)
                in_code = False
                flush(True)  # 围栏闭合 → 整段作为一个代码块
            continue
        if in_code:
            cur.append(i)
            continue
        if ln.strip() == "":
            if cur:
                flush(False)
            continue
        cur.append(i)

    if cur:
        flush(in_code)
    return blocks


# ── 句子切分 ──────────────────────────────────────────────────────────

# 在中英句末标点后切分(全角。！？； 与半角 .!? 后接空白)。启发式, 允许偶尔切碎小数/缩写。
_SENT_SPLIT = re.compile(r"(?<=[。！？；])|(?<=[.!?])(?=\s)")


def split_sentences(text: str) -> list[str]:
    """把一段散文切成句子; 去掉 markdown 行内标记与过短碎片。"""
    # 去掉行内强调/行首列表符号, 不影响打分
    flat = re.sub(r"[*_`>]", "", text)
    flat = re.sub(r"^\s*[-*+]\s+", "", flat, flags=re.MULTILINE)
    flat = flat.replace("\n", " ")
    out: list[str] = []
    for part in _SENT_SPLIT.split(flat):
        s = part.strip()
        # 过短(<6 字符)或纯符号/数字碎片不计
        if len(s) >= 6 and re.search(r"[一-鿿A-Za-z]", s):
            out.append(s)
    return out


# ── 打分 ────────────────────────────────────────────────────────────

def score_sentence(sentence: str) -> tuple[int, list[str]]:
    """给单句打 AI 味分, 返回 (分数, 原因标签列表)。纯确定性。"""
    score = 0
    reasons: list[str] = []
    low = sentence.lower()
    head = sentence.lstrip()

    # 中文套话
    for term, w in _CLICHE_CN.items():
        if term in sentence:
            score += w
            reasons.append(f"套话「{term}」")
    # 中文空洞措辞
    for term, w in _HEDGE_CN.items():
        if term in sentence:
            score += w
            reasons.append(f"空洞措辞「{term}」")
    # 中文过渡词(句首更重)
    for term in _TRANSITION_CN:
        if term in sentence:
            at_head = head.startswith(term) or head.startswith(term + "，") or head.startswith(term + ",")
            score += 2 if at_head else 1
            reasons.append(f"套式过渡词「{term}」")
    # 中文万能开头等模式
    for pat, w, tag in _PATTERNS_CN:
        if pat.search(sentence):
            score += w
            reasons.append(tag)

    # 英文强/软套话
    for m in dict.fromkeys(t.lower() for t in _RE_EN_STRONG.findall(sentence)):
        score += 2
        reasons.append(f"套话「{m}」")
    # 软信号(科研中也合法): 单个不计, 只有同句扎堆(≥2 个不同词)才按 个数-1 计分,
    # 避免"crucial finding / comprehensive dataset"这类正常表达被误伤。
    soft = list(dict.fromkeys(t.lower() for t in _RE_EN_SOFT.findall(sentence)))
    if len(soft) >= 2:
        score += len(soft) - 1
        reasons.extend(f"套话「{m}」" for m in soft)
    # 英文过渡词(句首更重)
    for m in dict.fromkeys(t.lower() for t in _RE_EN_TRANS.findall(sentence)):
        score += 2 if low.lstrip().startswith(m) else 1
        reasons.append(f"套式过渡词「{m}」")

    # 三元排比: 一个句子里 ≥3 个顿号分隔的短项(常见 AI "高效、可靠、精准"式堆叠)
    if sentence.count("、") >= 3:
        score += 1
        reasons.append("排比堆叠")

    # 去重原因并截断
    seen: list[str] = []
    for r in reasons:
        if r not in seen:
            seen.append(r)
    return score, seen[:_MAX_REASONS]


def scan_ai_flavor(md: str) -> dict:
    """扫描整份 Markdown, 返回 AI 味较重的句子(按文档顺序)。

    返回:
      {
        "spans": [{"block": 全局块序, "sentence": 原句, "score": 分, "reasons": [...]}],
        "flagged_blocks": [去重的块序, 文档顺序],   # 供改写第二步按块处理
        "stats": {"blocks", "prose_blocks", "sentences", "flagged"},
      }
    任何异常都返回空结果(放行不阻塞), 与项目其他"分析型"接口一致由调用方兜底。
    """
    spans: list[dict] = []
    prose_blocks = 0
    sentence_count = 0
    blocks = segment_blocks(md)
    for b in blocks:
        if b["kind"] != "prose":
            continue
        prose_blocks += 1
        for s in split_sentences(b["text"]):
            sentence_count += 1
            score, reasons = score_sentence(s)
            if score >= FLAG_THRESHOLD:
                spans.append({
                    "block": b["index"],
                    "sentence": s,
                    "score": score,
                    "reasons": reasons,
                })

    flagged_blocks: list[int] = []
    for sp in spans:
        if sp["block"] not in flagged_blocks:
            flagged_blocks.append(sp["block"])

    return {
        "spans": spans,
        "flagged_blocks": flagged_blocks,
        "stats": {
            "blocks": len(blocks),
            "prose_blocks": prose_blocks,
            "sentences": sentence_count,
            "flagged": len(spans),
        },
    }


# ── 改写(第二步): 逐块流式, 仅动被标记的散文块 ─────────────────────────

# 引用标记: [1]、[3,4]、[10-12]、[@key] 以及 URL。改写前后若这些集合变化 → 打警告,
# 由前端默认不采纳该段, 防止破坏正文引用与后续引用核验。
_CITE_RE = re.compile(r"\[(?:@[\w:.\-]+|\d+(?:\s*[,\-–]\s*\d+)*)\]")
_URL_RE = re.compile(r"https?://[^\s)]+")


def _citation_keys(text: str) -> list[str]:
    keys = [m.group(0).replace(" ", "") for m in _CITE_RE.finditer(text)]
    keys += [m.group(0).rstrip(".,;") for m in _URL_RE.finditer(text)]
    return sorted(keys)


_REWRITE_SYSTEM = (
    "你是资深中文科研论文语言编辑。任务: 去除给定段落的『AI 腔』, 让它读起来像克制、"
    "专业的科研写作。\n"
    "必须一字不改地保留: 事实、数据、数字、统计量、p 值、引用标记(如 [1]、[3,4]、[@key])、"
    "URL、专业术语、数学公式($..$)、以及 Markdown 结构与列表/标题标记。\n"
    "只调整表达: ① 打散过于均匀的句长, 让长短句自然交错; ② 删除空洞套话与多余过渡词"
    "(首先/其次/综上所述/值得注意的是/furthermore 等); ③ 去掉三元排比式堆叠; "
    "④ 把模糊措辞换成具体、直接的表述。\n"
    "铁律: 不得新增或删除任何数据、引用、结论; 不得口语化、不得玩梗、不得制造逻辑跳跃; "
    "保持学术严谨与原意。\n"
    "只输出改写后的该段落正文本身, 不要解释、不要加引号、不要任何前后缀。"
)


def _rewrite_messages(block_text: str, style: str = "") -> list[dict]:
    system = _REWRITE_SYSTEM
    if style.strip():
        system += "\n\n【作者个人风格档案, 在不违反上述铁律的前提下优先遵循】\n" + style.strip()
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": block_text},
    ]


async def stream_rewrite(
    md: str,
    block_indices: list[int],
    *,
    style: str = "",
) -> AsyncIterator[tuple[str, dict]]:
    """逐块流式改写(只改 block_indices 指定的散文块)。yield (event, data):

      ("segment",      {block, start, end, original})   开始改写某块(start/end 为原文字符区间)
      ("delta",        {block, text})                   该块的增量文本
      ("segment_done", {block, rewritten, citation_warn}) 该块改写完(引用集合是否变化)
      ("done",         {})                              全部结束

    前端持有原文, 按 start/end 把接受的 rewritten 从右向左替换回去即可, 无需重建未改动内容。
    异常向上抛(由端点统一转成 error 事件), 与其它流式端点一致。
    """
    targets = set(block_indices or [])
    for b in segment_blocks(md):
        if b["index"] not in targets or b["kind"] != "prose":
            continue
        yield ("segment", {
            "block": b["index"], "start": b["start"], "end": b["end"], "original": b["text"],
        })
        rewritten = ""
        async for piece in stream_chat(_rewrite_messages(b["text"], style)):
            rewritten += piece
            yield ("delta", {"block": b["index"], "text": piece})
        rewritten = rewritten.strip()
        warn = _citation_keys(b["text"]) != _citation_keys(rewritten)
        yield ("segment_done", {
            "block": b["index"], "rewritten": rewritten, "citation_warn": warn,
        })
    yield ("done", {})

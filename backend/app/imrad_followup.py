"""对已生成的 IMRaD 初稿追问 / 按意见修改。

隐私/成本:
  过去每次追问都把 `materials`(原始病例/统计输出) + 整篇 `draft` 全量回灌到 LLM,
  用户追问 5 次就把病例上云 5 次, 且 90% token 与首次装配重复。
  现在:
    - 一律不再送 `materials` —— 初稿装配阶段已把材料整合进 draft, draft 才是"当前事实"
    - ask 追问模式: 用关键词匹配抽取 draft 里 1-2 个相关章节, 不送整篇
    - revise 修改模式: 仍送整篇 draft(重写需要看全文), 但不送 materials
"""
from __future__ import annotations

import re
import traceback
from typing import AsyncIterator

from .config import settings
from .llm import stream_chat


# IMRaD 四段的标题正则(Markdown 常见写法 + 中英对照)
_SECTION_HEAD_RE = re.compile(
    r"^\s*#{1,3}\s*(?:引言|前言|介绍|Introduction|方法|材料与方法|Methods?|Materials?|"
    r"结果|Results?|讨论|结论|Discussion|Conclusion)\b.*$",
    re.I | re.M,
)


def _split_draft_sections(draft: str) -> list[tuple[str, str]]:
    """把 draft 切成 [(section_head, section_body), ...] 便于按需抽取。"""
    heads = list(_SECTION_HEAD_RE.finditer(draft))
    if not heads:
        return [("全文", draft)]
    out: list[tuple[str, str]] = []
    for i, m in enumerate(heads):
        start = m.start()
        end = heads[i + 1].start() if i + 1 < len(heads) else len(draft)
        head = m.group(0).strip()
        body = draft[start:end].strip()
        out.append((head, body))
    # 首个标题之前若还有引子, 保留为"前言"
    if heads[0].start() > 0:
        preface = draft[:heads[0].start()].strip()
        if preface:
            out.insert(0, ("前言", preface))
    return out


def _pick_relevant_sections(draft: str, question: str, max_chars: int = 5000) -> str:
    """按问题关键词从 draft 抽取最相关的章节, 控制在 max_chars 内。

    若命中不到相关章节, 或 draft 本身很短(<=max_chars), 直接返回原文。
    这是启发式抽取: 关键词交集打分, 无外部依赖。
    """
    if len(draft) <= max_chars:
        return draft
    sections = _split_draft_sections(draft)
    if len(sections) <= 1:
        # 无法切分, 只能截尾部保留(结果/讨论通常在后半)
        return draft[-max_chars:]

    # 关键词: 英文按词抽(含 HR/OR/CI 这类学术缩写); 中文用 bigram(贪心整段匹配会永远命中不到)
    q_low = question.lower()
    en_tokens = set(re.findall(r"[a-z]{2,}", q_low))
    # 中文: 去非中文后按 bigram, 简单且不需分词依赖
    zh_only = re.sub(r"[^\u4e00-\u9fa5]+", " ", q_low)
    zh_tokens: set[str] = set()
    for chunk in zh_only.split():
        for i in range(len(chunk) - 1):
            zh_tokens.add(chunk[i:i + 2])
    stop = {"这个", "那个", "怎么", "什么", "如何", "为何", "是不", "不是", "的话", "the", "and", "for", "with", "which", "what", "how", "of"}
    q_tokens = (en_tokens | zh_tokens) - stop

    # IMRaD 四段中英同义词: 问题里提到"结果"就明确加权 Results 段, 提到"方法"就加权 Methods 等
    _SECTION_SYNONYMS = {
        ("结果", "results", "result"): "results",
        ("方法", "methods", "method", "材料"): "methods",
        ("讨论", "结论", "discussion", "conclusion"): "discussion",
        ("引言", "介绍", "背景", "introduction"): "introduction",
    }
    boost_kw: set[str] = set()
    for keys, canon in _SECTION_SYNONYMS.items():
        if any(k in q_low for k in keys):
            boost_kw.add(canon)

    scored: list[tuple[int, int, str]] = []  # (score, idx, body)
    for idx, (head, body) in enumerate(sections):
        head_low = head.lower()
        body_low = body.lower()
        score = sum(1 for t in q_tokens if t in body_low)
        # 章节标题命中(词粒度)
        if any(t in head_low for t in q_tokens):
            score += 3
        # IMRaD 同义词加权(如"问结果" -> Results 段 +5, 无视 body 是否含 bigram)
        for canon in boost_kw:
            if canon in head_low:
                score += 5
        scored.append((score, idx, body))

    # 按分数降序, 分数相同保留原顺序
    scored.sort(key=lambda x: (-x[0], x[1]))
    picked: list[tuple[int, str]] = []
    total = 0
    for score, idx, body in scored:
        if score == 0 and picked:  # 已挑到相关段, 剩下不相关的不再加
            break
        if total + len(body) > max_chars and picked:
            break
        picked.append((idx, body))
        total += len(body)
        if total >= max_chars:
            break

    if not picked:
        return draft[:max_chars]

    # 按原顺序拼接, 保留章节次序
    picked.sort(key=lambda x: x[0])
    return "\n\n".join(b for _, b in picked)


async def imrad_followup(inputs: dict) -> AsyncIterator[tuple[str, dict]]:
    mode = (inputs.get("mode") or "ask").strip()
    question = (inputs.get("question") or "").strip()
    draft = (inputs.get("draft") or "").strip()
    topic = (inputs.get("topic") or "").strip()
    # 不再消费 materials: 装配阶段已把材料整合到 draft, 追问链路 draft 才是"当前事实"

    if not question:
        yield ("error", {"message": "请填写追问问题或修改意见。"})
        return
    if not draft:
        yield ("error", {"message": "缺少可依据的初稿,请先装配一次 IMRaD 初稿。"})
        return

    if settings.mock:
        reply = f"[MOCK] 已收到{'修改意见' if mode == 'revise' else '追问'}: 「{question}」。"
        for ch in reply:
            yield ("delta", {"text": ch})
        yield ("done", {})
        return

    if mode == "revise":
        system = (
            "你是资深医学/药学/生物医学论文写作助手,正在按修改意见修订一份【论文 IMRaD 初稿】。"
            "请基于用户意见与当前初稿, 产出【修改后的完整初稿】: 保持 Introduction/Methods/Results/Discussion 结构,"
            "所有数字/统计量必须原样来自初稿, 禁止编造。缺失处标注 [待补充: ...]。直接输出修改后全文。"
            "铁律: 严禁引入初稿里没有的数字/文献/结论 —— 原始材料已在装配阶段整合到初稿, 此处以初稿为唯一事实来源。"
        )
        # 修改模式: 需要看全文才能重写, 送整篇 draft(但不再送 materials)
        draft_for_prompt = draft
    else:
        system = (
            "你是资深医学/药学/生物医学论文写作助手。基于当前 IMRaD 初稿相关章节回答用户追问, "
            "严禁编造数字/文献。若初稿里未包含用户问的信息, 请直说 [初稿未涵盖此项, 请补充材料后重新装配], "
            "不要臆测。"
        )
        # 追问模式: 只送相关章节, 避免每次上云整篇病例整合稿
        draft_for_prompt = _pick_relevant_sections(draft, question, max_chars=5000)

    user = (
        f"【论文主题】{topic or '(未提供)'}\n\n"
        f"【当前 IMRaD 初稿{'相关章节' if mode != 'revise' else ''}】\n{draft_for_prompt}\n\n"
        f"【用户{'修改意见' if mode == 'revise' else '追问'}】\n{question}"
    )

    try:
        async for piece in stream_chat(
            [{"role": "system", "content": system}, {"role": "user", "content": user}],
            task="imrad",
        ):
            yield ("delta", {"text": piece})
        yield ("done", {})
    except Exception as e:  # noqa: BLE001
        print("[imrad-followup] exception:\n" + traceback.format_exc(), flush=True)
        yield ("error", {"message": f"追问处理出错: {type(e).__name__}: {e}"})

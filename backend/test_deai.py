"""去 AI 味 启发式扫描器 + 改写生成器 单测(不联网、确定性)。

用法: python test_deai.py   (或 pytest)
"""
import asyncio

from app import deai


def _flagged_sentences(md: str) -> list[str]:
    return [sp["sentence"] for sp in deai.scan_ai_flavor(md)["spans"]]


def test_clean_science_not_flagged():
    """规范科研表达不应误伤(含 显著/significant/相关/comprehensive 等合法词)。"""
    md = (
        "本研究纳入 120 例患者，随机分为两组，主要终点为 28 天全因死亡率。\n\n"
        "组间差异具有统计学意义（P=0.03）。两组基线特征相关且可比。\n\n"
        "This is a crucial finding based on a comprehensive dataset."
    )
    res = deai.scan_ai_flavor(md)
    assert res["spans"] == [], res["spans"]  # 单个软词不足以触发
    assert res["stats"]["flagged"] == 0
    print("ok: clean_science_not_flagged")


def test_cliche_cn_flagged():
    md = "综上所述，本研究至关重要，具有重要意义。"
    spans = deai.scan_ai_flavor(md)["spans"]
    assert len(spans) == 1
    assert spans[0]["score"] >= 4  # 三个套话叠加
    assert any("综上所述" in r for r in spans[0]["reasons"])
    print("ok: cliche_cn_flagged")


def test_transition_opener_cn():
    md = "首先，我们回顾了相关文献。\n\n其次，我们设计了实验方案。"
    spans = deai.scan_ai_flavor(md)["spans"]
    assert len(spans) == 2  # 两句句首过渡词各触发一次
    assert all(any("过渡词" in r for r in sp["reasons"]) for sp in spans)
    print("ok: transition_opener_cn")


def test_english_cliche():
    md = "We delve into the intricate tapestry of results, underscoring the pivotal role of the model."
    spans = deai.scan_ai_flavor(md)["spans"]
    assert len(spans) == 1
    assert spans[0]["score"] >= 6  # delve/tapestry/intricate/underscoring/pivotal 多个强信号
    print("ok: english_cliche")


def test_hedging_and_pattern():
    md = "随着人工智能的不断发展，这一问题在一定程度上值得深思。"
    spans = deai.scan_ai_flavor(md)["spans"]
    assert len(spans) == 1
    tags = " ".join(spans[0]["reasons"])
    assert "随着" in tags and "在一定程度上" in tags
    print("ok: hedging_and_pattern")


def test_skip_heading_table_code():
    """标题/表格/代码块内即使有套话词也不参与打分。"""
    md = (
        "# 至关重要的研究背景\n\n"
        "| 指标 | 值 |\n| --- | --- |\n| 至关重要 | 综上所述 |\n\n"
        "```\n# 综上所述 至关重要\nprint('值得注意的是')\n```\n\n"
        "正文里综上所述这句才应被标记。"
    )
    res = deai.scan_ai_flavor(md)
    assert res["stats"]["flagged"] == 1  # 只有最后的正文句
    assert "正文里综上所述" in res["spans"][0]["sentence"]
    # 分块: 标题/表格/代码为 skip, 只有一个 prose 块
    assert res["stats"]["prose_blocks"] == 1
    print("ok: skip_heading_table_code")


def test_ref_list_skipped():
    """参考文献链接列表不当作散文打分。"""
    md = "- [Zhang (2020). 一项至关重要的综述](https://pubmed.ncbi.nlm.nih.gov/1)\n- [Li (2021). 综上所述的意义](https://pubmed.ncbi.nlm.nih.gov/2)"
    res = deai.scan_ai_flavor(md)
    assert res["stats"]["flagged"] == 0
    assert res["stats"]["prose_blocks"] == 0
    print("ok: ref_list_skipped")


def test_flagged_blocks_dedup_and_order():
    """flagged_blocks 去重且按文档顺序; 块索引落在散文块上。"""
    md = (
        "# 标题\n\n"
        "第一段综上所述至关重要。这句也值得注意的是很关键。\n\n"
        "第二段没有问题，描述了样本量与随访时间。\n\n"
        "第三段首先展开，其次总结。"
    )
    res = deai.scan_ai_flavor(md)
    fb = res["flagged_blocks"]
    assert fb == sorted(fb)  # 文档顺序
    assert len(fb) == len(set(fb))  # 去重
    # 第一段(块1)出现两处命中, 只应记一个块
    assert fb.count(1) == 0 or fb.count(1) == 1
    assert 2 not in fb  # 第二段干净(块2)
    print("ok: flagged_blocks_dedup_and_order")


def test_empty_and_garbage():
    for md in ["", "   \n\n  ", None]:
        res = deai.scan_ai_flavor(md if md is not None else "")
        assert res["spans"] == [] and res["stats"]["flagged"] == 0
    print("ok: empty_and_garbage")


def test_segment_offsets_exact():
    """每块的 md[start:end] 必须精确等于 text(改写靠这个原地拼接)。"""
    md = (
        "# 标题\n\n"
        "第一段综上所述。\n\n"
        "| a | b |\n| - | - |\n\n"
        "```py\nprint(1)\n```\n\n"
        "最后一段首先展开。"
    )
    blocks = deai.segment_blocks(md)
    for b in blocks:
        assert md[b["start"]:b["end"]] == b["text"], b
    # 覆盖 prose 与 skip 两类
    kinds = {b["kind"] for b in blocks}
    assert kinds == {"prose", "skip"}
    print("ok: segment_offsets_exact")


def test_citation_keys():
    a = "结果显著[1]，见 https://pubmed.ncbi.nlm.nih.gov/123 与 [3,4]。"
    # 改写保留全部引用 → 集合相等
    b = "研究发现结果显著[1]。参见 https://pubmed.ncbi.nlm.nih.gov/123 和 [3,4]。"
    assert deai._citation_keys(a) == deai._citation_keys(b)
    # 丢了一个引用 → 集合不等(会触发 citation_warn)
    c = "结果显著[1]。"
    assert deai._citation_keys(a) != deai._citation_keys(c)
    print("ok: citation_keys")


def _run_rewrite(md, blocks, fake):
    """用假的 stream_chat 跑 stream_rewrite, 收集事件序列(不调真实 LLM)。"""
    orig = deai.stream_chat
    deai.stream_chat = fake
    try:
        async def collect():
            return [ev async for ev in deai.stream_rewrite(md, blocks)]
        return asyncio.run(collect())
    finally:
        deai.stream_chat = orig


def test_stream_rewrite_events():
    md = "# 标题\n\n第一段综上所述至关重要。\n\n第二段样本量 240 例，随访 18 个月。"
    scan = deai.scan_ai_flavor(md)
    flagged = scan["flagged_blocks"]
    assert flagged == [1]  # 只有第一段(块1)命中; 第二段干净

    async def fake(messages, **kw):
        yield "改写后的克制表达。"

    events = _run_rewrite(md, flagged, fake)
    kinds = [e[0] for e in events]
    assert kinds == ["segment", "delta", "segment_done", "done"]
    seg = events[0][1]
    assert seg["block"] == 1 and md[seg["start"]:seg["end"]] == seg["original"]
    done = events[2][1]
    assert done["rewritten"] == "改写后的克制表达。"
    assert done["citation_warn"] is False  # 原文与改写都无引用
    print("ok: stream_rewrite_events")


def test_stream_rewrite_citation_warn():
    md = "第一段综上所述至关重要，详见 [12]。"  # 单块, 含引用
    async def drop_cite(messages, **kw):
        yield "改写后丢掉了引用标记。"  # 故意不保留 [12]

    events = _run_rewrite(md, [0], drop_cite)
    done = next(e[1] for e in events if e[0] == "segment_done")
    assert done["citation_warn"] is True
    print("ok: stream_rewrite_citation_warn")


if __name__ == "__main__":
    test_clean_science_not_flagged()
    test_cliche_cn_flagged()
    test_transition_opener_cn()
    test_english_cliche()
    test_hedging_and_pattern()
    test_skip_heading_table_code()
    test_ref_list_skipped()
    test_flagged_blocks_dedup_and_order()
    test_empty_and_garbage()
    test_segment_offsets_exact()
    test_citation_keys()
    test_stream_rewrite_events()
    test_stream_rewrite_citation_warn()
    print("\nALL DEAI TESTS PASSED")

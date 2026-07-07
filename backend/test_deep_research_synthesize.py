"""深度调研合成层测试: ref_key 分配 / 深读注入 / 引用核验 / JSON 围栏容错。

这一层此前无测试, ref_key 断链(前端 Reference 无 ref_key 字段 → 深读节选
从未进入合成 prompt、核验恒全红)正是从这里漏掉的; 本文件锁住回归。
"""
import json

import pytest


# ── assign_ref_keys / identity_key ───────────────────────────

def test_assign_ref_keys_author_year():
    from app import deep_research as dr
    refs = [
        {"title": "A", "first_author": "Smith J", "year": "2023"},
        {"title": "B", "first_author": "Doe A", "year": "2024"},
    ]
    out = dr.assign_ref_keys(refs)
    assert out[0]["ref_key"] == "Smith J 2023"
    assert out[1]["ref_key"] == "Doe A 2024"


def test_assign_ref_keys_dedup_and_fallback():
    from app import deep_research as dr
    refs = [
        {"title": "A", "first_author": "Smith J", "year": "2023"},
        {"title": "B", "first_author": "Smith J", "year": "2023"},  # 同作者同年 → 加序号
        {"title": "C"},  # 无作者/年份 → ref-N 兜底
    ]
    out = dr.assign_ref_keys(refs)
    keys = [r["ref_key"] for r in out]
    assert keys[0] == "Smith J 2023"
    assert keys[1] == "Smith J 2023-2"
    assert keys[2] == "ref-3"
    assert len(set(keys)) == 3


def test_assign_ref_keys_preserves_existing():
    from app import deep_research as dr
    out = dr.assign_ref_keys([{"title": "A", "ref_key": "custom"}])
    assert out[0]["ref_key"] == "custom"


def test_identity_key_matches_frontend_refkeyof():
    from app import deep_research as dr
    # 前端 refKeyOf: upload_id || pmid || url || title
    assert dr.identity_key({"upload_id": "u1", "pmid": "123"}) == "u1"
    assert dr.identity_key({"pmid": "123", "url": "http://x"}) == "123"
    assert dr.identity_key({"url": "http://x", "title": "T"}) == "http://x"
    assert dr.identity_key({"title": "T"}) == "T"


# ── 深读节选注入合成 prompt ───────────────────────────────────

def test_refs_block_includes_full_chunk():
    from app import deep_research as dr
    chunk = "RESULT " * 2000  # 14k chars, 远超旧版 1200 截断
    refs = dr.assign_ref_keys([{"title": "A", "first_author": "Smith J", "year": "2023"}])
    block = dr._dr_refs_block(refs, {"Smith J 2023": chunk})
    assert "全文节选" in block
    # 旧 bug: chunk[:1200]; 现在单篇预算 8k tokens (32k chars), 14k 字符应完整保留
    assert chunk[:14000] in block


def test_refs_block_total_budget_split():
    from app import deep_research as dr
    n = 10
    chunk = "x" * (dr.DEEP_READ_MAX_TOKENS_PER_PAPER * 4)
    refs = dr.assign_ref_keys([
        {"title": f"P{i}", "first_author": f"A{i}", "year": "2020"} for i in range(n)
    ])
    dmap = {r["ref_key"]: chunk for r in refs}
    block = dr._dr_refs_block(refs, dmap)
    per = dr.DEEP_READ_TOTAL_PROMPT_TOKENS * 4 // n
    assert len(block) < n * (per + 500)  # 每篇被压到全局预算平摊值附近


def test_refs_block_evidence_lines():
    from app import deep_research as dr
    refs = dr.assign_ref_keys([{"title": "A", "url": "http://x/1", "first_author": "Smith J", "year": "2023"}])
    ev = [{"url": "http://x/1/", "pop": "成人", "design": "RCT", "finding": "有效", "gap": "样本小"}]
    block = dr._dr_refs_block(refs, {}, dr._evidence_by_ref(refs, ev))
    assert "证据要点" in block
    assert "RCT" in block


def test_synthesis_messages_background_and_guardrail():
    from app import deep_research as dr
    refs = dr.assign_ref_keys([{"title": "A", "first_author": "S", "year": "2023"}])
    msgs = dr._dr_synthesis_messages("Q?", refs, {}, background="前置综述内容XYZ")
    assert "前置综述内容XYZ" in msgs[1]["content"]
    assert "未发现" in msgs[0]["content"]  # 无矛盾/空白时不凑数的护栏


# ── 引用核验 ─────────────────────────────────────────────────

def test_verify_citations_with_assigned_keys():
    from app import deep_research as dr
    refs = dr.assign_ref_keys([
        {"title": "A", "first_author": "Smith J", "year": "2023"},
        {"title": "B", "first_author": "Doe A", "year": "2024"},
    ])
    text = "结论一 [Smith J 2023]。结论二 [Doe A 2024] [Fake 2020]。"
    v = dr._verify_report_citations(text, refs)
    assert v["verified"] == 2
    assert v["unverified"] == ["Fake 2020"]


# ── JSON 围栏容错 ────────────────────────────────────────────

def test_parse_json_array_with_fence_and_preamble():
    from app import deep_research as dr
    raw = "好的，以下是结果：\n```json\n[{\"a\": 1}]\n```\n希望有帮助"
    assert dr._parse_json_array(raw) == [{"a": 1}]
    assert dr._parse_json_array("not json") is None
    assert dr._parse_json_array("{\"a\": 1}") is None  # 非数组


@pytest.mark.asyncio
async def test_recommend_tolerates_fence_and_non_dict(monkeypatch):
    from app import deep_research as dr
    from app.config import settings
    settings.mock = False
    fenced = "```json\n" + json.dumps([
        {"ref_key": "k0", "score": "high", "reason": "r"},
        "junk-string-item",
    ]) + "\n```"
    async def fake_llm(messages, **kw):
        yield fenced
    monkeypatch.setattr(dr, "stream_chat", fake_llm)
    got = await dr.recommend("Q", [{"ref_key": "k0", "title": "A", "abstract": ""}])
    assert got["ok"] is True
    scores = {it["ref_key"]: it["score"] for it in got["items"]}
    assert scores == {"k0": "high"}


@pytest.mark.asyncio
async def test_contribution_table_tolerates_fence(monkeypatch):
    from app import deep_research as dr
    from app.config import settings
    settings.mock = False
    fenced = "```json\n" + json.dumps([
        {"n": 1, "author_year": "Smith et al., 2023", "journal": "J", "design": "RCT",
         "sample": "500", "finding": "有效", "relevance": "direct", "deep_read": True},
    ]) + "\n```"
    async def fake_llm(messages, **kw):
        yield fenced
    monkeypatch.setattr(dr, "stream_chat", fake_llm)
    rows = await dr.build_contribution_table("Q", [{"ref_key": "k0", "title": "A"}], {})
    assert len(rows) == 1
    assert rows[0]["relevance"] == "direct"


# ── 深读兜底链: Europe PMC ───────────────────────────────────

@pytest.mark.asyncio
async def test_deep_read_falls_back_to_europepmc(monkeypatch):
    from app import deep_research as dr
    from app import europepmc

    async def fake_fulltext(pmid="", doi="", **kw):
        assert pmid == "123"
        return "Results\nEPMC full text here."
    monkeypatch.setattr(europepmc, "fetch_fulltext", fake_fulltext)
    target = {"ref_key": "k0", "source": "europepmc", "pmid": "123"}
    got = await dr.fetch_one_deep_read(target, project_id=None)
    assert got["ok"] is True
    assert "EPMC full text" in got["chunk"]


@pytest.mark.asyncio
async def test_deep_read_no_source_reports_error():
    from app import deep_research as dr
    target = {"ref_key": "k0", "source": "europepmc"}  # 无 oa_url/pmid/doi
    got = await dr.fetch_one_deep_read(target, project_id=None)
    assert got["ok"] is False
    assert got["error"]


# ── 章节切分: 容忍编号前缀 / 复合标题 ─────────────────────────

def test_split_sections_numbered_and_compound_headers():
    from app import deep_research as dr
    text = (
        "1. Introduction\nintro text\n"
        "2. Materials and Methods\nmethod text\n"
        "3. RESULTS AND DISCUSSION\nresult text\n"
        "4. Conclusions\nconclusion text\n"
    )
    sections = dr._split_sections(text)
    assert "body" not in sections
    assert "result text" in sections["result"]
    assert "method text" in sections["method"]
    chunk = dr.select_deep_read_chunk(text)
    assert "result text" in chunk

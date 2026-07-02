"""评审组模拟评审回归测试(mock, 不消耗额度)。

验证: 评分聚合(均分/等级/分节问题/覆盖度) / 评分表 markdown / mock 流程事件序列
(write_grant 含 review_data; review_grant 可独立重评; 空正文报错)。
"""
import asyncio

from app import config
from app.grant import (
    _aggregate_reviews, _score_tables_md, review_grant, write_grant,
)


def _fake_results():
    return [
        {"key": "peer", "persona": "同行领域专家", "scores": {"rationale": 8, "scheme": 7},
         "overall": 8, "grade": "A", "strengths": ["新颖"], "coverage": [],
         "issues": [{"section": "rationale", "severity": "高", "problem": "现状综述不足",
                     "advice": "补综述", "evidence": ""}]},
        {"key": "devil", "persona": "挑剔评委", "scores": {"rationale": 6}, "overall": 5,
         "grade": "C", "strengths": [], "coverage": [
             {"item": "科学问题明确", "status": "partial", "note": "偏宽泛"}],
         "issues": [{"section": "general", "severity": "高", "problem": "工作量过大",
                     "advice": "砍一条线", "evidence": ""}]},
    ]


def test_aggregate_reviews():
    sec_keys = [("rationale", "一、立项依据"), ("scheme", "三、研究方案")]
    agg = _aggregate_reviews(_fake_results(), sec_keys)
    assert agg["scores"]["rationale"] == 7.0          # (8+6)/2
    assert agg["scores"]["scheme"] == 7.0             # 只有一位打分
    assert agg["overall"] == 6.5 and agg["grade"] == "B"
    assert agg["votes"] == {"A": 1, "B": 0, "C": 1}
    assert agg["sections"][0]["issues"][0]["by"] == "同行领域专家"
    assert agg["general_issues"][0]["problem"] == "工作量过大"
    assert agg["coverage"][0]["status"] == "partial"


def test_score_tables_md():
    sec_keys = [("rationale", "一、立项依据"), ("scheme", "三、研究方案")]
    results = _fake_results()
    md = _score_tables_md(_aggregate_reviews(results, sec_keys), results, sec_keys)
    assert "| 一、立项依据 | 8 | 6 | **7.0** |" in md
    assert "资助建议：B" in md
    assert "申报要求覆盖度" in md and "⚠️" in md
    # 挑剔评委没给 scheme 打分 → 用 — 占位
    assert "| 三、研究方案 | 7 | — | **7.0** |" in md


async def _collect(agen):
    return [ev async for ev in agen]


def test_write_grant_mock_emits_review_data():
    config.settings.mock = True
    evs = asyncio.run(_collect(write_grant({"title": "测试项目", "grant_type": "youth"})))
    names = [e for e, _ in evs]
    assert "review_data" in names and names[-1] == "done"
    rd = next(d for e, d in evs if e == "review_data")
    assert rd["grade"] in ("A", "B", "C") and rd["sections"]
    # 评审节标题已升级
    sec_titles = [d["title"] for e, d in evs if e == "section"]
    assert "评审组模拟评审" in sec_titles


def test_review_grant_mock_and_empty():
    config.settings.mock = True
    ins = {"title": "T", "grant_type": "general",
           "sections": [{"key": "rationale", "title": "一、立项依据", "text": "正文…"},
                        {"key": "review", "title": "评审组模拟评审", "text": "旧评审(应被剔除)"}]}
    evs = asyncio.run(_collect(review_grant(ins)))
    names = [e for e, _ in evs]
    assert names[0] == "section" and "review_data" in names and names[-1] == "done"
    # 全空正文 → error
    evs2 = asyncio.run(_collect(review_grant({"title": "T", "sections": []})))
    assert evs2[0][0] == "error"

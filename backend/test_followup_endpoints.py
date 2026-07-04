"""3 个 followup 生成器的单元冒烟测试(mock 模式,零额度,确定性)。"""
from __future__ import annotations

from app import config

config.settings.mock = True

import asyncio  # noqa: E402
from app.plan_followup import plan_followup  # noqa: E402


def _drain(agen):
    async def _run():
        events = []
        async for ev, data in agen:
            events.append((ev, data))
        return events
    return asyncio.run(_run())


def test_plan_followup_ask_mock():
    events = _drain(plan_followup({
        "mode": "ask",
        "question": "样本量怎么改?",
        "draft": "现有方案初稿...",
        "idea": "TMAO 与 AS",
        "materials": "研究领域: 心血管",
    }))
    kinds = [e for e, _ in events]
    assert "delta" in kinds
    assert kinds[-1] == "done"


def test_plan_followup_revise_mock():
    events = _drain(plan_followup({
        "mode": "revise",
        "question": "请把样本量加到 200/组",
        "draft": "初稿...",
        "idea": "x",
        "materials": "",
    }))
    kinds = [e for e, _ in events]
    assert "delta" in kinds
    assert kinds[-1] == "done"


def test_plan_followup_missing_question():
    events = _drain(plan_followup({"mode": "ask", "question": "", "draft": "x"}))
    kinds = [e for e, _ in events]
    assert "error" in kinds


from app.imrad_followup import imrad_followup  # noqa: E402


def test_imrad_followup_ask_mock():
    events = _drain(imrad_followup({
        "mode": "ask",
        "question": "结果段能否精简?",
        "draft": "## 结果\n...",
        "topic": "TNBC + PD-1",
        "materials": "预实验数据 ...",
    }))
    kinds = [e for e, _ in events]
    assert "delta" in kinds
    assert kinds[-1] == "done"


def test_imrad_followup_missing_draft():
    events = _drain(imrad_followup({"mode": "ask", "question": "q", "draft": ""}))
    kinds = [e for e, _ in events]
    assert "error" in kinds


if __name__ == "__main__":
    test_plan_followup_ask_mock()
    test_plan_followup_revise_mock()
    test_plan_followup_missing_question()
    print("ok: plan_followup mock tests")
    test_imrad_followup_ask_mock()
    test_imrad_followup_missing_draft()
    print("ok: imrad_followup mock tests")

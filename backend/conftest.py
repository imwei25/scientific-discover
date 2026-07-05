"""pytest 全局配置: 每个测试前恢复 MOCK_LLM 语义, 避免不同测试文件的
模块级 `settings.mock = False` 副作用泄漏到 followup / mock 依赖测试.

之前场景: `test_analyze_retry.py` 等文件在模块顶层写 `da.settings.mock = False`,
pytest 收集阶段就把 settings.mock 覆盖成 False, 导致 `test_followup_endpoints.py`
的 mock 用例走真实 LLM 401.

方案: autouse fixture 在每个测试前把 settings.mock 复位为 True (mock 语义),
个别真实模式测试可在函数体内显式 `settings.mock = False`.
"""
from __future__ import annotations

import pytest


@pytest.fixture(autouse=True)
def _reset_mock_llm():
    """每个测试前默认打开 MOCK_LLM, 保证 mock 用例不会被前一个模块的赋值污染."""
    try:
        from app.config import settings
        prev = settings.mock
        settings.mock = True
        yield
        settings.mock = prev
    except Exception:
        # settings 尚未加载时 (纯 utility 单测) 不影响
        yield

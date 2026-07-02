"""_extract_code 健壮性回归测试(真实故障场景, 不消耗 API 额度)。

背景: 实测 max_tokens=1500 会把生成的分析代码拦腰截断(闭合 ``` 丢失),
旧实现会把带围栏的原文整段交给 exec 导致 SyntaxError; 修复类回复的散文里
还常有内联 ``` 小片段, 旧实现取第一块曾提出 17 个字符的中文当代码。

运行: pytest test_extract_code.py -v
"""
from app.dataanalysis import _extract_code


def test_complete_fenced_block():
    text = "```python\nprint('hi')\n```"
    assert _extract_code(text) == "print('hi')"


def test_plain_code_no_fence():
    assert _extract_code("print('hi')\n") == "print('hi')"


def test_truncated_fence_strips_opening():
    """截断输出(有开围栏无闭围栏): 必须剥掉围栏取代码, 不能原文返回。"""
    text = "```python\nimport pandas as pd\nprint(df.head())"  # 无闭合围栏
    out = _extract_code(text)
    assert "```" not in out
    assert out.startswith("import pandas as pd")


def test_prefers_longest_block_over_inline_snippet():
    """散文说明里的内联围栏片段不能被当成代码(曾提出 17 字符中文去 exec)。"""
    text = (
        "之前失败是因为列名写错了(`p-val` 应为 ```p_val```)。修正后的完整代码:\n"
        "```python\nimport pingouin as pg\nres = pg.ttest(a, b)\nprint(res)\n```"
    )
    out = _extract_code(text)
    assert out.startswith("import pingouin")
    assert "p-val" not in out


def test_prose_then_truncated_block():
    """散文里有完整内联小围栏 + 真代码块被截断: 应取截断的真代码, 不取小片段。"""
    text = (
        "错因: 原代码把 ```df.eval``` 误用了。重写:\n"
        "```python\nimport numpy as np\nx = np.arange(10)\nprint(x.mean())\n# 后面被截断了"
    )
    out = _extract_code(text)
    assert out.startswith("import numpy as np")
    assert "```" not in out


if __name__ == "__main__":
    import sys

    import pytest

    sys.exit(pytest.main([__file__, "-v"]))

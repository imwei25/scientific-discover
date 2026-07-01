"""候选选题解析：容错切题 + 自评分(星字形/N式) 单测（不联网）。

锁定 _parse_candidates 对 AI 常见格式漂移的鲁棒性：
  - 标题级别 ###/####、是否加粗、措辞(候选选题/选题/候选方向)、编号(阿拉伯/中文)
  - 自评分两种写法: `★★★★☆` 与 `★4/5`，且要跳过正文里同名小标题(可行性（设计…）)

用法: python test_candidates.py
"""
from app.research import _parse_candidates, _rating_after, _to_int


def test_heading_variants():
    # 原始 ### / 嵌一级 #### / 加粗 / 中文数字编号
    assert len(_parse_candidates("### 候选选题1：题A\n正文\n### 候选选题2：题B\n正文")) == 2
    assert len(_parse_candidates("#### 候选选题1：题A\n正文")) == 1
    assert len(_parse_candidates("### **候选选题1：题A**\n正文")) == 1
    assert len(_parse_candidates("#### 候选选题一：题A\n正\n#### 候选选题二：题B\n正")) == 2
    # 大节标题不应被误当成候选
    assert _parse_candidates("### 三、候选选题（3-5个）\n引言") == []
    print("ok: heading variants")


def test_title_and_number():
    cs = _parse_candidates("#### **候选选题2：数字疗法联合运动**\n正文")
    assert cs[0]["n"] == 2
    assert cs[0]["title"] == "数字疗法联合运动"  # 尾部 ** 被剥掉
    assert _to_int("三", 0) == 3 and _to_int("十二", 0) == 12 and _to_int("１", 0) == 1
    print("ok: title strip + number")


def test_self_score_formats():
    # 星字形
    assert _rating_after("可行性 ★★★★☆｜创新性 ★★★★★", "可行性") == 4
    assert _rating_after("可行性 ★★★★☆｜创新性 ★★★★★", "创新性") == 5
    # ★N/5 形
    assert _rating_after("可行性 ★4/5｜创新性 ★3/5", "可行性") == 4
    # 正文里 "可行性（设计/样本/方法）：每组60例" 不能被当成分值, 要跳到真正评分行
    body = "- 可行性（设计/样本/方法）：每组60例（总120例）\n> 可行性 ★★★★☆｜创新性 ★★★★★"
    assert _rating_after(body, "可行性") == 4
    # 越界/缺失
    assert _rating_after("可行性 ★9/5", "可行性") is None
    assert _rating_after("没有评分", "可行性") is None
    print("ok: self-score (stars / N-form / skip bullet)")


if __name__ == "__main__":
    test_heading_variants()
    test_title_and_number()
    test_self_score_formats()
    print("\nALL CANDIDATE TESTS PASSED")

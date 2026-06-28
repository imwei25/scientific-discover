"""医学图表三件套单测: 森林图 / KM 生存曲线 / ROC。

每个函数用小数据集跑一次, 验证输出键齐全 + 关键统计量合理。
"""
from __future__ import annotations

import io

import numpy as np
import pandas as pd

from app.analysis import forest_plot, km_curve, roc_curve_plot


# ---------- 森林图 ----------

def test_forest_plot_or_basic():
    studies = [
        {"study": "Trial A", "n_treat": 100, "event_treat": 30, "n_ctrl": 100, "event_ctrl": 50},
        {"study": "Trial B", "n_treat": 80,  "event_treat": 20, "n_ctrl": 80,  "event_ctrl": 35},
        {"study": "Trial C", "n_treat": 120, "event_treat": 40, "n_ctrl": 120, "event_ctrl": 55},
    ]
    out = forest_plot(studies, effect="OR")
    assert isinstance(out["png"], (bytes, bytearray)) and len(out["png"]) > 1000
    assert isinstance(out["svg"], str) and out["svg"].startswith("<?xml")
    assert isinstance(out["pdf"], (bytes, bytearray)) and out["pdf"][:4] == b"%PDF"
    s = out["summary"]
    assert s["k"] == 3
    # OR < 1 因为治疗组事件数较少
    assert s["pooled"] < 1.0
    assert 0 <= s["i2"] <= 100
    assert s["ci_low"] < s["pooled"] < s["ci_high"]


def test_forest_plot_rr_basic():
    studies = [
        {"study": "S1", "n_treat": 50, "event_treat": 10, "n_ctrl": 50, "event_ctrl": 20},
        {"study": "S2", "n_treat": 60, "event_treat": 15, "n_ctrl": 60, "event_ctrl": 25},
    ]
    out = forest_plot(studies, effect="RR")
    assert "summary" in out and out["summary"]["k"] == 2
    assert 0 < out["summary"]["pooled"] < 2


def test_forest_plot_zero_cell_correction():
    """0 事件 cell 应被 Haldane-Anscombe 校正处理, 不抛错。"""
    studies = [
        {"study": "Z1", "n_treat": 50, "event_treat": 0,  "n_ctrl": 50, "event_ctrl": 10},
        {"study": "Z2", "n_treat": 50, "event_treat": 5,  "n_ctrl": 50, "event_ctrl": 15},
    ]
    out = forest_plot(studies, effect="OR")
    assert out["summary"]["k"] == 2


def test_forest_plot_empty_raises():
    import pytest
    with pytest.raises(ValueError):
        forest_plot([], effect="OR")


# ---------- KM 曲线 ----------

def _km_csv(seed: int = 1) -> bytes:
    rng = np.random.default_rng(seed)
    n_per = 40
    # 两组, 治疗组生存更长
    time_a = rng.exponential(10, n_per)
    time_b = rng.exponential(20, n_per)
    event_a = rng.integers(0, 2, n_per)
    event_b = rng.integers(0, 2, n_per)
    df = pd.DataFrame({
        "time": np.concatenate([time_a, time_b]),
        "event": np.concatenate([event_a, event_b]),
        "group": ["A"] * n_per + ["B"] * n_per,
    })
    buf = io.BytesIO()
    df.to_csv(buf, index=False, encoding="utf-8-sig")
    return buf.getvalue()


def test_km_curve_with_groups():
    out = km_curve(_km_csv(), "t.csv", "time", "event", "group")
    assert len(out["png"]) > 1000
    assert out["svg"].startswith("<?xml")
    assert out["pdf"][:4] == b"%PDF"
    assert out["logrank_p"] is not None
    assert 0 <= out["logrank_p"] <= 1
    names = {g["name"] for g in out["groups"]}
    assert names == {"A", "B"}
    for g in out["groups"]:
        assert g["n"] == 40


def test_km_curve_without_groups():
    out = km_curve(_km_csv(), "t.csv", "time", "event", None)
    assert out["logrank_p"] is None
    assert len(out["groups"]) == 1
    assert out["groups"][0]["name"] == "All"
    assert out["groups"][0]["n"] == 80


def test_km_curve_invalid_col():
    import pytest
    with pytest.raises(ValueError):
        km_curve(_km_csv(), "t.csv", "nonexistent", "event", None)


# ---------- ROC 曲线 ----------

def _roc_csv(seed: int = 0) -> bytes:
    rng = np.random.default_rng(seed)
    n = 200
    y_true = rng.integers(0, 2, n)
    # 信号: 正类的 score 整体更高
    y_score = rng.normal(loc=y_true * 1.0, scale=1.0)
    df = pd.DataFrame({"label": y_true, "score": y_score})
    buf = io.BytesIO()
    df.to_csv(buf, index=False, encoding="utf-8-sig")
    return buf.getvalue()


def test_roc_curve_basic():
    out = roc_curve_plot(_roc_csv(), "t.csv", "label", "score", n_bootstrap=200)
    assert len(out["png"]) > 1000
    assert out["svg"].startswith("<?xml")
    assert out["pdf"][:4] == b"%PDF"
    # 由于 loc=label, AUC 应明显 > 0.5
    assert 0.6 <= out["auc"] <= 1.0
    low, high = out["auc_ci"]
    assert low <= out["auc"] <= high
    assert isinstance(out["optimal_threshold"], float)


def test_roc_curve_constant_labels_raises():
    import pytest
    df = pd.DataFrame({"label": [1] * 10, "score": np.random.rand(10)})
    buf = io.BytesIO()
    df.to_csv(buf, index=False, encoding="utf-8-sig")
    with pytest.raises(ValueError):
        roc_curve_plot(buf.getvalue(), "t.csv", "label", "score", n_bootstrap=50)


def test_roc_curve_missing_col_raises():
    import pytest
    with pytest.raises(ValueError):
        roc_curve_plot(_roc_csv(), "t.csv", "no_such", "score", n_bootstrap=50)

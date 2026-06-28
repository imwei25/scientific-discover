"""病例数据脱敏单元测试。

覆盖 4 种 PHI 类型(姓名 / 身份证 / 手机号 / MRN / 出生日期) + 边界值
(空值、纯英文、纯数字)。所有数据为伪造演示数据。
"""
from __future__ import annotations

import io
import json

import pandas as pd
import pytest

from app.deidentify import _id_card_valid, apply, scan


def _make_csv(df: pd.DataFrame) -> bytes:
    buf = io.BytesIO()
    df.to_csv(buf, index=False, encoding="utf-8-sig")
    return buf.getvalue()


def _make_xlsx(df: pd.DataFrame) -> bytes:
    buf = io.BytesIO()
    with pd.ExcelWriter(buf, engine="openpyxl") as w:
        df.to_excel(w, index=False)
    return buf.getvalue()


# ---------- 工具函数验证 ----------

def test_id_card_validator():
    # 有效身份证(示例, 通过校验位)
    assert _id_card_valid("11010519491231002X")
    # 末位错的视为无效
    assert not _id_card_valid("11010519491231002A")
    assert not _id_card_valid("110105194912310020")
    # 长度不对
    assert not _id_card_valid("1101051949123100")


# ---------- 扫描 ----------

def test_scan_detects_name_column():
    df = pd.DataFrame({
        "患者姓名": ["张三", "李四", "王小明", "Alice"],  # Alice 是英文, 应被忽略
        "年龄": [40, 50, 60, 30],
    })
    rep = scan(_make_csv(df), "t.csv")
    cols = {c["name"]: c for c in rep["columns"]}
    assert "患者姓名" in cols
    assert "name" in cols["患者姓名"]["phi_types"]
    assert cols["患者姓名"]["count"] == 3  # Alice 不计
    assert rep["total_rows"] == 4
    # 年龄列不应包含 PHI
    assert "年龄" not in cols


def test_scan_detects_id_card_and_phone():
    df = pd.DataFrame({
        "身份证号": ["11010519491231002X", "invalid", "440301198001011237"],
        "联系方式": ["13800138000", "12345", "15912345678"],
    })
    rep = scan(_make_csv(df), "t.csv")
    cols = {c["name"]: c for c in rep["columns"]}
    assert "id_card" in cols["身份证号"]["phi_types"]
    # 联系方式列被列名当 None, 但内容匹配手机号
    assert "phone" in cols["联系方式"]["phi_types"]


def test_scan_detects_mrn_column():
    df = pd.DataFrame({
        "住院号": ["H0001", "H0002", "H0003"],
        "MRN": ["MRN-001", "MRN-002", "MRN-003"],
    })
    rep = scan(_make_csv(df), "t.csv")
    cols = {c["name"]: c for c in rep["columns"]}
    assert "mrn" in cols["住院号"]["phi_types"]
    assert "mrn" in cols["MRN"]["phi_types"]


def test_scan_detects_birth_column():
    df = pd.DataFrame({
        "出生日期": ["1980-05-12", "1990/10/01", ""],
        "DOB": ["1985-01-01", "1992-06-15", "not-a-date"],
    })
    rep = scan(_make_csv(df), "t.csv")
    cols = {c["name"]: c for c in rep["columns"]}
    assert "birth" in cols["出生日期"]["phi_types"]
    assert "birth" in cols["DOB"]["phi_types"]


def test_scan_edge_empty_and_all_numeric():
    """边界: 空 DataFrame / 全数字 / 全英文 -> 应无 PHI 列。"""
    df = pd.DataFrame({
        "id": [1, 2, 3],
        "score": [0.5, 0.8, 0.9],
        "note": ["abc", "def", "ghi"],
    })
    rep = scan(_make_csv(df), "t.csv")
    assert rep["columns"] == []
    assert rep["total_rows"] == 3


# ---------- 脱敏 ----------

def test_apply_name_redacts_to_pt_codes():
    df = pd.DataFrame({
        "姓名": ["张三", "李四", "张三", "Alice"],
        "结果": [1.2, 1.5, 1.3, 1.4],
    })
    out, mapping = apply(_make_csv(df), "t.csv", ["姓名"])
    out_df = pd.read_csv(io.BytesIO(out), encoding="utf-8-sig")
    vals = list(out_df["姓名"])
    # 张三两条应映射相同
    assert vals[0] == vals[2]
    assert vals[0].startswith("PT")
    assert vals[1] != vals[0]
    # 英文 Alice 不在姓名规则内, 保留
    assert vals[3] == "Alice"
    # 映射表正确
    assert mapping["姓名"]["张三"] == vals[0]


def test_apply_id_card_masked():
    # 第二个是 invalid(非 18 位), 第三个是通过校验位的合成身份证(无真实归属)
    df = pd.DataFrame({
        "身份证": ["11010519491231002X", "invalid", "291417776317066908"],
    })
    out, mapping = apply(_make_csv(df), "t.csv", ["身份证"])
    out_df = pd.read_csv(io.BytesIO(out), encoding="utf-8-sig", dtype=str)
    masked = list(out_df["身份证"])
    assert masked[0] == "1101**********002X"
    assert masked[1] == "invalid"  # 非身份证不动
    assert masked[2] == "2914**********6908"


def test_apply_phone_masked():
    df = pd.DataFrame({
        "手机": ["13800138000", "12345", "15912345678"],
    })
    out, mapping = apply(_make_csv(df), "t.csv", ["手机"])
    out_df = pd.read_csv(io.BytesIO(out), encoding="utf-8-sig", dtype=str)
    vals = list(out_df["手机"])
    assert vals[0] == "138****8000"
    assert vals[1] == "12345"
    assert vals[2] == "159****5678"


def test_apply_mrn_sequential():
    df = pd.DataFrame({
        "住院号": ["H001", "H002", "H001", "H003"],
    })
    out, mapping = apply(_make_csv(df), "t.csv", ["住院号"])
    out_df = pd.read_csv(io.BytesIO(out), encoding="utf-8-sig", dtype=str)
    vals = list(out_df["住院号"])
    # 同值映射同值
    assert vals[0] == vals[2]
    assert vals[0] == "PT0001"
    assert vals[1] == "PT0002"
    assert vals[3] == "PT0003"


def test_apply_birth_year_only():
    df = pd.DataFrame({
        "出生日期": ["1980-05-12", "1990/10/01", "invalid", ""],
    })
    out, mapping = apply(_make_csv(df), "t.csv", ["出生日期"])
    out_df = pd.read_csv(io.BytesIO(out), encoding="utf-8-sig", dtype=str, keep_default_na=False)
    vals = list(out_df["出生日期"])
    assert vals[0] == "1980"
    assert vals[1] == "1990"
    # invalid 解析失败 -> 保留原样(空字符串保留为空)
    assert vals[2] == "invalid"
    assert vals[3] == ""


def test_apply_xlsx_roundtrip():
    df = pd.DataFrame({
        "姓名": ["王五", "赵六"],
        "MRN": ["M001", "M002"],
    })
    out, mapping = apply(_make_xlsx(df), "t.xlsx", ["姓名", "MRN"])
    out_df = pd.read_excel(io.BytesIO(out), dtype=str)
    assert all(v.startswith("PT") for v in out_df["姓名"])
    assert all(v.startswith("PT") for v in out_df["MRN"])
    # 两列编号空间独立
    assert "姓名" in mapping and "MRN" in mapping


def test_apply_skips_unselected_columns():
    df = pd.DataFrame({
        "姓名": ["张三", "李四"],
        "MRN": ["M001", "M002"],
    })
    out, mapping = apply(_make_csv(df), "t.csv", ["姓名"])  # 只勾姓名
    out_df = pd.read_csv(io.BytesIO(out), encoding="utf-8-sig", dtype=str)
    # MRN 列原样
    assert list(out_df["MRN"]) == ["M001", "M002"]
    assert "MRN" not in mapping


def test_apply_mapping_serializable():
    """映射表必须是 JSON 可序列化(前端要保存到本地)。"""
    df = pd.DataFrame({"姓名": ["张三", "李四"]})
    _, mapping = apply(_make_csv(df), "t.csv", ["姓名"])
    j = json.dumps(mapping, ensure_ascii=False)
    parsed = json.loads(j)
    assert parsed["姓名"]["张三"] == mapping["姓名"]["张三"]

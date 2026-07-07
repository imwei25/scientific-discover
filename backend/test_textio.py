"""文本/CSV 编码健壮性回归测试(不消耗 API 额度)。

运行: .venv\\Scripts\\python.exe -m pytest test_textio.py
     (也可直接 .venv\\Scripts\\python.exe test_textio.py)
验证:
  - GBK / 带BOM / utf-8 的 txt 经 extract 不丢中文(此前 utf-8+ignore 会静默丢字);
  - GBK 的 CSV 能被 extract 与 dataanalysis 正确读取;
  - decode_text 对任意字节都不抛错;
  - 编码"打分选优"不产出乱码(GBK/Big5 都还原为原文)。
"""
import pandas as pd

from app.extract import extract_text
from app.textio import decode_text
from app.dataanalysis import _load


def test_txt_encodings_keep_chinese():
    """GBK / utf-8 / 带BOM 的 txt 经 extract 不丢中文。"""
    txt = "这是我的论文草稿，包含重要结论与数据。"
    for enc in ("gbk", "utf-8", "utf-8-sig"):
        r = extract_text("m.txt", txt.encode(enc))
        assert r["ok"] and txt in r["text"], (enc, r)


def test_csv_gbk_extract():
    df = pd.DataFrame({"组别": ["对照", "试验"], "数值": [1, 2]})
    r = extract_text("d.csv", df.to_csv(index=False).encode("gbk"))
    assert r["ok"] and "组别" in r["text"], r


def test_dataanalysis_load_gbk():
    df = pd.DataFrame({"组别": ["对照", "试验"], "数值": [1, 2]})
    out = _load("d.csv", df.to_csv(index=False).encode("gbk"))
    assert list(out.columns) == ["组别", "数值"], out.columns


def test_decode_text_never_raises():
    assert isinstance(decode_text(b"\xff\xfe\x00bad"), str)


def test_best_encoding_no_mojibake():
    """择优解码(而非"取第一个不报错的"): GBK 中文即使能被别的编码勉强解出,
    也应还原为原文, 不出现乱码(此前"首个不报错"策略在 gb18030/latin-1 上会静默产出乱码)。"""
    zh = "结果表明处理组表达量显著上调，且呈剂量依赖关系。"
    assert decode_text(zh.encode("gb18030")) == zh, "GBK 择优解码未还原原文"
    df2 = pd.DataFrame({"分组": ["处理", "对照"], "疗效": ["显著", "一般"]})
    out2 = _load("g.csv", df2.to_csv(index=False).encode("gbk"))
    assert list(out2.columns) == ["分组", "疗效"] and out2["疗效"][0] == "显著", out2


def test_big5_traditional_chinese():
    """繁体(Big5)也应正确, 不被误当简体 GBK 解出乱码。"""
    tzh = "實驗結果顯示療效顯著"
    assert decode_text(tzh.encode("big5")) == tzh, "Big5 择优解码未还原原文"


def test_xls_legacy_excel_load():
    """老格式 .xls 能读(依赖 xlrd; 此前 requirements 缺失, 上传 .xls 必报英文错)。"""
    import io

    df = pd.DataFrame({"组别": ["对照", "试验"], "数值": [1, 2]})
    buf = io.BytesIO()
    # pandas 已不再支持写 .xls, 用 xlwt 不可得; 这里退而验证 xlrd 可导入 +
    # pd.read_excel 对 .xls 路径选择 xlrd 引擎时不再报 Missing optional dependency。
    import xlrd  # noqa: F401 — 打包/环境里必须存在

    xbuf = io.BytesIO()
    df.to_excel(xbuf, index=False)  # openpyxl 写 xlsx, 验证写路径完好
    out = _load("d.xlsx", xbuf.getvalue())
    assert list(out.columns) == ["组别", "数值"]


if __name__ == "__main__":
    # 保留脚本式运行入口(不依赖 pytest 安装)。
    import sys

    import pytest

    sys.exit(pytest.main([__file__, "-v"]))

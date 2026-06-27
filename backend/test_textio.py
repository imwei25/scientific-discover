"""文本/CSV 编码健壮性回归测试(不消耗 API 额度)。

运行: .venv\\Scripts\\python.exe test_textio.py
验证:
  - GBK / 带BOM / utf-8 的 txt 经 extract 不丢中文(此前 utf-8+ignore 会静默丢字);
  - GBK 的 CSV 能被 extract 与 dataanalysis 正确读取;
  - decode_text 对任意字节都不抛错。
"""
import sys

import pandas as pd

from app.extract import extract_text
from app.textio import decode_text
from app.dataanalysis import _load


def main() -> None:
    txt = "这是我的论文草稿，包含重要结论与数据。"
    for enc in ("gbk", "utf-8", "utf-8-sig"):
        r = extract_text("m.txt", txt.encode(enc))
        assert r["ok"] and txt in r["text"], (enc, r)
    print("txt GBK/BOM/utf-8 不丢中文: OK")

    df = pd.DataFrame({"组别": ["对照", "试验"], "数值": [1, 2]})
    r = extract_text("d.csv", df.to_csv(index=False).encode("gbk"))
    assert r["ok"] and "组别" in r["text"], r
    print("csv GBK extract: OK")

    out = _load("d.csv", df.to_csv(index=False).encode("gbk"))
    assert list(out.columns) == ["组别", "数值"], out.columns
    print("dataanalysis._load GBK: OK")

    assert isinstance(decode_text(b"\xff\xfe\x00bad"), str)
    print("decode_text 任意字节不抛错: OK")

    print("\nALL TEXTIO TESTS PASSED")


if __name__ == "__main__":
    try:
        main()
    except AssertionError as e:
        print("FAILED:", e)
        sys.exit(1)

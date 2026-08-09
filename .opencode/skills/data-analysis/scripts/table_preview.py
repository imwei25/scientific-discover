#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
表结构速览：抽前 N 行 + 逐列画像，供「变量对应」自动认列使用。

为什么要有这个脚本
------------------
「分组列 / 结局列 / 随访时间列 / 终点事件列 / 待评价指标列 / 金标准列」这一排下拉，
是本套件里**用户最不知所云、又最容易填错**的地方：医生看到「终点事件列」四个字，
第一反应是"这是啥"，而填错不会报错——只会安静地产出一条看着很正常的错 KM 曲线。

正确的顺序不是"先让用户填、AI 再照着做"，而是**先让机器看一眼数据、把它认出来，
再请用户核对一遍**。核对一个具体的「分组列＝组别（只有 试验组/对照组 两种取值，各 60/58 例）」
比从 23 个列名里挑一个容易一个数量级。

本脚本只负责第一步：**把表读明白**。认哪一列是什么由上层（规则 + 模型）做，
这里只输出客观事实——列名、前 N 行原样、每列的类型/取值个数/缺失/示例值。

铁律
----
* **只读，不改任何数据**（与 data_profile.py 同口径）。
* **不猜单位、不猜语义**：这里出的每一个字段都能从数据里直接看出来。
* 失败也要吐一个合法 JSON（上层是网关，`r.json()` 炸掉比"读不了"更难查）。

用法
----
    python table_preview.py --input data.xlsx [--rows 5] [--sheet 0] [--max-scan 20000]

输出（stdout，单个 JSON 对象）：
    {"ok": true, "headers": [...], "rows": [[...], ...], "cols": [{...}], ...}
"""
import argparse
import json
import math
import os
import sys

CELL_MAX = 60          # 单元格文本超过这个长度就截断（自由文本列会把整个 JSON 撑爆）
EXAMPLES = 5           # 每列给几个示例值
UNIQ_LIST_MAX = 12     # 取值个数 ≤ 这个数就把取值全列出来（分组列/事件列全靠它认）


def _err(msg, **extra):
    out = {"ok": False, "error": str(msg)}
    out.update(extra)
    print(json.dumps(out, ensure_ascii=False))
    sys.exit(0)          # 退出码 0：失败由 JSON 表达，别让上层把 stderr 当成崩溃


def _s(v):
    """任意单元格 → 短字符串。NaN/NaT 一律空串（前端据此显示"缺失"）。"""
    try:
        if v is None:
            return ""
        if isinstance(v, float) and math.isnan(v):
            return ""
    except Exception:
        pass
    s = str(v)
    if s in ("nan", "NaT", "None"):
        return ""
    s = s.replace("\r", " ").replace("\n", " ").strip()
    return s[:CELL_MAX] + "…" if len(s) > CELL_MAX else s


def _read(path, sheet, max_scan):
    """→ (df, sheets, note)。csv 走编码嗅探，Excel 走 pandas。"""
    import pandas as pd

    ext = os.path.splitext(path)[1].lower()
    note = ""
    if ext in (".xlsx", ".xlsm", ".xls", ".xlsb", ".ods"):
        try:
            xl = pd.ExcelFile(path)
            sheets = [str(s) for s in xl.sheet_names]
        except Exception as e:
            _err("Excel 打不开：%s" % e)
        # sheet 可以给序号也可以给名字；给不出就用第一张，并把全部表名回给上层让用户切换
        target = 0
        if sheet not in (None, ""):
            target = int(sheet) if str(sheet).isdigit() else str(sheet)
        try:
            df = xl.parse(target, nrows=max_scan)
        except Exception as e:
            _err("读 sheet 失败：%s" % e, sheets=sheets)
        if len(sheets) > 1:
            note = "这个工作簿有 %d 张表，当前读的是「%s」" % (
                len(sheets), sheets[target] if isinstance(target, int) else target)
        return df, sheets, note

    # ---- 文本表：编码嗅探。中文版 Excel「另存为 CSV」默认写 GBK，这是医院里最常见的导出方式 ----
    seps = {".tsv": "\t"}.get(ext, None)      # None = 让 pandas 自己嗅探分隔符（逗号/分号/制表符）
    last = None
    for enc in ("utf-8-sig", "gbk", "gb18030", "big5", "latin1"):
        try:
            df = pd.read_csv(path, sep=seps, engine="python", encoding=enc,
                             nrows=max_scan, dtype=object, keep_default_na=True)
            if enc == "latin1":
                note = "编码没认出来，按 latin1 硬读的——列名可能是乱码，请把表另存为「CSV UTF-8」再传"
            elif enc != "utf-8-sig":
                note = "文件编码是 %s（不是 UTF-8），已按它读出" % enc
            return df, [], note
        except UnicodeDecodeError as e:
            last = e
            continue
        except Exception as e:
            _err("读表失败：%s" % e)
    _err("编码认不出来（UTF-8 / GBK / GB18030 / Big5 都不是）：%s" % last)


def _kind(ser, uniq, n_nonnull):
    """列的类型标签。这几个标签是上层认列的主要依据，宁可保守也别给错。"""
    import pandas as pd

    if n_nonnull == 0:
        return "empty"
    if len(uniq) == 1:
        return "constant"
    num = pd.to_numeric(ser, errors="coerce")
    num_ok = int(num.notna().sum())
    is_num = num_ok >= max(1, int(n_nonnull * 0.9))     # 九成以上能转成数字才算数值列
    if is_num:
        vals = set(str(x) for x in uniq)
        if len(uniq) == 2 and vals <= {"0", "1", "0.0", "1.0", "True", "False"}:
            return "binary01"                            # 终点事件列的典型形状
        if len(uniq) <= 2:
            return "binary"
        try:
            allint = bool((num.dropna() % 1 == 0).all())
        except Exception:
            allint = False
        # 取值个数相对样本量极多、且全是整数 → 多半是 ID/编号，不是可分析的数值
        if allint and len(uniq) >= max(20, n_nonnull * 0.95):
            return "id"
        return "integer" if allint else "numeric"
    # 非数值：先看是不是日期
    try:
        dt = pd.to_datetime(ser, errors="coerce", format="mixed")
        if int(dt.notna().sum()) >= max(1, int(n_nonnull * 0.9)):
            return "datetime"
    except Exception:
        pass
    if len(uniq) == 2:
        return "binary"
    if len(uniq) <= max(10, n_nonnull * 0.05):
        return "categorical"
    if len(uniq) >= n_nonnull * 0.95:
        return "id"
    return "text"


def _profile(df, headers):
    import pandas as pd

    n = len(df)
    cols = []
    for i, name in enumerate(headers):
        ser = df.iloc[:, i]
        nn = ser.dropna()
        # 去掉纯空白字符串：Excel 导出里"空格单元格"极常见，不排掉的话缺失率全是 0
        nn = nn[nn.astype(str).str.strip() != ""]
        n_nonnull = int(len(nn))
        try:
            uniq = list(pd.unique(nn))
        except Exception:
            uniq = list(dict.fromkeys(nn.tolist()))
        c = {
            "name": name,
            "index": i,
            "nunique": len(uniq),
            "missing": n - n_nonnull,
            "missing_pct": round((n - n_nonnull) / n * 100, 1) if n else 0.0,
            "kind": _kind(nn, uniq, n_nonnull),
            "examples": [_s(v) for v in uniq[:EXAMPLES]],
        }
        # 取值少 → 全列出来 + 各自的例数。这是认「分组列 / 终点事件列 / 金标准列」最硬的证据：
        # 「组别：试验组 60 / 对照组 58」比列名像不像可靠得多。
        if 0 < len(uniq) <= UNIQ_LIST_MAX:
            try:
                vc = nn.astype(str).str.strip().value_counts()
                c["values"] = [{"v": _s(k), "n": int(v)} for k, v in vc.items()][:UNIQ_LIST_MAX]
            except Exception:
                c["values"] = [{"v": _s(v), "n": 0} for v in uniq]
        if c["kind"] in ("numeric", "integer", "binary01"):
            num = pd.to_numeric(nn, errors="coerce").dropna()
            if len(num):
                c["min"] = float(num.min())
                c["max"] = float(num.max())
                c["median"] = float(num.median())
                # 非负且非整 → 可能是时长/浓度；上层用它区分「随访时间」与「年龄」之外的数值列
                c["all_nonneg"] = bool((num >= 0).all())
        cols.append(c)
    return cols


def main():
    ap = argparse.ArgumentParser(description="抽前 N 行 + 逐列画像（只读，不改数据）")
    ap.add_argument("--input", required=True, help="数据文件（csv/tsv/xlsx/xlsm/xls）")
    ap.add_argument("--rows", type=int, default=5, help="样本行数，默认 5")
    ap.add_argument("--sheet", default="", help="Excel 工作表（序号或名字），默认第一张")
    ap.add_argument("--max-scan", type=int, default=20000,
                    help="最多读多少行来做列画像（大表不整读进内存），默认 20000")
    a = ap.parse_args()

    if not os.path.isfile(a.input):
        _err("文件不存在：%s" % a.input)
    try:
        import pandas  # noqa: F401
    except Exception as e:
        _err("这个环境没有 pandas（%s）——先跑 env-setup 技能建 .venv" % e)

    df, sheets, note = _read(a.input, a.sheet, max(a.max_scan, a.rows))
    if df is None or df.shape[1] == 0:
        _err("这张表解析出 0 列，读不出结构")

    # 列名：空列名与重名列都要显式标出（与 workflows.mjs 的 parseHeaders 同口径，
    # 否则同一张表在两条路径上会给出不同的列名，用户在界面上根本对不上）
    seen, headers = {}, []
    for i, h in enumerate(list(df.columns)):
        base = _s(h) or "（第 %d 列·无列名）" % (i + 1)
        k = base.lower()
        seen[k] = seen.get(k, 0) + 1
        headers.append("%s（重名 %d）" % (base, seen[k]) if seen[k] > 1 else base)

    rows = [[_s(v) for v in rec] for rec in df.head(max(0, a.rows)).itertuples(index=False, name=None)]
    scanned = len(df)
    out = {
        "ok": True,
        "file": os.path.basename(a.input),
        "headers": headers,
        "rows": rows,
        "cols": _profile(df, headers),
        "scanned": scanned,
        # 扫到上限 = 后面还有行，"共几行"这时是【不知道】的，别把上限当成行数报出去
        "truncated": scanned >= a.max_scan,
        "sheets": sheets,
        "note": note,
    }
    print(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    main()

"""statcheck 式统计一致性自查。

论文里 `t/F/χ²/r/z + 自由度 + p 值` 三者算不上对(报告错误)在医学稿件极常见，
越来越多期刊在投稿环节直接跑 statcheck。本模块：
  - LLM 仅做抽取（把 NHST 统计量抽成结构化）；
  - p 值用 scipy 确定性重算并比对（不靠 LLM 判断，可复现）；
  - 标出 一致 / 不一致 / 严重不一致(显著性翻转)。

对外: check_stats(text) -> {"ok", "items": [...], "summary": {...}}。
"""
from __future__ import annotations

import json
import math
import re

from .config import settings
from .llm import stream_chat


async def _extract(text: str) -> list[dict]:
    system = (
        "你是统计自查助手。从下面文本中抽取所有 NHST 统计检验报告(t 检验、F 检验、卡方 χ²、相关系数 r、z 检验)。"
        "只输出 JSON 数组，每项形如 "
        "{\"type\":\"t|F|chi2|r|z\",\"df1\":数或null,\"df2\":数或null,\"value\":统计量数值,"
        "\"p_text\":\"p 值原文(如 0.03 / <0.001 / = .045)\",\"raw\":\"原文片段\"}。"
        "t/卡方/r 的自由度放 df1；F 放 df1 与 df2。识别不到的字段填 null。不要编造数字，没有就不要输出该条。"
    )
    buf = ""
    async for piece in stream_chat(
        [{"role": "system", "content": system}, {"role": "user", "content": text[:6000]}],
        max_tokens=1500,
    ):
        buf += piece
    s, e = buf.find("["), buf.rfind("]")
    if s == -1 or e == -1:
        return []
    try:
        arr = json.loads(buf[s : e + 1])
    except Exception:  # noqa: BLE001
        return []
    return [it for it in arr if isinstance(it, dict) and it.get("type") and it.get("value") is not None]


def _parse_p(p_text: str):
    """从 p 值原文解析 (op, value, decimals)。op ∈ =/</>。"""
    if not p_text:
        return None
    t = str(p_text).strip()
    op = "<" if "<" in t else (">" if ">" in t else "=")
    m = re.search(r"(\d*\.\d+|\d+)", t)
    if not m:
        return None
    num = m.group(1)
    decimals = len(num.split(".")[1]) if "." in num else 0
    try:
        return op, float(num), decimals
    except ValueError:
        return None


def _recompute(it: dict):
    """用 scipy 按统计量+自由度重算 p(双侧)。返回 p 或 None。"""
    from scipy import stats

    typ = str(it.get("type", "")).lower()
    try:
        v = float(it["value"])
        df1 = float(it["df1"]) if it.get("df1") is not None else None
        df2 = float(it["df2"]) if it.get("df2") is not None else None
        if typ == "t" and df1:
            return float(2 * stats.t.sf(abs(v), df1))
        if typ == "f" and df1 and df2:
            return float(stats.f.sf(v, df1, df2))
        if typ in ("chi2", "χ2", "x2") and df1:
            return float(stats.chi2.sf(v, df1))
        if typ == "z":
            return float(2 * stats.norm.sf(abs(v)))
        if typ == "r" and df1 and abs(v) < 1:
            tval = v * math.sqrt(df1 / (1 - v * v))
            return float(2 * stats.t.sf(abs(tval), df1))
    except Exception:  # noqa: BLE001
        return None
    return None


def _classify(parsed, p_comp) -> str:
    if p_comp is None or parsed is None:
        return "unparsable"
    op, p_rep, decimals = parsed
    comp_sig = p_comp < 0.05
    if op == "=":
        rep_sig = p_rep < 0.05
        consistent = round(p_comp, max(decimals, 1)) == round(p_rep, max(decimals, 1))
    elif op == "<":
        rep_sig = p_rep <= 0.05
        consistent = p_comp < p_rep
    else:  # ">"
        rep_sig = False
        consistent = p_comp > p_rep
    if consistent:
        return "consistent"
    return "decision_error" if rep_sig != comp_sig else "inconsistent"


async def check_stats(text: str) -> dict:
    if not (text or "").strip():
        return {"ok": False, "error": "请粘贴含统计量的结果文字。"}
    if settings.mock:
        items = [
            {"raw": "t(38)=2.10, p=0.04", "type": "t", "df1": 38, "value": 2.10, "p_reported": "0.04", "p_computed": 0.0423, "status": "consistent"},
            {"raw": "t(28)=1.20, p=0.01", "type": "t", "df1": 28, "value": 1.20, "p_reported": "0.01", "p_computed": 0.24, "status": "decision_error"},
        ]
        return {"ok": True, "items": items, "summary": {"total": 2, "inconsistent": 0, "decision_error": 1}}
    try:
        extracted = await _extract(text)
        if not extracted:
            return {"ok": False, "error": "未识别到可核验的统计量（t/F/χ²/r/z + 自由度 + p）。"}
        items = []
        for it in extracted:
            parsed = _parse_p(it.get("p_text", ""))
            p_comp = _recompute(it)
            status = _classify(parsed, p_comp)
            items.append({
                "raw": str(it.get("raw") or "").strip(),
                "type": it.get("type"),
                "df1": it.get("df1"),
                "df2": it.get("df2"),
                "value": it.get("value"),
                "p_reported": str(it.get("p_text") or ""),
                "p_computed": (round(p_comp, 4) if p_comp is not None else None),
                "status": status,
            })
        summary = {
            "total": len(items),
            "inconsistent": sum(1 for x in items if x["status"] == "inconsistent"),
            "decision_error": sum(1 for x in items if x["status"] == "decision_error"),
        }
        return {"ok": True, "items": items, "summary": summary}
    except Exception as e:  # noqa: BLE001
        import traceback
        print("[statcheck] exception:\n" + traceback.format_exc(), flush=True)
        return {"ok": False, "error": f"统计自查出错：{type(e).__name__}: {e}"}

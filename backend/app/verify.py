"""LLM 输出回引校验器 (Cross-reference Verifier)。

背景:
  用户/评审多次投诉 LLM 编造"见方法学 §2.3"、"图 3 显示 p=0.03"、"表 2 第 4 行"这类
  精确定位式引用, 而原稿里根本没有对应位置或数值。本模块提供**确定性检查**:
  抓取 LLM 输出里的"位置引用/数值引用/文献引用", 反查原始材料是否真的存在,
  不存在则标记 ⚠️, 交由前端展示"疑似幻觉"警告。

设计原则:
  - 只做检测, 不改写 LLM 输出 (由前端决定是否强制拒绝导出)
  - 保守: 只报告"高置信度的可疑引用", 避免假阳性淹没真信号
  - 无依赖: 纯 re + str, 不引 nltk / spacy

用法:
    warnings = verify_references(output=letter, source=manuscript)
    for w in warnings:
        yield ("warning", {"message": w})
"""
from __future__ import annotations

import re
from typing import Iterable


# 章节/图表引用: "见方法学 2.3 节" / "Method §2.3" / "Table 4" / "图 3" / "Fig.5"
_SEC_PATTERNS = [
    re.compile(r"(?:见|参见|详见|如)\s*([一二三四五六七八九十\d]+(?:\.\d+)*)\s*节"),
    re.compile(r"(?:方法学|Methods|结果|Results|讨论|Discussion|引言|Introduction)\s*(?:第|§|Sec\.?|Section)?\s*([\d.]+)", re.I),
    re.compile(r"§\s*(\d+(?:\.\d+)*)"),
    re.compile(r"(?:图|Fig(?:ure)?|Table|表)\s*\.?\s*(\d+[a-zA-Z]?)", re.I),
]

# 数值引用: p 值 / n 值 / 百分比 / OR/HR/RR
_NUM_PATTERNS = {
    "p_value": re.compile(r"[pP]\s*[=＝<>≤≥]\s*(0?\.\d+|\d+\.\d+e-?\d+)"),
    "n": re.compile(r"[nN]\s*=\s*(\d{2,7})\b"),
    "percent": re.compile(r"(\d+(?:\.\d+)?)\s*%"),
    "or_hr_rr": re.compile(r"\b(?:OR|HR|RR|AUC)\s*[=＝]\s*(\d+\.\d+)", re.I),
}

# 引用编号 [12] / [Smith 2020]
_CITE_PATTERN = re.compile(r"\[(\d+(?:[,\-–]\d+)*)\]")


def _norm(s: str) -> str:
    """归一化: 去所有空白 + 转小写, 便于子串匹配跨换行/多空格。"""
    return re.sub(r"\s+", "", s or "").lower()


def _num_in_source(num_str: str, source_norm: str) -> bool:
    """数值是否在源里出现 (允许 0.03 与 .03 等价)。"""
    variants = {num_str, num_str.lstrip("0"), num_str.lstrip("0.")}
    if num_str.startswith("0."):
        variants.add(num_str[1:])
    for v in variants:
        if v and v in source_norm:
            return True
    return False


def _label_in_source(label: str, source_norm: str) -> bool:
    """章节/图表编号是否在源里出现。允许"2.3"匹配"2.3节/2.3小节/Section 2.3"等。"""
    return _norm(label) in source_norm


def verify_references(output: str, source: str, kinds: Iterable[str] | None = None) -> list[str]:
    """反查 output 里的引用是否在 source 里存在。

    Args:
        output: LLM 生成文本(如 letter/checklist/discussion)
        source: 原始材料(稿件/审稿意见/统计输出)
        kinds:  要检查的类型子集, 默认全查; 可选 {"section", "number", "cite"}

    Returns:
        警告字符串列表, 空列表表示未检出可疑引用。
    """
    if not output or not source:
        return []
    checks = set(kinds) if kinds else {"section", "number", "cite"}
    src_norm = _norm(source)
    warnings: list[str] = []

    if "section" in checks:
        seen: set[str] = set()
        for pat in _SEC_PATTERNS:
            for m in pat.finditer(output):
                label = m.group(1)
                if label in seen:
                    continue
                seen.add(label)
                if not _label_in_source(label, src_norm):
                    ctx = m.group(0)
                    warnings.append(f"疑似编造章节/图表位置: 「{ctx}」在原稿中未找到对应锚点")
                    if len(warnings) >= 20:  # 上限, 防止刷屏
                        return warnings

    if "number" in checks:
        for kind, pat in _NUM_PATTERNS.items():
            seen_n: set[str] = set()
            for m in pat.finditer(output):
                num = m.group(1)
                if num in seen_n:
                    continue
                seen_n.add(num)
                if not _num_in_source(num, src_norm):
                    ctx = m.group(0)
                    warnings.append(f"疑似编造数值({kind}): 「{ctx}」在原始输出/材料中未出现")
                    if len(warnings) >= 20:
                        return warnings

    if "cite" in checks:
        # 引用编号: [12] 若源里既没有 "12." 也没有 "[12]" 则可疑
        for m in _CITE_PATTERN.finditer(output):
            token = m.group(1)
            # 拆解范围引用 [1-3] / [1,3,5]
            nums = re.split(r"[,\-–]", token)
            for n in nums:
                n = n.strip()
                if not n:
                    continue
                if n not in src_norm and f"[{n}]" not in src_norm and f"{n}." not in src_norm:
                    warnings.append(f"疑似编造引用编号: [{n}] 未在原始参考文献列表出现")
                    if len(warnings) >= 20:
                        return warnings

    return warnings


def scan_hallucination_risk(text: str) -> dict:
    """无源引对照时的启发式风险扫描 (仅统计, 不告警)。

    用于给用户展示"这段回复里包含 N 个精确定位引用, 请人工核对":
      {
        "section_refs": 3,      # 见方法学 2.3 / Table 4
        "p_values": 2,          # p=0.03
        "citations": 5,         # [1,2,5]
        "risky": True/False     # 是否至少含一处高风险引用
      }
    """
    if not text:
        return {"section_refs": 0, "p_values": 0, "citations": 0, "risky": False}
    sec = sum(len(pat.findall(text)) for pat in _SEC_PATTERNS)
    pv = len(_NUM_PATTERNS["p_value"].findall(text))
    cite = len(_CITE_PATTERN.findall(text))
    return {
        "section_refs": sec,
        "p_values": pv,
        "citations": cite,
        "risky": (sec + pv + cite) > 0,
    }

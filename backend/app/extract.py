"""从上传的文档中抽取纯文本, 供模型分析或润色。

支持: .docx / .pdf / .xlsx / .xls / .csv / .txt / .md
返回: {"ok": bool, "text": str, "kind": str, "truncated": bool, "warnings": [str]}
       或 {"ok": False, "error": str}

隐私说明:
  - CSV/Excel: 表格文档若返回给需要上传到 LLM 的模块(IMRaD/润色等), 直接外发原始行
    等于把病历上云。这里对表格类文档改为返回"结构画像 + 极少量匿名样例",
    行级 PHI 不再外发。若确实需要行级数据(如数据分析模块), 请走 `analyze_data`
    的本地沙箱路径, 不经过这里。
  - docx: 剔除修订痕迹(w:ins/w:del) 与批注引用, 避免"作者删掉的旧句"随排版稿投出去。
"""
from __future__ import annotations

import io

import pandas as pd

from .textio import decode_text, read_csv_bytes

MAX_CHARS = 50000  # 防止超长文档撑爆上下文/额度


def _cap(text: str) -> tuple[str, bool]:
    text = text.strip()
    if len(text) > MAX_CHARS:
        return text[:MAX_CHARS] + "\n\n…（内容过长已截断）", True
    return text, False


def _table_text(df: pd.DataFrame) -> str:
    """把表格转成"结构画像文本", 只披露列名/dtype/汇总统计, 不外发行级数据。

    - 数值列: describe() 汇总量(count/mean/std/min/quartile/max) — 常规脱敏
    - 分类列: 唯一值 <= 20 时展示"取值(计数)"; 高基数列不展示原始值
    - 不再返回 df.to_string() 全量行
    """
    n_rows, n_cols = df.shape
    lines = [f"表格规模: {n_rows} 行 × {n_cols} 列。"]
    numeric = list(df.select_dtypes(include="number").columns)
    categorical = [c for c in df.columns if c not in numeric]
    lines.append("列信息：")
    for col in df.columns:
        dtype = str(df[col].dtype)
        nuniq = int(df[col].nunique(dropna=True))
        miss = int(df[col].isna().sum())
        line = f"  - {col}（{dtype}，唯一值{nuniq}，缺失{miss}）"
        looks_id_like = n_rows > 0 and (nuniq / n_rows) >= 0.9
        if col in categorical and 0 < nuniq <= 20 and n_rows >= 10 and not looks_id_like:
            vc = df[col].value_counts(dropna=True).head(6)
            pairs = ", ".join(f"{k}({int(v)})" for k, v in vc.items())
            if pairs:
                line += f" 主要取值: {pairs}"
        elif looks_id_like:
            line += " [疑似ID/姓名列, 不展示样例]"
        lines.append(line)
    if numeric and n_rows >= 5:
        try:
            lines.append("\n数值列描述统计(汇总, 非行级)：")
            lines.append(df[numeric].describe().round(3).to_string())
        except Exception:  # noqa: BLE001
            pass
    lines.append("\n注: 出于隐私保护, 未外发行级样本。")
    return "\n".join(lines)


# docx 修订/批注剔除: 直接删除 w:ins/w:del/w:commentReference 等元素后再读文本,
# 避免"作者删掉的旧句"和"审阅气泡"随排版稿一起进入 LLM/最终稿。
_W_NS = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
_TRACKED_TAGS = ("del", "commentReference", "commentRangeStart", "commentRangeEnd")


def _strip_tracked_changes(doc) -> int:
    """删除已跟踪的删除/批注 XML 节点; w:ins 保留其文本(是"已插入"的正文)。
    返回删除的节点数, 供上层给用户提示"检测到修订痕迹"。
    """
    removed = 0
    body = doc.element.body
    for tag in _TRACKED_TAGS:
        for el in list(body.iter(_W_NS + tag)):
            parent = el.getparent()
            if parent is not None:
                parent.remove(el)
                removed += 1
    return removed


def extract_text(filename: str, content: bytes) -> dict:
    name = (filename or "").lower()
    warnings: list[str] = []
    try:
        if name.endswith(".docx"):
            from docx import Document

            doc = Document(io.BytesIO(content))
            n_removed = _strip_tracked_changes(doc)
            if n_removed:
                warnings.append(f"检测到 {n_removed} 处修订痕迹/批注, 已剔除, 请核对最终稿。")
            parts = [p.text for p in doc.paragraphs if p.text.strip()]
            for t in doc.tables:
                for row in t.rows:
                    cells = [c.text.strip() for c in row.cells]
                    if any(cells):
                        parts.append(" | ".join(cells))
            text, truncated = _cap("\n".join(parts))
            return {"ok": True, "text": text, "kind": "docx", "truncated": truncated, "warnings": warnings}

        if name.endswith(".pdf"):
            from pypdf import PdfReader

            reader = PdfReader(io.BytesIO(content))
            pages = [(page.extract_text() or "") for page in reader.pages]
            joined = "\n\n".join(p.strip() for p in pages if p.strip())
            if not joined:
                return {"ok": False, "error": "这个 PDF 没有可提取的文字（可能是扫描件/图片型 PDF）。"}
            text, truncated = _cap(joined)
            return {"ok": True, "text": text, "kind": "pdf", "truncated": truncated, "warnings": warnings}

        if name.endswith((".xlsx", ".xls")):
            df = pd.read_excel(io.BytesIO(content))
            warnings.append("为保护隐私, 表格文档只返回列名与汇总统计, 未外发原始行。如需行级分析请使用【数据分析】模块(本地沙箱)。")
            text, truncated = _cap(_table_text(df))
            return {"ok": True, "text": text, "kind": "excel", "truncated": truncated, "warnings": warnings}

        if name.endswith(".csv"):
            df = read_csv_bytes(content)
            warnings.append("为保护隐私, 表格文档只返回列名与汇总统计, 未外发原始行。如需行级分析请使用【数据分析】模块(本地沙箱)。")
            text, truncated = _cap(_table_text(df))
            return {"ok": True, "text": text, "kind": "csv", "truncated": truncated, "warnings": warnings}

        if name.endswith((".txt", ".md")):
            text, truncated = _cap(decode_text(content))
            return {"ok": True, "text": text, "kind": "text", "truncated": truncated, "warnings": warnings}

        return {"ok": False, "error": "暂不支持这种文件类型（支持 Word/PDF/Excel/CSV/txt）。"}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"解析文件失败：{e}"}

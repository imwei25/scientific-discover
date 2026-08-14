#!/usr/bin/env python3
"""对本机 Zotero 文献做"全文证据检索"（PaperQA2-lite）。

流程：取源文献全文 → 分块（带页码锚点）→ TF-IDF 对问题排序 → 输出 top-k 证据段。
本脚本**只做确定性检索**，不调用大模型：它产出 `zotero_evidence.md/.csv`，
由上层 agent（opencode）据此撰写**带引用**的回答（脚本管取证、模型管综合，
与本仓库其它技能一致，避免脚本内嵌 LLM 调用）。

源可来自：
  --collection KEY     某分类的全部文献（经 Zotero 本地 API 导入题录 + 全文）
  --items K1,K2,...     指定条目 key
  --pdf-dir DIR         离线：直接对一批本地 PDF（不经 Zotero，便于测试/无库场景）

限制：TF-IDF 走词级匹配，对**英文**摘要/全文有效；中文问题对英文全文命中弱
（与 literature-review/ground_claim.py 同源限制）。向量嵌入重排为后续升级项。
"""
from __future__ import annotations

import argparse
import csv
import json
import re
import sys
from pathlib import Path

for _s in (sys.stdout, sys.stderr):  # Windows 控制台 GBK → 强制 UTF-8，避免中文乱码
    try:
        _s.reconfigure(encoding="utf-8")  # type: ignore[union-attr]
    except Exception:  # noqa: BLE001
        pass

sys.path.insert(0, str(Path(__file__).resolve().parent))
import zotero_read as zr  # noqa: E402


def _chunk_text(text: str, page: int | str, words_per_chunk: int = 220,
                overlap: int = 40) -> list[dict]:
    """把一段文本切成带重叠的块；每块记录来源页码。"""
    words = text.split()
    if not words:
        return []
    chunks = []
    step = max(1, words_per_chunk - overlap)
    for i in range(0, len(words), step):
        piece = " ".join(words[i:i + words_per_chunk]).strip()
        if len(piece) >= 60:  # 丢弃太短的碎片
            chunks.append({"page": page, "text": piece})
        if i + words_per_chunk >= len(words):
            break
    return chunks


def _gather_from_zotero(items: list[dict], data_dir: Path,
                        max_pages: int | None) -> list[dict]:
    """对每个条目取全文并分块，块上挂题录引用信息。"""
    chunks: list[dict] = []
    for it in items:
        cite = {
            "key": it.get("key", ""),
            "title": it.get("title", "") or "(无题)",
            "author": it.get("first_author", "") or "",
            "year": it.get("year", "") or "",
        }
        try:
            ft = zr.item_fulltext(it["key"], data_dir, max_pages)
        except Exception as e:  # noqa: BLE001
            print(f"[warn] {cite['title'][:40]}… 取全文失败：{e}", file=sys.stderr)
            continue
        if ft.get("pages"):  # pymupdf 路径：按页分块，页码精确
            for pno, ptext in ft["pages"]:
                for ch in _chunk_text(ptext, pno):
                    chunks.append({**ch, "cite": cite})
        else:  # zotero 预索引：无页码，整体分块
            for ch in _chunk_text(ft.get("text", ""), "?"):
                chunks.append({**ch, "cite": cite})
    return chunks


def _gather_from_pdfs(pdf_dir: Path, max_pages: int | None) -> list[dict]:
    import fitz  # pymupdf
    chunks: list[dict] = []
    for pdf in sorted(pdf_dir.glob("*.pdf")):
        cite = {"key": "", "title": pdf.stem, "author": "", "year": ""}
        try:
            with fitz.open(str(pdf)) as doc:
                for i, pg in enumerate(doc):
                    if max_pages and i >= max_pages:
                        break
                    for ch in _chunk_text(pg.get_text("text"), i + 1):
                        chunks.append({**ch, "cite": cite})
        except Exception as e:  # noqa: BLE001
            print(f"[warn] 读 {pdf.name} 失败：{e}", file=sys.stderr)
    return chunks


def _rank_tfidf(question: str, chunks: list[dict], top_k: int) -> list[dict]:
    """词级 TF-IDF + 余弦（离线兜底；英文有效，跨语言弱）。"""
    from sklearn.feature_extraction.text import TfidfVectorizer
    from sklearn.metrics.pairwise import cosine_similarity
    corpus = [c["text"] for c in chunks]
    vec = TfidfVectorizer(ngram_range=(1, 2), token_pattern=r"(?u)\b\w+\b",
                          min_df=1, sublinear_tf=True, stop_words="english")
    mat = vec.fit_transform(corpus + [question])
    sims = cosine_similarity(mat[-1], mat[:-1]).ravel()
    return _topk(chunks, sims, top_k)


def _resolve_model(model_dir: str | None, model_id: str) -> str:
    """定位本地嵌入模型目录：--model-dir > 环境变量 ZOTERO_EMBED_MODEL >
    ModelScope 缓存（缺则用 modelscope snapshot_download 下载一次）。全程不触 tokenhub。"""
    import os
    for cand in (model_dir, os.environ.get("ZOTERO_EMBED_MODEL")):
        if cand and Path(cand).is_dir():
            return cand
    # ModelScope 默认缓存命中即用（免联网校验、可离线）
    cache = (Path(os.environ.get("MODELSCOPE_CACHE") or (Path.home() / ".cache/modelscope"))
             / "models" / model_id.replace("/", "--") / "snapshots" / "master")
    if (cache / "config.json").is_file():
        return str(cache)
    from modelscope import snapshot_download  # 首次下载到 ~/.cache/modelscope
    print(f"[embed] 从 ModelScope 下载模型 {model_id} …", file=sys.stderr)
    return snapshot_download(model_id)


def _rank_embed(question: str, chunks: list[dict], top_k: int,
                model_dir: str | None, model_id: str) -> list[dict]:
    """本地稠密嵌入（sentence-transformers）+ 余弦。多语模型可跨中英语义匹配。"""
    import numpy as np
    from sentence_transformers import SentenceTransformer
    path = _resolve_model(model_dir, model_id)
    model = SentenceTransformer(path, device="cpu")
    texts = [c["text"] for c in chunks]
    emb = model.encode(texts, normalize_embeddings=True, batch_size=32,
                       show_progress_bar=False)
    q = model.encode([question], normalize_embeddings=True)[0]
    sims = np.asarray(emb) @ np.asarray(q)  # 已归一化，点积即余弦
    return _topk(chunks, sims, top_k)


def _topk(chunks: list[dict], sims, top_k: int) -> list[dict]:
    order = sims.argsort()[::-1][:top_k]
    return [{**chunks[i], "score": round(float(sims[i]), 4), "rank": r}
            for r, i in enumerate(order, 1)]


def _rerank_cross(question: str, cands: list[dict], top_k: int,
                  model_dir: str | None, model_id: str) -> list[dict]:
    """cross-encoder 精排：对每个 (问题, 段落) 打相关性分，重排召回候选。
    本地 BCE reranker，跨中英，**不触任何远程端点**。这是"精排"的标准做法
    （非生成式 LLM；PaperQA2 的 RCS 才用生成模型逐段摘要+打分）。"""
    from sentence_transformers import CrossEncoder
    path = _resolve_model(model_dir, model_id)
    ce = CrossEncoder(path, max_length=512, device="cpu")
    scores = ce.predict([(question, c["text"]) for c in cands],
                        batch_size=16, show_progress_bar=False)
    ranked = sorted(zip(cands, scores), key=lambda z: float(z[1]), reverse=True)[:top_k]
    return [{**c, "recall_score": c.get("score"),
             "score": round(float(s), 4), "rank": r}
            for r, (c, s) in enumerate(ranked, 1)]


def _cite_label(cite: dict, page) -> str:
    who = cite.get("author") or "?"
    yr = cite.get("year") or "?"
    pg = f" p.{page}" if page not in ("?", None) else ""
    return f"{who} {yr}{pg} — {cite.get('title', '')}"


# 分数低到这个程度，基本等于"没检索到"，只是排序把某一段推到了第一位。
# tfidf 是词面重合度：中文问题打英文全文时词面零重合，所有段落同为 0.0，
# 返回的第 1 名纯粹是遍历顺序的产物 —— 实测中文问阿司匹林，tfidf 把他汀的论文排到了第 1。
_WEAK_SCORE = 0.02


def _has_cjk(s: str) -> bool:
    return any("一" <= c <= "鿿" for c in s or "")


def _write_evidence(question: str, hits: list[dict], n_items: int, method: str,
                    md_path: Path, csv_path: Path) -> None:
    weak = [h for h in hits if float(h.get("score") or 0) < _WEAK_SCORE]
    warns = []
    # 【零分/近零分必须说破】证据表顶上写着"不得脱离下列证据编造"，
    # 读它的 agent 会当成可靠证据照单引用。分数接近 0 时这份表是有害的，必须当场警告。
    if weak:
        warns.append(
            f"⚠ **{len(weak)}/{len(hits)} 条命中的相关度接近 0（<{_WEAK_SCORE}）**，"
            "很可能【根本没检索到相关内容】，排序只是兜底产物。"
            "**不要把这些片段当作证据引用**；请改用 `--backend embed --rerank` 重跑，"
            "或换用与文献同语种的提问。")
    # 中文问题 + tfidf：这个组合几乎必然是词面零重合，提前点破，别等用户看分数
    if method.startswith("tfidf") and _has_cjk(question):
        warns.append(
            "⚠ **中文提问 + tfidf 后端**：tfidf 只比词面重合，中文问题打英文全文时"
            "几乎必然零命中。请用 `--backend embed --rerank`（本地模型，支持跨中英）。")

    lines = [f"# Zotero 全文证据检索\n",
             f"**问题**：{question}\n",
             f"**检索方式**：{method}\n",
             f"**证据来源**：本机 Zotero，{n_items} 篇文献，命中 {len(hits)} 段。\n"]
    for w in warns:
        lines.append(w + "\n")
    lines.append("> 以下为按相关性排序的原文片段，供撰写带引用回答之用。"
                 "**每条主张须落到具体片段，不得脱离下列证据编造；"
                 "标注了「相关度过低」的片段一律不得引用。**\n")
    for h in hits:
        low = " ⚠ 相关度过低，勿引用" if float(h.get("score") or 0) < _WEAK_SCORE else ""
        lines.append(f"\n## [{h['rank']}] {_cite_label(h['cite'], h['page'])}  "
                     f"(score={h['score']}, itemKey={h['cite'].get('key', '')}){low}\n")
        lines.append("> " + re.sub(r"\s+", " ", h["text"]).strip())
    md_path.write_text("\n".join(lines), encoding="utf-8")

    with open(csv_path, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f)
        # weak 列供程序化消费：读 CSV 的一方同样要能一眼看出"这条不能引"
        w.writerow(["rank", "score", "weak", "author", "year", "page",
                    "item_key", "title", "passage"])
        for h in hits:
            w.writerow([h["rank"], h["score"],
                        1 if float(h.get("score") or 0) < _WEAK_SCORE else 0,
                        h["cite"].get("author", ""),
                        h["cite"].get("year", ""), h["page"],
                        h["cite"].get("key", ""), h["cite"].get("title", ""),
                        re.sub(r"\s+", " ", h["text"]).strip()])


def main() -> None:
    ap = argparse.ArgumentParser(description="Zotero 全文证据检索（PaperQA2-lite）")
    ap.add_argument("--question", required=True, help="要回答的问题")
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--collection", help="Zotero 分类 key（导入该分类全部文献）")
    src.add_argument("--library", action="store_true",
                     help="整库顶层 My Library（没建分类文件夹时用）")
    src.add_argument("--items", help="逗号分隔的条目 key")
    src.add_argument("--pdf-dir", help="离线：直接对一目录下的 PDF")
    ap.add_argument("--data-dir", default=None, help="Zotero 数据目录（默认 ~/Zotero）")
    ap.add_argument("--backend", choices=("tfidf", "embed"), default="tfidf",
                    help="检索后端：tfidf(离线兜底) / embed(本地稠密嵌入，跨中英)")
    ap.add_argument("--model-dir", default=None,
                    help="本地嵌入模型目录（缺则用 ModelScope 缓存/下载）")
    ap.add_argument("--model-id", default="maidalun/bce-embedding-base_v1",
                    help="ModelScope 模型 id（backend=embed 且未给 model-dir 时用）")
    ap.add_argument("--rerank", action="store_true",
                    help="两段式：召回后用 cross-encoder 精排（本地 BCE reranker，不触端点）")
    ap.add_argument("--rerank-topn", type=int, default=30,
                    help="送入精排的召回候选数（默认 30）")
    ap.add_argument("--rerank-model", default="maidalun/bce-reranker-base_v1",
                    help="ModelScope reranker 模型 id")
    ap.add_argument("--rerank-dir", default=None, help="本地 reranker 模型目录")
    ap.add_argument("--top-k", type=int, default=12, help="输出证据段数（默认 12）")
    ap.add_argument("--max-pages", type=int, default=None, help="每篇最多解析页数")
    ap.add_argument("--cap", type=int, default=200, help="分类导入上限")
    ap.add_argument("--out-md", default="zotero_evidence.md")
    ap.add_argument("--out-csv", default="zotero_evidence.csv")
    args = ap.parse_args()

    data_dir = zr.zotero_data_dir(args.data_dir)

    if args.pdf_dir:
        n_items = len(list(Path(args.pdf_dir).glob("*.pdf")))
        chunks = _gather_from_pdfs(Path(args.pdf_dir), args.max_pages)
    else:
        if args.collection or args.library:
            try:
                items = (zr._import_top(args.cap) if args.library
                         else zr._import_collection(args.collection, args.cap))
            except Exception as e:  # noqa: BLE001
                zr._zotero_down(str(e))
        else:
            keys = [k.strip() for k in args.items.split(",") if k.strip()]
            items = []
            for k in keys:
                try:
                    raw = zr._get_json(f"{zr._API}/items/{k}")
                    m = zr.map_source(raw)
                    items.append(m or {"key": k, "title": "", "first_author": "",
                                       "year": ""})
                except Exception as e:  # noqa: BLE001
                    zr._zotero_down(str(e))
        n_items = len(items)
        chunks = _gather_from_zotero(items, data_dir, args.max_pages)

    if not chunks:
        print(json.dumps({"ok": False, "error": "no_text",
                          "hint": "未能从源文献取到任何可检索全文（PDF 缺失或未索引）。"},
                         ensure_ascii=False))
        sys.exit(4)

    # 第一段：召回（tfidf / 本地嵌入）。开精排时先多召回 rerank_topn 个候选。
    recall_k = max(args.top_k, args.rerank_topn) if args.rerank else args.top_k
    if args.backend == "embed":
        cands = _rank_embed(args.question, chunks, recall_k, args.model_dir, args.model_id)
    else:
        cands = _rank_tfidf(args.question, chunks, recall_k)
    # 第二段：cross-encoder 精排（可选）
    if args.rerank:
        hits = _rerank_cross(args.question, cands, args.top_k,
                             args.rerank_dir, args.rerank_model)
        method = f"{args.backend} 召回 → BCE cross-encoder 精排"
    else:
        hits = cands[:args.top_k]
        method = f"{args.backend} 召回（无精排）"
    _write_evidence(args.question, hits, n_items, method,
                    Path(args.out_md), Path(args.out_csv))
    print(json.dumps({"ok": True, "backend": args.backend, "rerank": args.rerank,
                      "items": n_items, "chunks": len(chunks), "hits": len(hits),
                      "out_md": args.out_md, "out_csv": args.out_csv},
                     ensure_ascii=False))


if __name__ == "__main__":
    main()

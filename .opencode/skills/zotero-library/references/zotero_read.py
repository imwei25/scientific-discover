#!/usr/bin/env python3
"""读取本机 Zotero 文献库（Zotero 7 本地 API + 本地 storage 目录）。

**运行位置铁律**：本脚本必须跑在**用户自己的机器上**（opencode/技能与 Zotero
桌面端同机），因为它访问 `127.0.0.1:23119` 本地 API 与本地 storage 目录里的 PDF。
中心服务器多用户部署下，服务器打 127.0.0.1 只会打到服务器自身，读不到用户电脑的
Zotero —— 那种场景需走浏览器侧，不在本脚本职责内。

前提：Zotero 桌面端运行中，且用户已在 设置 → 高级 勾选
"允许本机其它应用与 Zotero 通信"（Zotero 7 起默认开本地 API 的读取）。
所有请求走 127.0.0.1:23119，不触网。

子命令：
  probe                       探测 Zotero 是否在运行（running/api/connector）
  collections                 列出本地库分类 [{key,name,count}]
  items <collection_key>      读某分类条目 → 统一 Reference（JSON/CSV）
  attachments <item_key>      列该条目的 PDF 附件及其本地磁盘路径
  fulltext <item_key>         取该条目 PDF 全文（Zotero 预索引优先，回退 pymupdf）

只读；从不写用户库（回写是另一条路，本技能不做，避免误改用户文献库）。
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import re
import shutil
import sys
import urllib.error
import urllib.request
from pathlib import Path

# Windows 控制台默认 GBK，会把 UTF-8 的中文输出显示/传成乱码；强制 UTF-8 I/O。
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8")  # type: ignore[union-attr]
    except Exception:  # noqa: BLE001
        pass

ZOTERO_BASE = "http://127.0.0.1:23119"
_API = f"{ZOTERO_BASE}/api/users/0"      # 本地库 userID 恒为 0
_CONNECTOR = f"{ZOTERO_BASE}/connector"
_PROBE_TIMEOUT = 1.5
_IO_TIMEOUT = 4.0
_UA = "sci-skill-zotero-library/1.0"

# 只当作"文献型"条目导入；附件/笔记/独立标签跳过。
_REF_TYPES = {
    "journalArticle", "conferencePaper", "preprint", "book", "bookSection",
    "report", "thesis", "magazineArticle", "newspaperArticle", "document",
}


# ---------------------------------------------------------------- HTTP (stdlib)
def _get(url: str, timeout: float = _IO_TIMEOUT) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": _UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:  # noqa: S310 (localhost only)
        return r.read()


def _get_json(url: str, timeout: float = _IO_TIMEOUT):
    return json.loads(_get(url, timeout).decode("utf-8", "replace"))


def _post_json(url: str, payload, timeout: float = _IO_TIMEOUT, headers: dict | None = None):
    data = json.dumps(payload).encode("utf-8")
    h = {"User-Agent": _UA, "Content-Type": "application/json"}
    if headers:
        h.update(headers)
    req = urllib.request.Request(url, data=data, headers=h, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as r:  # noqa: S310 (localhost only)
        return r.read()


def _zotero_down(detail: str = "") -> None:
    """统一的"Zotero 不可达"退出：非 0 退出码 + 结构化提示，便于上层优雅回退。"""
    msg = {
        "ok": False,
        "error": "zotero_unreachable",
        "hint": ("未检测到运行中的 Zotero 本地 API（127.0.0.1:23119）。请确认："
                 "1) Zotero 桌面端正在运行；2) 设置→高级 勾选'允许本机其它应用与 Zotero 通信'；"
                 "3) 本技能与 Zotero 在同一台机器上。"),
    }
    if detail:
        msg["detail"] = detail
    print(json.dumps(msg, ensure_ascii=False))
    sys.exit(3)


# ---------------------------------------------------------------- 映射
def _split_name(c: dict) -> str:
    if c.get("name"):
        return str(c["name"]).strip()
    last = (c.get("lastName") or "").strip()
    first = (c.get("firstName") or "").strip()
    return f"{last} {first}".strip()


def _is_pdf_attachment(d: dict) -> bool:
    ctype = (d.get("contentType") or "").lower()
    fname = d.get("filename") or ""
    return d.get("itemType") == "attachment" and (
        "pdf" in ctype or fname.lower().endswith(".pdf"))


def map_source(raw: dict) -> dict | None:
    """比 map_item 宽松：文献型 → Reference；**独立 PDF 附件**也纳入（题名取文件名）。
    用于全文检索场景——很多用户直接把 PDF 拖进 Zotero，形成顶层独立附件。"""
    m = map_item(raw)
    if m:
        return m
    d = raw.get("data") or {}
    if _is_pdf_attachment(d):
        fname = d.get("filename") or d.get("title") or "(PDF)"
        return {
            "key": raw.get("key") or d.get("key") or "",
            "title": fname, "authors": [], "first_author": "",
            "journal": "", "year": "", "doi": "", "url": "",
            "abstract": "", "source": "zotero_attachment",
        }
    return None


def map_item(raw: dict) -> dict | None:
    """Zotero 本地 API 条目 → 统一 Reference；非文献型返回 None。"""
    d = raw.get("data") or {}
    if d.get("itemType") not in _REF_TYPES:
        return None
    creators = [c for c in (d.get("creators") or []) if c.get("creatorType") == "author"] \
        or (d.get("creators") or [])
    authors = [_split_name(c) for c in creators if _split_name(c)]
    doi = (d.get("DOI") or "").strip()
    m = re.search(r"\b(\d{4})\b", (d.get("date") or ""))
    year = m.group(1) if m else ""
    url = (d.get("url") or "").strip() or (f"https://doi.org/{doi}" if doi else "")
    return {
        "key": raw.get("key") or d.get("key") or "",
        "title": (d.get("title") or "").strip(),
        "authors": authors,
        "first_author": authors[0] if authors else "",
        "journal": (d.get("publicationTitle") or d.get("bookTitle") or "").strip(),
        "year": year,
        "doi": doi,
        "url": url,
        "abstract": (d.get("abstractNote") or "").strip(),
        "source": "zotero",
    }


# ---------------------------------------------------------------- 数据目录
def zotero_data_dir(override: str | None = None) -> Path:
    """定位 Zotero 数据目录（storage/ 的父目录）。
    优先级：--data-dir > 环境变量 ZOTERO_DATA_DIR > 默认 ~/Zotero。
    """
    for cand in (override, os.environ.get("ZOTERO_DATA_DIR"), str(Path.home() / "Zotero")):
        if cand and (Path(cand) / "storage").is_dir():
            return Path(cand)
    # 退一步：返回默认路径本身（即便 storage 还不在，也让调用方拿到明确路径去报错）
    return Path(override or os.environ.get("ZOTERO_DATA_DIR") or (Path.home() / "Zotero"))


# ---------------------------------------------------------------- 子命令
def cmd_probe(_args) -> None:
    api_ok = connector_ok = False
    try:
        _get(f"{_API}/collections?limit=1", timeout=_PROBE_TIMEOUT)
        api_ok = True
    except Exception:  # noqa: BLE001
        api_ok = False
    try:
        _get(f"{_CONNECTOR}/ping", timeout=_PROBE_TIMEOUT)
        connector_ok = True
    except urllib.error.HTTPError as e:
        connector_ok = e.code in (200, 204, 405)  # ping 有时对 GET 返回 405，但服务在
    except Exception:  # noqa: BLE001
        connector_ok = False
    print(json.dumps({
        "ok": True, "running": api_ok or connector_ok,
        "api": api_ok, "connector": connector_ok,
        "data_dir": str(zotero_data_dir(_args.data_dir)),
    }, ensure_ascii=False))


def cmd_collections(args) -> None:
    try:
        data = _get_json(f"{_API}/collections?limit=200")
    except Exception as e:  # noqa: BLE001
        _zotero_down(str(e))
    out = []
    for c in data:
        out.append({
            "key": c.get("key") or (c.get("data") or {}).get("key") or "",
            "name": (c.get("data") or {}).get("name") or "",
            "count": (c.get("meta") or {}).get("numItems", 0),
        })
    out = [c for c in out if c["key"] and c["name"]]
    print(json.dumps({"ok": True, "collections": out}, ensure_ascii=False, indent=2))


def _paginate_items(path: str, cap: int) -> list[dict]:
    """按分页累积某端点的条目 → 统一 Reference（上限 cap）。本地 API 单页上限 100。"""
    out: list[dict] = []
    start = 0
    while len(out) < cap:
        page = min(100, cap - len(out))
        sep = "&" if "?" in path else "?"
        data = _get_json(f"{_API}/{path}{sep}limit={page}&start={start}")
        if not data:
            break
        out.extend(x for x in (map_source(v) for v in data) if x)
        if len(data) < page:
            break
        start += page
    return out[:cap]


def _import_collection(collection_key: str, cap: int) -> list[dict]:
    return _paginate_items(f"collections/{collection_key}/items", cap)


def _import_top(cap: int) -> list[dict]:
    """读整库顶层（My Library，不含子条目/附件）→ 统一 Reference。
    给没建分类文件夹、文献都堆在根层的用户用。"""
    return _paginate_items("items/top", cap)


def cmd_items(args) -> None:
    try:
        if args.top or not args.collection_key:
            refs = _import_top(args.cap)
        else:
            refs = _import_collection(args.collection_key, args.cap)
    except Exception as e:  # noqa: BLE001
        _zotero_down(str(e))
    _write_refs(refs, args.out, args.csv)
    print(json.dumps({"ok": True, "count": len(refs),
                      "out": args.out, "csv": args.csv}, ensure_ascii=False))


def _attachment_record(d: dict, akey: str, data_dir: Path) -> dict | None:
    if not _is_pdf_attachment(d):
        return None
    fname = d.get("filename") or ""
    link = d.get("linkMode") or ""
    if link == "linked_file":
        fpath = d.get("path") or ""  # 绝对路径（或 attachmentBase 相对，用户自管）
    else:  # imported_file / imported_url → storage/<akey>/<filename>
        fpath = str(data_dir / "storage" / akey / fname) if fname else ""
    return {"attachment_key": akey, "filename": fname, "link_mode": link,
            "path": fpath, "exists": bool(fpath) and Path(fpath).is_file()}


def item_attachments(item_key: str, data_dir: Path) -> list[dict]:
    """列一个条目的 PDF 附件及磁盘路径。兼容两种形态：
    (a) 文献条目 + PDF 子附件；(b) 顶层**独立 PDF 附件**（item_key 本身即附件）。"""
    # (b) 条目自身就是 PDF 附件（直接拖 PDF 进 Zotero 的常见情形）
    try:
        self_d = (_get_json(f"{_API}/items/{item_key}") or {}).get("data") or {}
        if self_d.get("itemType") == "attachment":
            rec = _attachment_record(self_d, item_key, data_dir)
            return [rec] if rec else []
    except Exception:  # noqa: BLE001
        pass
    # (a) 文献条目 → 遍历子附件
    atts = []
    for ch in _get_json(f"{_API}/items/{item_key}/children"):
        d = ch.get("data") or {}
        rec = _attachment_record(d, ch.get("key") or d.get("key") or "", data_dir)
        if rec:
            atts.append(rec)
    return atts


def cmd_attachments(args) -> None:
    dd = zotero_data_dir(args.data_dir)
    try:
        atts = item_attachments(args.item_key, dd)
    except Exception as e:  # noqa: BLE001
        _zotero_down(str(e))
    print(json.dumps({"ok": True, "item_key": args.item_key,
                      "data_dir": str(dd), "attachments": atts},
                     ensure_ascii=False, indent=2))


def item_fulltext(item_key: str, data_dir: Path, max_pages: int | None = None) -> dict:
    """取条目 PDF 全文。先试 Zotero 预索引（免解析），回退本地 PDF 解析。

    返回 {source, text, pages?}；pages 为 [(page_no, page_text), ...]（仅 pymupdf 路径有）。
    """
    atts = item_attachments(item_key, data_dir)
    pdf_atts = [a for a in atts if a["exists"]]
    # 1) Zotero 预索引全文（每个 PDF 附件一条），最省事、无需解析
    idx_texts = []
    for a in atts:
        try:
            j = _get_json(f"{_API}/items/{a['attachment_key']}/fulltext")
            c = (j or {}).get("content") or ""
            if c.strip():
                idx_texts.append(c)
        except Exception:  # noqa: BLE001
            pass
    if idx_texts:
        return {"source": "zotero_index", "text": "\n\n".join(idx_texts), "pages": None}
    # 2) 回退：本地 storage 里的 PDF → pymupdf 逐页
    if not pdf_atts:
        return {"source": "none", "text": "", "pages": None,
                "note": "无可读 PDF 附件，且 Zotero 未提供预索引全文"}
    pages: list[tuple[int, str]] = []
    for a in pdf_atts:
        try:
            import fitz  # pymupdf
        except Exception:  # noqa: BLE001
            return {"source": "error", "text": "",
                    "note": "需要 pymupdf（fitz）解析 PDF，但导入失败"}
        with fitz.open(a["path"]) as doc:
            for i, pg in enumerate(doc):
                if max_pages and i >= max_pages:
                    break
                pages.append((i + 1, pg.get_text("text")))
    return {"source": "pymupdf",
            "text": "\n\n".join(t for _, t in pages), "pages": pages}


def cmd_fulltext(args) -> None:
    dd = zotero_data_dir(args.data_dir)
    try:
        res = item_fulltext(args.item_key, dd, args.max_pages)
    except Exception as e:  # noqa: BLE001
        _zotero_down(str(e))
    print(json.dumps({"ok": True, "item_key": args.item_key,
                      "source": res.get("source"),
                      "chars": len(res.get("text") or ""),
                      "note": res.get("note", "")}, ensure_ascii=False))
    if args.out:
        Path(args.out).write_text(res.get("text") or "", encoding="utf-8")


# ---------------------------------------------------------------- 会话小库落地
def _resolve_items(collection_key, top, items_arg, cap) -> list[dict]:
    """按来源解析条目 → 统一 Reference（含独立 PDF 附件）。"""
    if items_arg:
        out = []
        for k in [x.strip() for x in items_arg.split(",") if x.strip()]:
            m = map_source(_get_json(f"{_API}/items/{k}"))
            out.append(m or {"key": k, "title": "", "first_author": "", "year": ""})
        return out
    if top or not collection_key:
        return _import_top(cap)
    return _import_collection(collection_key, cap)


def _safe_name(s: str) -> str:
    return re.sub(r"[^\w.\-]+", "_", s).strip("_")[:80] or "file"


def materialize_library(items: list[dict], data_dir: Path, to_dir: Path) -> dict:
    """把每篇的 PDF 附件**复制**进 to_dir（会话小库），并写 refs 清单。
    返回 {copied, no_pdf, refs}。命名 <key>_<原名> 防撞、可溯。"""
    to_dir.mkdir(parents=True, exist_ok=True)
    copied, no_pdf, kept = 0, 0, []
    for it in items:
        key = it.get("key", "")
        atts = [a for a in item_attachments(key, data_dir) if a["exists"]]
        if not atts:
            no_pdf += 1
            it = {**it, "pdf": ""}
            kept.append(it)
            continue
        src = atts[0]["path"]
        dst = to_dir / f"{key}_{_safe_name(Path(src).name)}"
        try:
            shutil.copyfile(src, dst)
            copied += 1
            kept.append({**it, "pdf": dst.name})
        except Exception as e:  # noqa: BLE001
            no_pdf += 1
            kept.append({**it, "pdf": "", "error": str(e)})
    _write_refs(kept, str(to_dir / "zotero_refs.json"), str(to_dir / "zotero_refs.csv"))
    return {"copied": copied, "no_pdf": no_pdf, "refs": kept}


def cmd_materialize(args) -> None:
    dd = zotero_data_dir(args.data_dir)
    try:
        items = _resolve_items(args.collection_key, args.top, args.items, args.cap)
    except Exception as e:  # noqa: BLE001
        _zotero_down(str(e))
    res = materialize_library(items, dd, Path(args.to))
    print(json.dumps({"ok": True, "to": args.to, "items": len(items),
                      "copied": res["copied"], "no_pdf": res["no_pdf"]},
                     ensure_ascii=False))


# ---------------------------------------------------------------- 回写 Zotero（写操作）
def _push_creators(ref: dict) -> list[dict]:
    out = []
    names = ref.get("authors") or ([ref["first_author"]] if ref.get("first_author") else [])
    for n in names:
        n = str(n).strip()
        if not n:
            continue
        parts = n.split()
        if len(parts) >= 2:
            out.append({"creatorType": "author", "lastName": parts[0],
                        "firstName": " ".join(parts[1:])})
        else:
            out.append({"creatorType": "author", "name": n})
    return out


def build_push_payload(refs: list[dict]) -> dict:
    items = [{
        "itemType": "journalArticle", "title": r.get("title") or "",
        "creators": _push_creators(r), "date": str(r.get("year") or ""),
        "DOI": r.get("doi") or "", "url": r.get("url") or "",
        "publicationTitle": r.get("journal") or "", "abstractNote": r.get("abstract") or "",
    } for r in refs]
    return {"sessionID": "sci-skill-zotero", "items": items,
            "uri": "https://sci-skill.local"}


def _split_authors(s: str) -> list[str]:
    s = (s or "").strip()
    if not s:
        return []
    return [p.strip() for p in re.split(r"\s*;\s*|\s+and\s+", s) if p.strip()]


def _refs_from_csv(path: str) -> list[dict]:
    """综述产出的 evidence_table.csv（title,authors,year,journal,doi,abstract…）→ 统一 Reference。
    列名大小写不敏感、缺列容忍。用于把检索到的文献回写 Zotero。"""
    out = []
    with open(path, encoding="utf-8-sig", newline="") as f:
        for row in csv.DictReader(f):
            r = {(k or "").strip().lower(): (v or "").strip() for k, v in row.items()}
            title = r.get("title", "")
            if not title:
                continue
            authors = _split_authors(r.get("authors", "") or r.get("author", ""))
            doi = r.get("doi", "")
            out.append({
                "title": title, "authors": authors,
                "first_author": authors[0] if authors else "",
                "journal": r.get("journal", ""), "year": r.get("year", ""),
                "doi": doi, "url": (f"https://doi.org/{doi}" if doi else ""),
                "abstract": r.get("abstract", ""), "source": "search",
            })
    return out


def _bib_field(body: str, name: str) -> str:
    m = re.search(name + r"\s*=\s*[{\"](.+?)[}\"]\s*,?\s*(?:\n|$)",
                  body, re.IGNORECASE | re.DOTALL)
    return re.sub(r"\s+", " ", m.group(1)).strip().strip("{}") if m else ""


def _refs_from_bib(path: str) -> list[dict]:
    """refs.bib（search-lit 产出）→ 统一 Reference。轻量 stdlib 解析，best-effort。"""
    text = Path(path).read_text(encoding="utf-8", errors="replace")
    out = []
    for m in re.finditer(r"@\w+\s*\{[^,]*,(.*?)\n\}", text, re.DOTALL):
        body = m.group(1)
        title = _bib_field(body, "title")
        if not title:
            continue
        authors = [a.strip() for a in re.split(r"\s+and\s+", _bib_field(body, "author")) if a.strip()]
        out.append({
            "title": title, "authors": authors,
            "first_author": authors[0] if authors else "",
            "journal": _bib_field(body, "journal") or _bib_field(body, "journaltitle"),
            "year": _bib_field(body, "year"), "doi": _bib_field(body, "doi"),
            "url": _bib_field(body, "url"), "abstract": _bib_field(body, "abstract"),
            "source": "search",
        })
    return out


def cmd_push(args) -> None:
    """把 refs 回写进运行中的 Zotero（存到当前选中分类）。**写操作**。
    输入三选一：--refs JSON / --csv evidence_table.csv / --bib refs.bib。"""
    try:
        if args.csv:
            refs = _refs_from_csv(args.csv)
        elif args.bib:
            refs = _refs_from_bib(args.bib)
        elif args.refs:
            refs = json.loads(Path(args.refs).read_text(encoding="utf-8"))
        else:
            print(json.dumps({"ok": False, "error": "no_input",
                              "hint": "给 --refs/--csv/--bib 之一"}, ensure_ascii=False))
            sys.exit(2)
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": "bad_input", "detail": str(e)},
                         ensure_ascii=False))
        sys.exit(2)
    if not isinstance(refs, list) or not refs:
        print(json.dumps({"ok": False, "error": "empty_refs"}, ensure_ascii=False))
        sys.exit(2)
    try:
        _post_json(f"{_CONNECTOR}/saveItems", build_push_payload(refs),
                   timeout=_IO_TIMEOUT + 3,
                   headers={"X-Zotero-Connector-API-Version": "3.0"})
    except Exception as e:  # noqa: BLE001
        _zotero_down(str(e))
    print(json.dumps({"ok": True, "pushed": len(refs)}, ensure_ascii=False))


# ---------------------------------------------------------------- 输出
def _write_refs(refs: list[dict], out_json: str | None, out_csv: str | None) -> None:
    if out_json:
        Path(out_json).write_text(
            json.dumps(refs, ensure_ascii=False, indent=2), encoding="utf-8")
    if out_csv:
        with open(out_csv, "w", newline="", encoding="utf-8-sig") as f:
            w = csv.writer(f)
            w.writerow(["key", "title", "first_author", "journal", "year", "doi", "url"])
            for r in refs:
                w.writerow([r["key"], r["title"], r["first_author"], r["journal"],
                            r["year"], r["doi"], r["url"]])


# ---------------------------------------------------------------- CLI
def main() -> None:
    ap = argparse.ArgumentParser(description="读取本机 Zotero 文献库（只读）")
    ap.add_argument("--data-dir", default=None,
                    help="Zotero 数据目录（storage 的父目录）；默认 ~/Zotero 或 $ZOTERO_DATA_DIR")
    sub = ap.add_subparsers(dest="cmd", required=True)

    sub.add_parser("probe", help="探测 Zotero 是否在运行")

    sub.add_parser("collections", help="列出分类")

    p = sub.add_parser("items", help="读某分类条目 → 统一 Reference（省略 key 或 --top 读整库顶层）")
    p.add_argument("collection_key", nargs="?", default=None)
    p.add_argument("--top", action="store_true", help="读整库顶层 My Library（无需分类 key）")
    p.add_argument("--cap", type=int, default=200, help="导入上限（默认 200）")
    p.add_argument("--out", default=None, help="写 JSON 到此路径")
    p.add_argument("--csv", default=None, help="写 CSV 到此路径")

    p = sub.add_parser("attachments", help="列条目 PDF 附件及磁盘路径")
    p.add_argument("item_key")

    p = sub.add_parser("fulltext", help="取条目 PDF 全文")
    p.add_argument("item_key")
    p.add_argument("--max-pages", type=int, default=None)
    p.add_argument("--out", default=None, help="把全文写到此路径")

    p = sub.add_parser("materialize",
                       help="把选中文献的 PDF 复制进会话小库目录 + 写 refs 清单")
    p.add_argument("collection_key", nargs="?", default=None)
    p.add_argument("--top", action="store_true", help="整库顶层 My Library")
    p.add_argument("--items", default=None, help="逗号分隔条目 key")
    p.add_argument("--to", required=True, help="会话小库目录（如 outputs/<sid>/zotero_lib）")
    p.add_argument("--cap", type=int, default=200)

    p = sub.add_parser("push", help="把文献回写进 Zotero（写操作，存当前选中分类）")
    p.add_argument("--refs", default=None, help="统一 Reference 列表 JSON 文件")
    p.add_argument("--csv", default=None, help="综述产出的 evidence_table.csv")
    p.add_argument("--bib", default=None, help="refs.bib（BibTeX，best-effort 解析）")

    args = ap.parse_args()
    {
        "probe": cmd_probe, "collections": cmd_collections, "items": cmd_items,
        "attachments": cmd_attachments, "fulltext": cmd_fulltext,
        "materialize": cmd_materialize, "push": cmd_push,
    }[args.cmd](args)


if __name__ == "__main__":
    main()

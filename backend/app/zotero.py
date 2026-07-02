"""本地 Zotero 打通:读本地库(Zotero 7 本地 API)与回写(connector saveItems)。

前提:Zotero 桌面端运行中,且用户已在 设置→高级 勾选
"允许本机其它应用与 Zotero 通信"。所有请求走 127.0.0.1:23119,不触网。
"""
from __future__ import annotations

import httpx

ZOTERO_BASE = "http://127.0.0.1:23119"
_API = f"{ZOTERO_BASE}/api/users/0"          # 本地库 userID 恒为 0
_CONNECTOR = f"{ZOTERO_BASE}/connector"
_PROBE_TIMEOUT = 1.5
_IO_TIMEOUT = 2.0

# 只导入这些"文献型"条目;附件/笔记/独立标签跳过。
_REF_TYPES = {
    "journalArticle", "conferencePaper", "preprint", "book", "bookSection",
    "report", "thesis", "magazineArticle", "newspaperArticle", "document",
}


def _split_name(c: dict) -> str:
    """Zotero creator → "Last First" 单串(与本应用 first_author 习惯一致)。"""
    if c.get("name"):  # 单字段作者(机构等)
        return str(c["name"]).strip()
    last = (c.get("lastName") or "").strip()
    first = (c.get("firstName") or "").strip()
    return (f"{last} {first}").strip()


def map_item(raw: dict) -> dict | None:
    """Zotero 本地 API 条目 → 本应用统一 Reference;非文献型返回 None。"""
    d = raw.get("data") or {}
    itype = d.get("itemType")
    if itype not in _REF_TYPES:
        return None
    creators = [c for c in (d.get("creators") or []) if c.get("creatorType") == "author"] \
        or (d.get("creators") or [])
    authors = [_split_name(c) for c in creators if _split_name(c)]
    doi = (d.get("DOI") or "").strip()
    date = (d.get("date") or "").strip()
    year = ""
    for tok in date.replace("/", "-").split("-"):
        if len(tok) == 4 and tok.isdigit():
            year = tok
            break
    url = (d.get("url") or "").strip() or (f"https://doi.org/{doi}" if doi else "")
    return {
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


def _push_creators(ref: dict) -> list[dict]:
    out = []
    names = ref.get("authors") or ([ref["first_author"]] if ref.get("first_author") else [])
    for n in names:
        n = str(n).strip()
        if not n:
            continue
        parts = n.split()
        if len(parts) >= 2:
            out.append({"creatorType": "author", "lastName": parts[0], "firstName": " ".join(parts[1:])})
        else:
            out.append({"creatorType": "author", "lastName": n, "firstName": ""})
    return out


def build_push_payload(refs: list[dict]) -> dict:
    """构造 connector/saveItems 载荷(Zotero item JSON 数组)。"""
    items = []
    for r in refs:
        items.append({
            "itemType": "journalArticle",
            "title": r.get("title") or "",
            "creators": _push_creators(r),
            "date": str(r.get("year") or ""),
            "DOI": r.get("doi") or "",
            "url": r.get("url") or "",
            "publicationTitle": r.get("journal") or "",
            "abstractNote": r.get("abstract") or "",
        })
    # sessionID:connector 用它归并同一次保存;固定值即可(单次同步无并发语义)。
    return {"sessionID": "research-assistant", "items": items,
            "uri": "https://research-assistant.local"}


async def probe() -> dict:
    """探测本地 Zotero:running(总)/api(本地读)/connector(写)。"""
    api_ok = connector_ok = False
    async with httpx.AsyncClient(timeout=_PROBE_TIMEOUT) as client:
        try:
            r = await client.get(f"{_API}/collections?limit=1")
            api_ok = r.status_code == 200
        except Exception:  # noqa: BLE001
            api_ok = False
        try:
            r = await client.get(f"{_CONNECTOR}/ping")
            connector_ok = r.status_code in (200, 204)
        except Exception:  # noqa: BLE001
            connector_ok = False
    return {"running": api_ok or connector_ok, "api": api_ok, "connector": connector_ok}


async def list_collections() -> list[dict]:
    """列出本地库分类:[{key, name, count}]。"""
    async with httpx.AsyncClient(timeout=_IO_TIMEOUT) as client:
        r = await client.get(f"{_API}/collections?limit=200")
        r.raise_for_status()
        data = r.json()
    out = []
    for c in data:
        out.append({
            "key": c.get("key") or (c.get("data") or {}).get("key") or "",
            "name": (c.get("data") or {}).get("name") or "",
            "count": (c.get("meta") or {}).get("numItems", 0),
        })
    return [c for c in out if c["key"] and c["name"]]


async def import_collection(collection_key: str, cap: int = 200) -> list[dict]:
    """读某分类的条目 → 统一 Reference 列表(上限 cap)。"""
    async with httpx.AsyncClient(timeout=_IO_TIMEOUT) as client:
        r = await client.get(f"{_API}/collections/{collection_key}/items?limit={cap}")
        r.raise_for_status()
        data = r.json()
    refs = [map_item(x) for x in data]
    return [x for x in refs if x][:cap]


async def push(refs: list[dict]) -> int:
    """把 refs 推入运行中的 Zotero(存进当前选中分类)。返回尝试推送数。"""
    if not refs:
        return 0
    async with httpx.AsyncClient(timeout=_IO_TIMEOUT + 3) as client:
        r = await client.post(f"{_CONNECTOR}/saveItems",
                              json=build_push_payload(refs),
                              headers={"Content-Type": "application/json"})
        r.raise_for_status()
    return len(refs)

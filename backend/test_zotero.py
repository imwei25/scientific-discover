from app.zotero import map_item, build_push_payload, ZOTERO_BASE


def test_map_item_to_reference():
    raw = {"key": "ABCD", "data": {
        "itemType": "journalArticle", "title": "Deep Learning in Oncology",
        "creators": [{"creatorType": "author", "lastName": "Zhang", "firstName": "Wei"}],
        "date": "2021-05", "DOI": "10.1000/x", "publicationTitle": "Nature Med",
        "url": "", "abstractNote": "We show ..."}}
    r = map_item(raw)
    assert r["title"] == "Deep Learning in Oncology"
    assert r["first_author"] == "Zhang Wei"
    assert r["year"] == "2021"
    assert r["journal"] == "Nature Med"
    assert r["doi"] == "10.1000/x"
    assert r["url"] == "https://doi.org/10.1000/x"  # 无 url 时用 doi 兜底


def test_map_item_year_from_text_date():
    assert map_item({"data": {"itemType": "journalArticle", "date": "May 2021"}})["year"] == "2021"
    assert map_item({"data": {"itemType": "journalArticle", "date": "n.d."}})["year"] == ""
    assert map_item({"data": {"itemType": "journalArticle", "date": ""}})["year"] == ""


def test_build_push_payload_single_token_name_uses_name_field():
    body = build_push_payload([{"first_author": "WHO", "authors": ["WHO"]}])
    assert body["items"][0]["creators"][0] == {"creatorType": "author", "name": "WHO"}


def test_map_item_skips_non_reference_types():
    assert map_item({"data": {"itemType": "attachment"}}) is None
    assert map_item({"data": {"itemType": "note"}}) is None


def test_build_push_payload_shape():
    refs = [{"title": "T", "first_author": "Zhang Wei", "year": "2020",
             "journal": "J", "doi": "10.1/x", "url": "https://doi.org/10.1/x",
             "abstract": "ab"}]
    body = build_push_payload(refs)
    assert isinstance(body["items"], list) and len(body["items"]) == 1
    it = body["items"][0]
    assert it["itemType"] == "journalArticle"
    assert it["title"] == "T"
    assert it["creators"][0]["lastName"] == "Zhang"
    assert it["creators"][0]["firstName"] == "Wei"
    assert it["DOI"] == "10.1/x"
    assert body.get("sessionID")  # connector 需要 sessionID
    assert ZOTERO_BASE.endswith(":23119")

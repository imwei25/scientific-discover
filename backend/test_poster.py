"""学术海报 离线单元测试（不调 LLM）。

覆盖 JSON 解析健壮性 + 确定性 HTML 渲染 + mock 流事件序列。
用法: python test_poster.py
"""
import asyncio

from app import poster
from app.poster import _parse_poster_json, render_poster_html


def test_parse() -> None:
    # 带前后噪声也能取出 JSON
    ok = _parse_poster_json('噪声 {"title":"T","sections":[{"heading":"H","bullets":["b1","b2"]}],"highlights":["x"],"keywords":["k"]} 尾巴')
    assert ok and ok["title"] == "T" and len(ok["sections"]) == 1 and ok["sections"][0]["bullets"] == ["b1", "b2"]
    # 脏分区(缺 heading / 空 bullets) 被剔除
    dirty = _parse_poster_json('{"sections":[{"heading":"","bullets":["x"]},{"heading":"OK","bullets":["y"]},{"heading":"NoBul","bullets":[]}]}')
    assert dirty and len(dirty["sections"]) == 1 and dirty["sections"][0]["heading"] == "OK"
    # 无 JSON / 无有效分区 → None
    assert _parse_poster_json("no json here") is None
    assert _parse_poster_json('{"sections":[]}') is None
    print("ok: _parse_poster_json 健壮性")


def test_render() -> None:
    content = {
        "title": "标题 <可能含尖括号>",
        "highlights": ["核心发现1"],
        "sections": [{"heading": "研究方法", "bullets": ["随机对照", "24 周"]}],
        "keywords": ["A", "B"],
    }
    html = render_poster_html(content, {"authors": "张三 & 李四", "affiliation": "某医院", "figures": ["iVBOR=="]})
    assert html.startswith("<!doctype html>")
    assert "A2 landscape" in html                       # 打印为横向 A2
    assert "&lt;可能含尖括号&gt;" in html               # 标题被转义, 防 XSS/破坏结构
    assert "张三 &amp; 李四" in html                    # 作者被转义
    assert "随机对照" in html and "24 周" in html
    assert "data:image/png;base64,iVBOR==" in html      # 图表被内嵌
    assert "研究方法" in html
    print("ok: render_poster_html 转义 + 分区 + 图表 + 打印样式")


def test_mock_stream() -> None:
    poster.settings.mock = True

    async def run(inputs):
        return [ev async for ev, _ in poster.generate_poster(inputs)]

    evs = asyncio.run(run({"content": "x", "title": "T"}))
    assert evs == ["status", "poster", "done"], evs
    # 空内容 → 单个 error
    assert asyncio.run(run({"content": "   "})) == ["error"]
    print("ok: mock 流事件序列 + 空内容拦截")


def test_review_mock() -> None:
    poster.settings.mock = True
    content = {
        "title": "T", "highlights": ["h"],
        "sections": [
            {"heading": "结果", "bullets": ["b1", "b2", "b3", "b4", "b5", "b6"]},
            {"heading": "方法", "bullets": ["m1"]},
        ],
        "keywords": ["k"],
    }
    out = asyncio.run(poster.review_poster({"content": content, "image": "iVBORw0KGgo="}))
    assert set(out.keys()) == {"critique", "content", "html"}, out.keys()
    assert out["critique"]                                   # 有审阅意见
    longest = max(out["content"]["sections"], key=lambda s: len(s["bullets"]))
    assert len(longest["bullets"]) == 4                      # 最长分区被精简到 4 条
    assert out["html"].startswith("<!doctype html>")        # 重渲染出 HTML
    # 缺内容 / 缺截图 → ValueError
    for bad in ({"content": {}, "image": "x"}, {"content": content, "image": ""}):
        try:
            asyncio.run(poster.review_poster(bad))
            assert False, "应抛 ValueError"
        except ValueError:
            pass
    print("ok: review_poster mock 审阅 + 精简 + 入参校验")


if __name__ == "__main__":
    test_parse()
    test_render()
    test_mock_stream()
    test_review_mock()
    print("\nALL POSTER TESTS PASSED")

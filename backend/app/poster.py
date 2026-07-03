"""学术海报生成。

把一篇论文/稿件(粘贴、上传或从其它模块导入)提炼成一张会议学术海报。
借鉴 Paper2Poster / PosterGen 等系统的"内容智能体"思路, 但去掉它们对
PDF 深度解析与视觉模型(VLM)审美回环的重依赖 —— 本项目里论文文本本就在手,
且模型(DeepSeek)为纯文本, 所以只做两步:

  ① LLM(纯文本) 把论文蒸馏成结构化的海报要点 JSON(分区 + 要点式短句);
  ② 确定性 HTML/CSS 模板渲染成自包含海报(可浏览器打开、可打印成 PDF)。

铁律与全项目一致: 只据给定材料, 严禁编造数字/统计量/文献; 排版交给确定性
模板, 不让 LLM 排版。

对外异步生成器, 逐步 yield (event, data): status / poster / error。
poster 事件携带 {content: <要点JSON>, html: <自包含HTML>}。
"""
from __future__ import annotations

import html as _html
import json
import traceback
from typing import AsyncIterator

from .config import settings
from .llm import stream_chat

# 主题配色(与前端「临床精确×学术期刊」一致): petrol 深青墨 / 仪器 teal / 临床纸白
_PETROL = "#0E3A39"
_TEAL = "#0F9B94"
_PAPER = "#EEF2F1"
_INK = "#1f2733"

_DEFAULT_SECTIONS_ZH = ["研究背景", "研究方法", "主要结果", "结论与意义"]
_DEFAULT_SECTIONS_EN = ["Background", "Methods", "Results", "Conclusions"]


async def _complete(messages: list[dict], max_tokens: int = 1600) -> str:
    buf = ""
    async for piece in stream_chat(messages, task="poster", max_tokens=max_tokens):
        buf += piece
    return buf


def _poster_messages(content: str, title: str, lang: str) -> list[dict]:
    is_en = lang == "en"
    secs = "、".join(_DEFAULT_SECTIONS_EN if is_en else _DEFAULT_SECTIONS_ZH)
    lang_rule = (
        "用简洁的学术英文输出所有文字。" if is_en else "用简洁的学术中文输出所有文字。"
    )
    system = (
        "你是资深学术海报设计助手, 面向医学/药学/生物医学会议。"
        "把用户给的论文/稿件提炼成一张会议海报的要点大纲。"
        f"海报默认包含这些分区: {secs}; 若材料充分可增加一个『临床/科学意义』或『局限与展望』分区, 但分区总数不超过 6 个。\n"
        "海报语言要求: 每条要点是**短句/短语**(而非整段), 便于远距离阅读; 每个分区 3-6 条要点。\n"
        "铁律: 只能使用材料中确有的事实; **严禁编造任何数字、统计量、p 值、样本量或文献**; "
        "材料不足以支撑之处宁可省略, 不要杜撰。数字/统计量若材料中有, 原样保留。\n"
        f"{lang_rule}\n"
        "只输出一个 JSON 对象, 不要任何解释或 Markdown 代码围栏, 结构如下:\n"
        '{"title": "海报标题", '
        '"highlights": ["一句话核心发现", "另一句(可选)"], '
        '"sections": [{"heading": "分区标题", "bullets": ["要点1", "要点2"]}], '
        '"keywords": ["关键词1", "关键词2"]}'
    )
    user = "【论文/稿件材料】\n" + content.strip()[:16000]
    if title.strip():
        user = f"【指定海报标题】{title.strip()}\n\n" + user
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


def _parse_poster_json(raw: str) -> dict | None:
    s, e = raw.find("{"), raw.rfind("}")
    if s == -1 or e == -1:
        return None
    try:
        obj = json.loads(raw[s : e + 1])
    except Exception:  # noqa: BLE001
        return None
    if not isinstance(obj, dict):
        return None
    # 规整字段, 防脏数据
    secs = []
    for sec in obj.get("sections") or []:
        if not isinstance(sec, dict):
            continue
        heading = str(sec.get("heading") or "").strip()
        bullets = [str(b).strip() for b in (sec.get("bullets") or []) if str(b).strip()]
        if heading and bullets:
            secs.append({"heading": heading, "bullets": bullets})
    if not secs:
        return None
    return {
        "title": str(obj.get("title") or "").strip(),
        "highlights": [str(h).strip() for h in (obj.get("highlights") or []) if str(h).strip()][:3],
        "sections": secs[:6],
        "keywords": [str(k).strip() for k in (obj.get("keywords") or []) if str(k).strip()][:8],
    }


def _esc(s: str) -> str:
    return _html.escape(str(s or ""))


def render_poster_html(content: dict, meta: dict) -> str:
    """把要点 JSON 渲染成自包含的 HTML 海报(横向, 三栏, 可打印成 PDF)。"""
    title = _esc(content.get("title") or meta.get("title") or "学术海报")
    authors = _esc(meta.get("authors") or "")
    affiliation = _esc(meta.get("affiliation") or "")
    figures = meta.get("figures") or []  # list[base64 png]

    # 头部作者行
    byline = ""
    if authors or affiliation:
        parts = [p for p in (authors, affiliation) if p]
        byline = f'<div class="poster-byline">{" · ".join(parts)}</div>'

    # 亮点条
    highlights = content.get("highlights") or []
    hl_html = ""
    if highlights:
        items = "".join(f"<li>{_esc(h)}</li>" for h in highlights)
        hl_html = f'<ul class="poster-highlights">{items}</ul>'

    # 分区卡片(CSS 多栏自动排布)
    cards = []
    for i, sec in enumerate(content.get("sections") or []):
        bullets = "".join(f"<li>{_esc(b)}</li>" for b in sec.get("bullets", []))
        cards.append(
            f'<section class="poster-card">'
            f'<h2><span class="poster-card-num">{i + 1:02d}</span>{_esc(sec.get("heading"))}</h2>'
            f"<ul>{bullets}</ul></section>"
        )
    # 图表卡(可选): 复用数据分析已生成的图
    if figures:
        figs = "".join(
            f'<figure><img src="data:image/png;base64,{f}" alt="图{j + 1}"/>'
            f"<figcaption>图 {j + 1}</figcaption></figure>"
            for j, f in enumerate(figures)
        )
        cards.append(f'<section class="poster-card poster-figs"><h2><span class="poster-card-num">✦</span>图表</h2>{figs}</section>')
    cards_html = "\n".join(cards)

    # 页脚关键词
    keywords = content.get("keywords") or []
    kw_html = ""
    if keywords:
        chips = "".join(f"<span>{_esc(k)}</span>" for k in keywords)
        kw_html = f'<div class="poster-keywords">{chips}</div>'

    return f"""<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"/>
<title>{title}</title>
<style>
  :root {{ --petrol:{_PETROL}; --teal:{_TEAL}; --paper:{_PAPER}; --ink:{_INK}; }}
  * {{ box-sizing:border-box; }}
  body {{ margin:0; background:#d8dedd; color:var(--ink);
    font-family:"Microsoft YaHei","Segoe UI",system-ui,sans-serif; line-height:1.5; }}
  .poster {{ width:1188px; min-height:840px; margin:24px auto; background:var(--paper);
    box-shadow:0 6px 30px rgba(14,58,57,.25); display:flex; flex-direction:column; }}
  .poster-head {{ background:var(--petrol); color:#fff; padding:34px 44px 30px;
    border-bottom:6px solid var(--teal); }}
  .poster-eyebrow {{ font-family:Georgia,"Songti SC",serif; letter-spacing:.14em;
    text-transform:uppercase; font-size:13px; color:#9fd8d3; margin-bottom:10px; }}
  .poster-head h1 {{ margin:0; font-size:38px; line-height:1.2; font-weight:700; }}
  .poster-byline {{ margin-top:12px; font-size:16px; color:#cfe6e3; }}
  .poster-highlights {{ list-style:none; display:flex; gap:16px; flex-wrap:wrap;
    margin:0; padding:18px 44px; background:#e4ebe9; border-bottom:1px solid #cdd8d5; }}
  .poster-highlights li {{ flex:1 1 260px; background:#fff; border-left:4px solid var(--teal);
    padding:12px 16px; font-size:16px; font-weight:600; color:var(--petrol);
    border-radius:0 6px 6px 0; box-shadow:0 1px 3px rgba(14,58,57,.08); }}
  .poster-body {{ padding:26px 44px 10px; column-count:3; column-gap:26px; flex:1; }}
  .poster-card {{ break-inside:avoid; margin:0 0 22px; background:#fff; border:1px solid #dbe4e2;
    border-radius:8px; padding:16px 18px; box-shadow:0 1px 2px rgba(14,58,57,.05); }}
  .poster-card h2 {{ margin:0 0 12px; font-size:19px; color:var(--petrol);
    display:flex; align-items:center; gap:10px; padding-bottom:8px;
    border-bottom:2px solid var(--teal); }}
  .poster-card-num {{ font-family:Georgia,serif; font-size:15px; color:#fff;
    background:var(--teal); border-radius:5px; padding:2px 7px; min-width:26px; text-align:center; }}
  .poster-card ul {{ margin:0; padding-left:20px; }}
  .poster-card li {{ margin:0 0 7px; font-size:15px; }}
  .poster-figs img {{ width:100%; border:1px solid #dbe4e2; border-radius:6px; }}
  .poster-figs figure {{ margin:0 0 12px; }}
  .poster-figs figcaption {{ font-size:12.5px; color:#5b6675; margin-top:4px; }}
  .poster-foot {{ padding:14px 44px 22px; border-top:1px solid #cdd8d5; }}
  .poster-keywords {{ display:flex; flex-wrap:wrap; gap:8px; margin-bottom:8px; }}
  .poster-keywords span {{ background:#dcebe9; color:var(--petrol); font-size:13px;
    padding:3px 12px; border-radius:20px; }}
  .poster-note {{ font-size:12px; color:#5b6675; margin:0; }}
  @media print {{
    @page {{ size:A2 landscape; margin:0; }}
    body {{ background:#fff; }}
    .poster {{ width:100%; min-height:100vh; margin:0; box-shadow:none; }}
  }}
</style></head>
<body>
  <div class="poster">
    <header class="poster-head">
      <div class="poster-eyebrow">Academic Poster · 学术海报</div>
      <h1>{title}</h1>
      {byline}
    </header>
    {hl_html}
    <div class="poster-body">
      {cards_html}
    </div>
    <footer class="poster-foot">
      {kw_html}
      <p class="poster-note">本海报由科研助手据你的论文材料生成; 内容与数字请人工核对后用于展示。可用浏览器「打印」另存为 PDF。</p>
    </footer>
  </div>
</body></html>"""


_MOCK_CONTENT = {
    "title": "[演示] 二甲双胍对 2 型糖尿病合并 NAFLD 肝纤维化的影响",
    "highlights": ["[MOCK] 治疗组肝纤维化评分显著下降", "[MOCK] 安全性良好, 无严重不良事件"],
    "sections": [
        {"heading": "研究背景", "bullets": ["NAFLD 在 T2DM 中高发", "现有干预对肝纤维化证据有限"]},
        {"heading": "研究方法", "bullets": ["随机对照试验", "干预 24 周", "主要结局: 肝纤维化评分"]},
        {"heading": "主要结果", "bullets": ["[MOCK] 组间差异有统计学意义", "[MOCK] 次要结局同向改善"]},
        {"heading": "结论与意义", "bullets": ["提示潜在肝脏获益", "需更大样本验证"]},
    ],
    "keywords": ["二甲双胍", "NAFLD", "肝纤维化", "T2DM"],
}


async def generate_poster(inputs: dict) -> AsyncIterator[tuple[str, dict]]:
    content_text = (inputs.get("content") or "").strip()
    title = (inputs.get("title") or "").strip()
    authors = (inputs.get("authors") or "").strip()
    affiliation = (inputs.get("affiliation") or "").strip()
    lang = "en" if str(inputs.get("lang") or "zh").lower().startswith("en") else "zh"
    figures = inputs.get("figures") or []
    if isinstance(figures, list):
        figures = [str(f) for f in figures if isinstance(f, str) and f][:6]
    else:
        figures = []
    meta = {"title": title, "authors": authors, "affiliation": affiliation, "figures": figures}

    if not content_text:
        yield ("error", {"message": "请粘贴/上传论文内容，或从其它模块导入后再生成海报。"})
        return

    if settings.mock:
        yield ("status", {"message": "正在提炼海报要点…（演示模式）"})
        content = dict(_MOCK_CONTENT)
        if title:
            content["title"] = title
        yield ("poster", {"content": content, "html": render_poster_html(content, meta)})
        yield ("done", {})
        return

    try:
        yield ("status", {"message": "正在把论文提炼为海报要点…"})
        raw = await _complete(_poster_messages(content_text, title, lang))
        content = _parse_poster_json(raw)
        if content is None:
            yield ("error", {"message": "海报要点解析失败，请重试或精简输入内容。"})
            return
        if title:
            content["title"] = title
        yield ("status", {"message": "正在渲染海报…"})
        yield ("poster", {"content": content, "html": render_poster_html(content, meta)})
        yield ("done", {})
    except Exception as e:  # noqa: BLE001
        print("[poster] exception:\n" + traceback.format_exc(), flush=True)
        yield ("error", {"message": f"海报生成出错：{type(e).__name__}: {e}"})

"""回复审稿意见(Rebuttal)助手。

返修是从数据到投稿全链路里频率高、对录用影响最大、且隐私最敏感的环节
(同时涉及未发表稿件 + 保密审稿意见)——正契合本工具"本地运行、数据不出网"的定位。

流程:
  1) 把审稿意见拆解为带编号的条目(按审稿人分组, 打类型标签), 供前端清单展示;
  2) 基于稿件(节选)与已拆解意见, 让 LLM 严格按 #1..#N 编号输出 JSON 数组,
     后端拼装 point-by-point 回复信(Markdown), 每条含: 意见摘要 → 回应 → 建议的正文改动。

反幻觉护栏:
  - 让 LLM 输出编号绑定的 JSON, 后端拼装 letter, 杜绝 LLM 自创 #5 意见;
  - 稿件为空/极短(<200 字)时, 每条"修改"字段一律标 [需作者补充稿件后生成];
  - 稿件被截断时, prompt 里明确"引用段落若不在给定节选内, 请标 [位置待作者核对]";
  - 前端可传 round(R1/R2/R3), 后端在 letter 抬头带上轮次标注。

对外是异步生成器, 逐步 yield (event, data): status / comments / delta / done / error。
"""
from __future__ import annotations

import json
import traceback
from typing import AsyncIterator

from .config import settings
from .deidentify import scan_text as phi_scan_text
from .llm import stream_chat
from .logutil import log_swallow
from .verify import verify_references


# 稿件"极短"判定阈值: 少于此字符数视为无有效稿件, 不生成"修改"字段
_MIN_MANUSCRIPT_CHARS = 200
_MANUSCRIPT_TRUNC = 8000
_VALID_ROUNDS = {"R1", "R2", "R3", "R4"}


async def _complete(messages: list[dict], max_tokens: int = 800) -> str:
    buf = ""
    async for piece in stream_chat(messages, task="rebuttal", max_tokens=max_tokens):
        buf += piece
    return buf


def _parse_json(raw: str, opener: str, closer: str):
    s, e = raw.find(opener), raw.rfind(closer)
    if s == -1 or e == -1:
        return None
    try:
        return json.loads(raw[s : e + 1])
    except Exception as exc:  # noqa: BLE001
        log_swallow("回复审稿: LLM 输出无法解析为 JSON(将走默认兜底)", exc)
        return None


_VALID_TYPES = {"澄清", "补实验", "补分析", "补文献", "方法", "写作", "格式", "其他"}


async def _parse_comments(reviews: str) -> list[dict]:
    """把审稿意见拆解为结构化条目(按审稿人/编号, 带类型标签)。"""
    system = (
        "你是医学论文编辑助手。把下面的审稿意见拆解为相互独立的条目。"
        "只输出 JSON 数组，每项形如 "
        "{\"reviewer\":\"审稿人标识(如 R1/编辑)\",\"index\":条目序号(整数),\"comment\":\"意见原文(可精简但保留要点)\",\"type\":\"类型\"}。"
        "type 仅取其一：澄清/补实验/补分析/补文献/方法/写作/格式/其他。不要任何解释。"
    )
    arr = _parse_json(
        await _complete(
            [{"role": "system", "content": system}, {"role": "user", "content": reviews[:6000]}],
            max_tokens=1500,
        ),
        "[", "]",
    )
    items: list[dict] = []
    if isinstance(arr, list):
        for it in arr:
            if isinstance(it, dict) and str(it.get("comment") or "").strip():
                t = str(it.get("type") or "其他").strip()
                items.append({
                    "reviewer": str(it.get("reviewer") or "").strip() or "审稿人",
                    "index": it.get("index") if isinstance(it.get("index"), int) else len(items) + 1,
                    "comment": str(it["comment"]).strip(),
                    "type": t if t in _VALID_TYPES else "其他",
                })
    return items


def _normalize_round(raw: str) -> str:
    """把前端传来的 round 字段规范化为 R1/R2/R3, 非法值返回空串(不显示轮次)。"""
    r = (raw or "").strip().upper().replace(" ", "")
    if not r:
        return ""
    if r in _VALID_ROUNDS:
        return r
    # 宽松写法: "1" / "round1" / "r1"
    if r.isdigit() and 1 <= int(r) <= 4:
        return f"R{r}"
    if r.startswith("ROUND") and r[5:].isdigit():
        n = int(r[5:])
        if 1 <= n <= 4:
            return f"R{n}"
    return ""


def _responses_messages(
    manuscript: str,
    parsed_comments: list[dict],
    tone: str,
    lang: str,
    has_manuscript: bool,
    truncated: bool,
) -> list[dict]:
    """让 LLM 严格按 parsed_comments 的编号输出 JSON 数组, 一一对应, 不得增删。"""
    tone_txt = (
        "礼貌但坚定、有理有据(对确不认同之处礼貌而明确地说明理由与证据)"
        if tone == "firm"
        else "礼貌、谦逊、建设性(尽量采纳, 确有分歧时温和说明)"
    )
    ms = (manuscript or "")[:_MANUSCRIPT_TRUNC]
    n = len(parsed_comments)

    # 反幻觉核心: 明确列出编号, 要求严格对应, 并区分"有/无稿件"下的 change 规则
    if has_manuscript:
        change_rule = (
            "\"change\": 说明在正文哪一节/段做了什么修改; 若需补做实验或分析, 写\"我们将补充……\"并说明方案; "
            "引用的稿件段落若不在给定节选内, 一律标 \"[位置待作者核对]\", 严禁凭空编造章节号如\"见方法学 §2.3\""
        )
    else:
        change_rule = (
            "\"change\": 由于作者尚未提供稿件正文, 一律填写字面量 \"[需作者补充稿件后生成]\", "
            "不得编造\"已在方法学补充 XX\"这类修改承诺"
        )

    trunc_hint = (
        "\n注意: 稿件已被截断到前 8000 字, 若审稿意见涉及后文, 你无法看到, 请在 change 里标 \"[位置待作者核对]\", 不要臆测。"
        if truncated
        else ""
    )

    lang_hint = (
        "所有 summary/response/change 字段用 English (fluent, formal academic English) 撰写。"
        if lang == "en"
        else "所有字段用中文撰写。"
    )

    system = (
        "你是资深医学论文通讯作者, 正在撰写对审稿意见的 point-by-point 回复。"
        f"整体语气: {tone_txt}。\n"
        f"下面用户会给你 {n} 条已编号的审稿意见 (#1..#{n})。你必须严格按这 {n} 条编号一一对应回应, "
        f"**不得增加、删除、合并或跳过任何编号**, 也不得出现 #{n + 1} 或更大编号。\n"
        "只输出严格的 JSON 数组 (UTF-8, 不要 markdown 代码块、不要前后缀), 结构如下:\n"
        "[\n"
        "  {\n"
        "    \"comment_id\": <与用户给的 #N 完全一致的整数>,\n"
        "    \"summary\": \"<一句话复述该条意见>\",\n"
        "    \"response\": \"<针对性的具体回应>\",\n"
        f"    {change_rule}\n"
        "  }, ...\n"
        "]\n"
        f"数组长度必须恰好等于 {n}, 顺序与用户给出的编号一致。\n"
        f"{lang_hint}"
        f"{trunc_hint}\n"
        "铁律: 只能基于下面提供的稿件内容回应, 严禁编造数据、结果或文献; "
        "凡涉及尚未做的新实验/新分析, 一律用\"我们将补充/拟开展……\"表述, 绝不杜撰具体数字或结论。"
    )

    # 拼接编号清单给 LLM
    lines = ["【已拆解的审稿意见清单 (按 #编号 严格对应回应)】"]
    for i, c in enumerate(parsed_comments, start=1):
        reviewer = c.get("reviewer") or "审稿人"
        ctype = c.get("type") or ""
        tag = f" [{ctype}]" if ctype else ""
        lines.append(f"#{i} ({reviewer}){tag}: {c.get('comment', '')}")

    ms_block = ms if has_manuscript else "(作者未提供有效稿件内容, 请按 change 规则处理)"
    user = (
        f"{chr(10).join(lines)}\n\n"
        f"【稿件({'节选' if truncated else '全文'}, 供你核对事实与定位修改处)】\n{ms_block}"
    )
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


def _render_letter(
    parsed_comments: list[dict],
    responses: list[dict],
    tone: str,
    lang: str,
    round_label: str,
    has_manuscript: bool,
) -> str:
    """后端拼装 letter 文本: 严格按 parsed_comments 编号顺序, 用 LLM 返回的 response/change 填充。"""
    # 建索引: comment_id → response dict
    resp_by_id: dict[int, dict] = {}
    for r in responses:
        if isinstance(r, dict):
            try:
                cid = int(r.get("comment_id"))
            except (TypeError, ValueError):
                continue
            resp_by_id[cid] = r

    en = lang == "en"
    header_lines: list[str] = []
    if round_label:
        header_lines.append(
            f"**Response Round: {round_label}**" if en else f"**回复轮次: {round_label}**"
        )
    if not has_manuscript:
        header_lines.append(
            "> Note: The authors have not yet supplied the manuscript body. "
            "The \"Revision\" field for every item is marked as pending author input."
            if en
            else "> 说明: 作者尚未提供稿件正文, 每条的\"修改\"字段一律标为 [需作者补充稿件后生成]。"
        )
    header_lines.append(
        "We sincerely thank the reviewers for their constructive comments. Below are our point-by-point responses:"
        if en
        else "感谢各位审稿人的宝贵意见。以下逐条回应："
    )

    body_blocks: list[str] = []
    for i, c in enumerate(parsed_comments, start=1):
        reviewer = c.get("reviewer") or ("Reviewer" if en else "审稿人")
        r = resp_by_id.get(i, {})
        summary = str(r.get("summary") or c.get("comment") or "").strip()
        response = str(r.get("response") or "").strip()
        change = str(r.get("change") or "").strip()

        if not has_manuscript:
            change = "[Pending manuscript from authors]" if en else "[需作者补充稿件后生成]"
        if not response:
            response = "[Pending]" if en else "[待补充]"
        if not change:
            change = "[Pending]" if en else "[待补充]"

        if en:
            block = (
                f"**{reviewer} · Comment #{i}**: {summary}\n\n"
                f"Response: {response}\n\n"
                f"Revision: {change}"
            )
        else:
            block = (
                f"**{reviewer} · 意见 #{i}**：{summary}\n\n"
                f"回应：{response}\n\n"
                f"修改：{change}"
            )
        body_blocks.append(block)

    footer = (
        "We again thank the reviewers for their thoughtful comments, which have helped us improve the manuscript."
        if en
        else "再次感谢各位审稿人的建设性意见, 使稿件得以进一步完善。"
    )

    return "\n\n".join(header_lines) + "\n\n" + "\n\n".join(body_blocks) + "\n\n" + footer


async def _mock_flow(reviews: str, round_label: str) -> AsyncIterator[tuple[str, dict]]:
    yield ("status", {"message": "正在拆解审稿意见…"})
    yield ("comments", {"items": [
        {"reviewer": "R1", "index": 1, "comment": f"[MOCK] {reviews[:30] or '样本量是否充分？'}", "type": "补分析"},
        {"reviewer": "R2", "index": 1, "comment": "[MOCK] 方法描述不够清晰。", "type": "方法"},
    ]})
    yield ("status", {"message": "正在逐条撰写回复…"})
    prefix = f"**回复轮次: {round_label}**\n\n" if round_label else ""
    text = (
        prefix
        + "感谢各位审稿人的宝贵意见。以下逐条回应：\n\n"
        "**R1 · 意见 #1**：样本量是否充分？\n\n回应：[MOCK] 我们已补充样本量与检验效能说明。\n\n修改：[MOCK] 见方法学第 2.3 节。\n\n"
        "**R2 · 意见 #2**：方法描述不清。\n\n回应：[MOCK] 已补充细节。\n\n修改：[MOCK] 见方法学第 2.1 节。\n\n"
        "再次感谢审稿人的建设性意见。"
    )
    for ch in text:
        yield ("delta", {"text": ch})


async def rebuttal(inputs: dict) -> AsyncIterator[tuple[str, dict]]:
    manuscript = (inputs.get("manuscript") or "").strip()
    reviews = (inputs.get("reviews") or "").strip()
    tone = (inputs.get("tone") or "balanced").strip()
    lang = (inputs.get("lang") or "zh").strip()
    round_label = _normalize_round(str(inputs.get("round") or ""))

    if not reviews:
        yield ("error", {"message": "请粘贴/上传审稿意见。"})
        return

    if settings.mock:
        async for ev in _mock_flow(reviews, round_label):
            yield ev
        yield ("done", {})
        return

    try:
        # 入口 PHI 前置扫描: 稿件+审稿意见含姓名/身份证/手机/邮箱时先警告用户
        # (不阻断, 只提示, 因用户可能已刻意去标识)
        phi = phi_scan_text((manuscript or "") + "\n" + (reviews or ""))
        if phi.get("total", 0) > 0:
            kinds_desc = ", ".join(f"{k}×{len(v)}" for k, v in phi["hits"].items())
            yield ("warning", {
                "message": f"⚠️ 稿件/审稿意见中检测到疑似个人信息({kinds_desc}), 内容将上传到 LLM。"
                           f"如涉及病人身份, 请先在'数据分析·脱敏'模块处理后再回到本模块。",
            })

        yield ("status", {"message": "正在拆解审稿意见…"})
        comments = await _parse_comments(reviews)
        yield ("comments", {"items": comments})

        n = len(comments)
        has_manuscript = len(manuscript) >= _MIN_MANUSCRIPT_CHARS
        truncated = len(manuscript) > _MANUSCRIPT_TRUNC

        if not n:
            # 没识别到任何条目: 直接给一段提示, 而不是让 LLM 自由发挥编造 #1..#N
            hint = (
                "未能从审稿意见中拆解出可编号的条目, 请检查原文格式后重试, 或人工拆条后再生成。"
                if lang != "en"
                else "No numbered comments could be parsed from the reviewer letter. "
                     "Please check the format and retry, or split the comments manually."
            )
            for ch in hint:
                yield ("delta", {"text": ch})
            yield ("done", {})
            return

        status_msg = f"已识别 {n} 条意见"
        if not has_manuscript:
            status_msg += "(未检测到有效稿件, 仅生成待回应清单)"
        elif truncated:
            status_msg += "(稿件较长, 已截断到前 8000 字)"
        status_msg += "，正在逐条撰写回复…"
        yield ("status", {"message": status_msg})

        # 让 LLM 严格按编号返回 JSON, 后端拼装最终 letter
        raw = await _complete(
            _responses_messages(manuscript, comments, tone, lang, has_manuscript, truncated),
            max_tokens=max(800, min(4000, 300 * n + 400)),
        )
        arr = _parse_json(raw, "[", "]") or []
        if not isinstance(arr, list):
            arr = []

        letter = _render_letter(comments, arr, tone, lang, round_label, has_manuscript)
        # 保持流式感受: 逐字 yield 拼装好的 letter
        for ch in letter:
            yield ("delta", {"text": ch})

        # 回引校验: 检查 letter 里引用的稿件章节/图表编号是否真实存在
        if has_manuscript:
            try:
                ref_warns = verify_references(letter, manuscript, kinds={"section", "number"})
                for w in ref_warns[:5]:  # 最多提示 5 条, 避免刷屏
                    yield ("warning", {"message": w})
            except Exception as exc:  # noqa: BLE001
                log_swallow("rebuttal: 回引校验失败(非致命)", exc)

        yield ("done", {})
    except Exception as e:  # noqa: BLE001
        print("[rebuttal] exception:\n" + traceback.format_exc(), flush=True)
        yield ("error", {"message": f"生成回复出错：{type(e).__name__}: {e}"})

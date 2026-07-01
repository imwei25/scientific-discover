"""中文科研标书(基金申请书)撰写流程。

借鉴 grant-master 的「方案凝练 → 大纲 → 分节撰写 → 评审自查」流水线, 接在「找选题」
之后: 吃下选题阶段产出的【调研报告 + 真实文献】, 产出一份 NSFC 风格的中文申请书初稿。

支持两种节奏:
  - 一步到位: write_grant 内部凝练方案 → 直接逐节写完;
  - 两段式(推荐): 先 plan_grant 产出【可编辑的方案骨架 + 大纲】交用户确认/修改,
    再把确认后的 scheme/sections 回传给 write_grant 撰写。
另提供 revise_section: 仅按用户意见重写【某一章节】, 不重跑全篇。

护城河与铁律(沿用本项目其它写作模块):
  - 立项依据里引用文献时, 只能用选题阶段检索到的【真实文献】(可点击链接), 严禁编造;
    正文写完后做引用自动核验(复用 research._verify_citations)。
  - 申请人/团队/经费/单位等无法从上游推断的事实, 一律用 [需申请人补充] 占位, 不杜撰;
    基于现状的推断性论断标 [待验证], 提醒人工核对。
  - 产出是【初稿】, 需研究者核对事实、引用、合规与学术伦理后再用。

对外异步生成器逐步 yield (event, data):
  ("status", {"message": ...})        进度提示
  ("scheme", {...})                   凝练出的研究方案要点(科学问题/假设/目标/创新)
  ("outline", {"items": [...]})       标书大纲(章节 + 字数预算)
  ("section", {"key": ..., "title": ...})  下面的 delta 属于该章节
  ("delta", {"text": ...})            正文流式片段(仅章节正文, 不含大标题)
  ("verify", {...})                   引用核验结果
  ("error", {"message": ...})
"""
from __future__ import annotations

import json
import traceback
from typing import AsyncIterator

from .config import settings
from .literature import search_literature
from .llm import stream_chat
# 复用找选题的: 引用核验 / 主题→PubMed检索式 / 文献去重键
from .research import _verify_citations, _gen_queries, _pkey

# 重新调研重写时, 检索的默认论文源(与找选题默认一致)。
_RERESEARCH_SOURCES = ["pubmed", "europepmc", "openalex"]
# 合并后参考文献池上限, 防止越改越大。
_REFS_CAP = 40

# 资助类型 → (中文名, 写作侧重提示)。影响篇幅与语气, 不强约束结构。
_GRANT_TYPES = {
    "youth": ("国家自然科学基金·青年科学基金",
              "申请人多为青年学者, 强调创新潜力与个人前期基础; 研究内容聚焦、不贪大。"),
    "general": ("国家自然科学基金·面上项目",
                "强调科学问题的重要性、研究的系统性与团队积累, 内容可相对全面深入。"),
    "regional": ("国家自然科学基金·地区科学基金",
                 "兼顾科学价值与地区特色/资源, 强调依托单位条件与可行性。"),
    "general_other": ("通用科研基金申请书(省部级/校级/横向等)",
                      "按通用申请书结构组织, 语气稳健, 重点突出意义、内容与可行性。"),
}

# NSFC 风格标书章节: key → (中文标题, 写作要点, 字数预算)。顺序见 _SECTION_ORDER。
_SECTION_MAP = {
    "rationale": ("一、立项依据与研究意义",
        "阐明研究背景与重要性; 系统综述国内外研究现状与发展动态(按子方向组织), 指出尚存的研究空白与争议; "
        "引出本项目拟切入的科学问题。引用文献时必须用真实文献的 Markdown 链接 [第一作者 et al., 年份](URL)。",
        "约 800-1200 字"),
    "objectives": ("二、研究目标、研究内容与拟解决的关键科学问题",
        "分三小节: (1) 研究目标——总体目标 + 2-3 个具体目标; (2) 研究内容——分点列出与目标对应的研究内容; "
        "(3) 拟解决的关键科学问题——凝练 1-2 个真正的『科学问题』(非工作任务)。",
        "约 600-900 字"),
    "scheme": ("三、研究方案与可行性分析",
        "分: (1) 研究方法与技术路线(可用文字描述技术路线图各环节的逻辑与衔接); (2) 实验设计与关键技术; "
        "(3) 可行性分析(从科学依据、研究基础、技术条件三方面论证)。方法学要具体、可落地。",
        "约 800-1100 字"),
    "innovation": ("四、本项目的特色与创新之处",
        "分点给出 2-4 条特色与创新; 每条对照研究现状指出『新在哪、与已有工作的差异』, 避免空泛口号。",
        "约 300-500 字"),
    "plan": ("五、年度研究计划与预期研究成果",
        "(1) 年度研究计划——按年度(如 3 年)列出阶段任务与里程碑(用 Markdown 表格或分点); "
        "(2) 预期成果——论文/专利/人才培养等, 数量与去向用 [需申请人补充] 占位, 不虚报。",
        "约 300-500 字"),
    "foundation": ("六、研究基础与工作条件",
        "(1) 研究基础——申请人/团队与本项目相关的前期工作积累; (2) 工作条件——依托单位的平台、设备、样本来源等。"
        "本节涉及大量个人/单位事实, 凡上游材料未提供的一律用 [需申请人补充] 占位, 严禁编造论文、项目、设备或人员。",
        "约 300-500 字"),
}
_SECTION_ORDER = ["rationale", "objectives", "scheme", "innovation", "plan", "foundation"]


async def _complete(messages: list[dict], max_tokens: int = 400) -> str:
    buf = ""
    async for piece in stream_chat(messages, max_tokens=max_tokens):
        buf += piece
    return buf


def _parse_json(raw: str, opener: str, closer: str):
    s, e = raw.find(opener), raw.rfind(closer)
    if s == -1 or e == -1:
        return None
    try:
        return json.loads(raw[s : e + 1])
    except Exception:  # noqa: BLE001
        return None


def _merge_refs(existing: list[dict], extra: list[dict], cap: int = _REFS_CAP) -> tuple[list[dict], int]:
    """把新检索到的文献并入已有文献池(按 doi/pmid/url 去重)。返回 (合并后列表, 实际新增数)。"""
    out = list(existing)
    keys = {_pkey(r) for r in existing if _pkey(r)}
    added = 0
    for p in extra:
        k = _pkey(p)
        if not k or k in keys:
            continue
        keys.add(k)
        out.append({
            "pmid": p.get("pmid", ""), "doi": p.get("doi", ""),
            "title": p.get("title", ""), "first_author": p.get("first_author", ""),
            "journal": p.get("journal", ""), "year": p.get("year", ""),
            "url": p.get("url", ""), "source": p.get("source", ""),
            "cited_by_count": p.get("cited_by_count", 0),
        })
        added += 1
        if len(out) >= cap:
            break
    return out, added


def _refs_context(refs: list[dict], cap: int = 30) -> str:
    """把选题阶段回传的文献拼成带链接的编号上下文, 供立项依据据实引用。"""
    lines = []
    for i, r in enumerate(refs[:cap], 1):
        url = r.get("url", "")
        lines.append(
            f"[{i}] {r.get('first_author', '')} ({r.get('year', '')}). {r.get('title', '')} "
            f"{r.get('journal', '')}. URL: {url}"
        )
    return "\n".join(lines)


def _norm_scheme(obj: dict, fallback_title: str) -> dict:
    def _slist(x):
        return [str(i).strip() for i in x if str(i).strip()] if isinstance(x, list) else []
    return {
        "title": str(obj.get("title") or fallback_title).strip(),
        "question": str(obj.get("question") or "").strip(),
        "hypothesis": str(obj.get("hypothesis") or "").strip(),
        "goal": str(obj.get("goal") or "").strip(),
        "contents": _slist(obj.get("contents")),
        "innovations": _slist(obj.get("innovations")),
        "route": str(obj.get("route") or "").strip(),
    }


async def _converge_scheme(title: str, idea: str, report: str, gt_hint: str) -> dict:
    """方案凝练(helm): 从选题报告里萃取标书的『骨架』。失败回退到空骨架(不阻断写作)。"""
    system = (
        "你是资深的国家自然科学基金评审专家与标书写作顾问。下面给出一个研究方向的选题信息与调研报告。"
        "请把它凝练成一份基金申请书的『方案骨架』, 只输出一个 JSON 对象(不要任何解释), 字段:\n"
        "{\n"
        '  "title": "凝练后的项目题名(简洁、有信息量, ≤30字)",\n'
        '  "question": "1-2句话的关键科学问题(是科学问题, 不是工作任务)",\n'
        '  "hypothesis": "核心科学假设(一句话)",\n'
        '  "goal": "总体研究目标(一句话)",\n'
        '  "contents": ["研究内容1", "研究内容2", "研究内容3"],\n'
        '  "innovations": ["创新点1", "创新点2"],\n'
        '  "route": "一句话概括技术路线主线"\n'
        "}\n"
        f"写作侧重: {gt_hint}\n"
        "铁律: 只依据所给材料合理凝练, 不编造数据或文献; 信息不足的字段给出基于方向的合理推断即可。"
    )
    user = f"【项目题名/方向】{title}\n\n【选题想法】\n{idea or '（见调研报告）'}\n\n【选题调研报告(截断)】\n{report[:3500]}"
    obj = _parse_json(await _complete([{"role": "system", "content": system}, {"role": "user", "content": user}], 700), "{", "}")
    if not isinstance(obj, dict):
        return {}
    return _norm_scheme(obj, title)


def _scheme_brief(scheme: dict) -> str:
    """把方案骨架拼成给各分节写作复用的简报。"""
    if not scheme:
        return ""
    parts = []
    if scheme.get("question"):
        parts.append(f"关键科学问题: {scheme['question']}")
    if scheme.get("hypothesis"):
        parts.append(f"科学假设: {scheme['hypothesis']}")
    if scheme.get("goal"):
        parts.append(f"总体目标: {scheme['goal']}")
    if scheme.get("contents"):
        parts.append("研究内容: " + "; ".join(scheme["contents"]))
    if scheme.get("innovations"):
        parts.append("创新点: " + "; ".join(scheme["innovations"]))
    if scheme.get("route"):
        parts.append(f"技术路线主线: {scheme['route']}")
    return "\n".join(parts)


def _default_outline() -> list[dict]:
    return [{"key": k, "title": _SECTION_MAP[k][0], "budget": _SECTION_MAP[k][2]} for k in _SECTION_ORDER]


async def _adjust_outline(title: str, note: str, current: list[dict]) -> list[dict]:
    """按用户「修改意见」调整大纲(可增删章节 / 改标题 / 改篇幅 / 调顺序)。

    失败或解析不出时回退到 current(或标准大纲), 不阻断确认流程。
    """
    base = current if isinstance(current, list) and current else _default_outline()
    listing = "\n".join(f"- {o.get('key', '')}｜{o.get('title', '')}｜{o.get('budget', '')}" for o in base)
    system = (
        "你是国家自然科学基金标书写作顾问。下面是一份申请书大纲(每行格式: key｜章节标题｜篇幅)。"
        "请按照用户的修改意见调整这份大纲——可以增删章节、改标题、改篇幅、调整顺序。"
        "只输出一个 JSON 数组, 每项形如 {\"key\":\"稳定的英文小写标识\",\"title\":\"章节标题\",\"budget\":\"篇幅描述\"}, "
        "不要任何解释。尽量沿用原有 key; 新增章节用简短英文 key(如 prelim)。"
    )
    user = f"项目/方向：{title or '（未命名）'}\n\n【当前大纲】\n{listing}\n\n【修改意见】\n{note}"
    try:
        arr = _parse_json(await _complete([{"role": "system", "content": system}, {"role": "user", "content": user}], 600), "[", "]")
    except Exception:  # noqa: BLE001
        arr = None
    if not isinstance(arr, list) or not arr:
        return base
    out: list[dict] = []
    for it in arr:
        if not isinstance(it, dict):
            continue
        ttl = str(it.get("title") or "").strip()
        if not ttl:
            continue
        key = str(it.get("key") or "").strip() or f"sec{len(out) + 1}"
        budget = str(it.get("budget") or "").strip() or "约 400-700 字"
        out.append({"key": key, "title": ttl, "budget": budget})
    return out or base


def _resolve_sections(raw) -> list[dict]:
    """把前端回传的(可编辑)大纲规整为可写作的章节列表; 缺省=全部标准章节。

    每项 {key,title,budget}; guide 一律按 key 从 _SECTION_MAP 取(允许标题/预算被用户改写)。
    未知 key 用通用写作要点, 让自定义章节也能写。
    """
    if not isinstance(raw, list) or not raw:
        return [{"key": k, "title": t, "guide": g, "budget": b}
                for k, (t, g, b) in ((k, _SECTION_MAP[k]) for k in _SECTION_ORDER)]
    out = []
    for it in raw:
        if not isinstance(it, dict):
            continue
        key = str(it.get("key") or "").strip() or f"sec{len(out) + 1}"
        std = _SECTION_MAP.get(key)
        title = str(it.get("title") or (std[0] if std else key)).strip()
        budget = str(it.get("budget") or (std[2] if std else "约 400-700 字")).strip()
        guide = std[1] if std else "围绕本章节标题, 结合方案骨架与调研报告撰写规范的基金申请书内容。"
        out.append({"key": key, "title": title, "guide": guide, "budget": budget})
    return out or _resolve_sections(None)


def _section_messages(
    sec_title: str, guide: str, budget: str, gt_name: str, gt_hint: str,
    title: str, scheme_brief: str, report: str, refs_ctx: str, background: str,
) -> list[dict]:
    system = (
        f"你是资深的{gt_name}标书写作专家, 正在撰写申请书的一个章节。"
        f"本次撰写: 《{sec_title}》。写作要点: {guide}\n"
        f"篇幅: {budget}。资助类型侧重: {gt_hint}\n"
        "铁律:\n"
        "1) 引用文献时只能引用下面【可引用的真实文献】中确有的文献, 用 Markdown 链接 [第一作者 et al., 年份](真实URL), "
        "严禁编造任何文献、作者或链接;\n"
        "2) 申请人/团队/单位/经费/设备等无法从材料推断的具体事实, 一律用 [需申请人补充] 占位, 绝不杜撰;\n"
        "3) 基于现状的推断性论断(尚无文献直接支撑)标注 [待验证];\n"
        "4) 用规范、严谨的中文基金申请书语体; 只输出本章节正文(可含子标题), 不要重复大标题、不要写其它章节。"
    )
    user = (
        f"【项目题名】{title}\n\n【研究方案骨架】\n{scheme_brief or '（见调研报告）'}\n\n"
        f"【选题调研报告(供综述现状/空白与提炼)】\n{report[:4000]}\n\n"
        f"【可引用的真实文献】\n{refs_ctx or '（本次无可引用文献, 立项依据可据报告综述但不要编造链接）'}"
    )
    if background.strip():
        user += f"\n\n【申请人/工作条件补充材料】\n{background.strip()[:1500]}"
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


def _revise_messages(
    sec_title: str, guide: str, budget: str, gt_name: str, gt_hint: str,
    title: str, scheme_brief: str, report: str, refs_ctx: str, background: str,
    current: str, note: str,
) -> list[dict]:
    system = (
        f"你是资深的{gt_name}标书写作专家。下面给出申请书某一章节《{sec_title}》的现有正文, 以及用户的修改意见。"
        f"请按修改意见产出【修改后的该章节完整正文】。写作要点: {guide}; 篇幅: {budget}; 侧重: {gt_hint}\n"
        "铁律: 1) 引用只能用下面【可引用的真实文献】中确有的文献, 用 [第一作者 et al., 年份](真实URL) 链接, 严禁编造; "
        "2) 申请人/经费/设备等不可推断的事实用 [需申请人补充] 占位; 推断性论断标 [待验证]; "
        "3) 只输出修改后的本章节正文(可含子标题), 不要重复大标题、不要写其它章节、不要附加说明。"
    )
    user = (
        f"【项目题名】{title}\n\n【研究方案骨架】\n{scheme_brief or '（见调研报告）'}\n\n"
        f"【可引用的真实文献】\n{refs_ctx or '（无可引用文献）'}\n\n"
        f"【本章节现有正文】\n{current or '（空）'}\n\n【用户修改意见】\n{note}"
    )
    if report.strip():
        user += f"\n\n【选题调研报告(参考)】\n{report[:2500]}"
    if background.strip():
        user += f"\n\n【申请人/工作条件补充材料】\n{background.strip()[:1500]}"
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


def _review_messages(title: str, scheme_brief: str, full: str) -> list[dict]:
    system = (
        "你是国家自然科学基金的资深评审专家。下面是一份申请书初稿。请站在评审视角, 给出一份简短的『评审自查』, "
        "用 Markdown 输出:\n"
        "## 模拟评审意见\n列出 3 条评审人最可能质疑或最关注的问题(如科学问题是否凝练、创新性是否充分、"
        "技术路线是否可行、工作基础是否支撑等), 每条后紧跟【应对建议】一句话, 指出申请书应如何补强。\n"
        "## 完善清单\n用勾选项列出申请人提交前仍需补充/核实的关键事项(尤其标了 [需申请人补充]/[待验证] 的地方)。\n"
        "铁律: 基于稿件实际内容点评, 不编造稿件没有的信息; 语气中肯、可操作。"
    )
    user = f"【项目题名】{title}\n\n【方案骨架】\n{scheme_brief}\n\n【申请书初稿(截断)】\n{full[:6000]}"
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


def _grant_type(inputs: dict) -> tuple[str, str]:
    gt_key = (inputs.get("grant_type") or "general").strip()
    return _GRANT_TYPES.get(gt_key, _GRANT_TYPES["general"])


# ---------------------------------------------------------------------------
# 阶段一: 方案凝练 + 大纲(非流式, 供两段式确认)
# ---------------------------------------------------------------------------
async def plan_grant(inputs: dict) -> dict:
    """产出【可编辑的方案骨架 + 大纲】交用户确认。失败也回退到空骨架 + 标准大纲(不阻断)。"""
    title = (inputs.get("title") or inputs.get("field") or "").strip()
    idea = (inputs.get("idea") or "").strip()
    report = (inputs.get("report") or "").strip()
    _, gt_hint = _grant_type(inputs)
    # 用户可带「修改意见」+当前大纲来让 AI 调整大纲(增删/改名/改篇幅/调序)。
    outline_note = (inputs.get("outline_note") or "").strip()
    current_outline = inputs.get("outline") if isinstance(inputs.get("outline"), list) else None
    if settings.mock:
        base = _default_outline()
        if outline_note:  # 演示: 意见非空时示意性加一节
            base = base + [{"key": "prelim", "title": "[MOCK] 新增：预实验基础", "budget": "约 300 字"}]
        return {
            "scheme": _norm_scheme({
                "title": f"[MOCK] {title or '示例项目'}",
                "question": "[MOCK] 本研究拟回答的关键科学问题。",
                "hypothesis": "[MOCK] 核心假设。", "goal": "[MOCK] 总体目标。",
                "contents": ["[MOCK] 研究内容一", "[MOCK] 研究内容二"],
                "innovations": ["[MOCK] 创新点一"], "route": "[MOCK] 技术路线主线。",
            }, title),
            "outline": base,
        }
    if outline_note:
        # 只按意见调整大纲, 不重跑方案凝练(保留用户已确认/编辑的骨架)。
        outline = await _adjust_outline(title, outline_note, current_outline or _default_outline())
        return {"scheme": {}, "outline": outline}
    try:
        scheme = await _converge_scheme(title, idea, report, gt_hint)
    except Exception:  # noqa: BLE001
        scheme = {}
    return {"scheme": scheme or _norm_scheme({}, title), "outline": _default_outline()}


# ---------------------------------------------------------------------------
# 阶段二: 分节撰写 + 评审自查(流式)
# ---------------------------------------------------------------------------
async def _mock_write(sections: list[dict]) -> AsyncIterator[tuple[str, dict]]:
    for s in sections:
        yield ("status", {"message": f"正在撰写{s['title']}…"})
        yield ("section", {"key": s["key"], "title": s["title"]})
        for ch in f"[MOCK] 本节（{s['title']}）为演示文本, 真实模式下会据选题报告与文献撰写。\n\n":
            yield ("delta", {"text": ch})
    yield ("status", {"message": "正在做评审视角自查…"})
    yield ("section", {"key": "review", "title": "评审自查"})
    for ch in "## 模拟评审意见\n[MOCK] 1. 科学问题需更聚焦。【应对建议】在第二节凝练为单一核心问题。\n":
        yield ("delta", {"text": ch})
    yield ("verify", {"total": 0, "verified": 0, "unverified": []})


async def write_grant(inputs: dict) -> AsyncIterator[tuple[str, dict]]:
    title = (inputs.get("title") or inputs.get("field") or "").strip()
    idea = (inputs.get("idea") or "").strip()
    report = (inputs.get("report") or "").strip()
    background = (inputs.get("background") or "").strip()
    refs = inputs.get("references") or inputs.get("refs") or []
    if not isinstance(refs, list):
        refs = []
    gt_name, gt_hint = _grant_type(inputs)
    pre_scheme = inputs.get("scheme") if isinstance(inputs.get("scheme"), dict) else None
    sections = _resolve_sections(inputs.get("sections"))

    if not title and not report:
        yield ("error", {"message": "请先填写项目题名/方向, 或从「找选题」结果一键带入。"})
        return
    if not sections:
        yield ("error", {"message": "大纲为空, 请至少保留一个章节。"})
        return

    if settings.mock:
        if pre_scheme is None:
            yield ("status", {"message": "正在从选题结果凝练研究方案…"})
            yield ("scheme", _norm_scheme({"title": f"[MOCK] {title}"}, title))
        yield ("outline", {"items": [{"key": s["key"], "title": s["title"], "budget": s["budget"]} for s in sections]})
        async for ev in _mock_write(sections):
            yield ev
        yield ("done", {})
        return

    try:
        # 方案骨架: 用前端确认过的; 没有则现凝练。
        if pre_scheme is not None:
            scheme = _norm_scheme(pre_scheme, title)
        else:
            yield ("status", {"message": "正在从选题结果凝练研究方案(科学问题/假设/目标/创新)…"})
            scheme = await _converge_scheme(title, idea, report, gt_hint)
            if scheme:
                yield ("scheme", scheme)
        final_title = scheme.get("title") or title or "（未命名项目）"
        scheme_brief = _scheme_brief(scheme)

        # 撰写前默认按该方向重新检索一遍文献并入池(research 默认 True, 前端可关)。
        # 让立项依据据"针对本方向、新鲜检索到"的文献来写, 而非只吃选题阶段带来的少量文献。
        if inputs.get("research", True):
            yield ("status", {"message": "撰写前正在按该方向重新检索文献…"})
            direction = idea or final_title or title
            try:
                queries = await _gen_queries(direction, "", final_title)
                res = await search_literature(queries, per_query=8, cap=16, sources=_RERESEARCH_SOURCES)
                refs, added = _merge_refs(refs, res.get("papers", []))
                if added:
                    yield ("status", {"message": f"新增 {added} 篇相关文献，将据此撰写立项依据…"})
                    yield ("references", {"items": refs})
                else:
                    yield ("status", {"message": "未检索到新文献，按已带入文献撰写…"})
            except Exception:  # noqa: BLE001
                # 撰写前检索失败不阻断写作, 退回用已带入的文献。
                yield ("status", {"message": "撰写前检索未成功，按已带入文献继续…"})

        yield ("outline", {"items": [{"key": s["key"], "title": s["title"], "budget": s["budget"]} for s in sections]})

        refs_ctx = _refs_context(refs)
        full = ""
        n = len(sections)
        for i, s in enumerate(sections):
            yield ("status", {"message": f"正在撰写《{s['title']}》（{i + 1}/{n}）…"})
            yield ("section", {"key": s["key"], "title": s["title"]})
            full += f"\n\n## {s['title']}\n"
            msgs = _section_messages(
                s["title"], s["guide"], s["budget"], gt_name, gt_hint,
                final_title, scheme_brief, report, refs_ctx, background,
            )
            async for piece in stream_chat(msgs):
                full += piece
                yield ("delta", {"text": piece})

        # 评审自查
        yield ("status", {"message": "初稿完成, 正在做评审视角自查…"})
        yield ("section", {"key": "review", "title": "评审自查"})
        async for piece in stream_chat(_review_messages(final_title, scheme_brief, full)):
            full += piece
            yield ("delta", {"text": piece})

        if refs:
            yield ("verify", _verify_citations(full, refs))
        yield ("done", {})
    except Exception as e:  # noqa: BLE001
        print("[grant] exception:\n" + traceback.format_exc(), flush=True)
        yield ("error", {"message": f"标书生成出错：{type(e).__name__}: {e}"})


# ---------------------------------------------------------------------------
# 逐节重写(流式): 仅按意见重写某一章节, 不重跑全篇
# ---------------------------------------------------------------------------
async def revise_section(inputs: dict) -> AsyncIterator[tuple[str, dict]]:
    sec = inputs.get("section") if isinstance(inputs.get("section"), dict) else {}
    note = (inputs.get("note") or "").strip()
    current = (inputs.get("current") or "").strip()
    title = (inputs.get("title") or "").strip()
    report = (inputs.get("report") or "").strip()
    background = (inputs.get("background") or "").strip()
    refs = inputs.get("references") or inputs.get("refs") or []
    if not isinstance(refs, list):
        refs = []
    gt_name, gt_hint = _grant_type(inputs)
    scheme = inputs.get("scheme") if isinstance(inputs.get("scheme"), dict) else {}
    do_research = bool(inputs.get("research"))

    if not note:
        yield ("error", {"message": "请填写本节的修改意见。"})
        return
    resolved = _resolve_sections([sec])[0] if sec else None
    if not resolved:
        yield ("error", {"message": "缺少要修改的章节信息。"})
        return

    if settings.mock:
        if do_research:
            yield ("status", {"message": "正在按新方向检索文献…"})
            refs = list(refs) + [{
                "pmid": "00000002", "title": f"[MOCK] new evidence for {note}",
                "first_author": "New A", "journal": "Mock J", "year": "2025",
                "url": "https://pubmed.ncbi.nlm.nih.gov/00000002/", "source": "pubmed", "cited_by_count": 3,
            }]
            yield ("references", {"items": refs})
        for ch in f"[MOCK] 已按意见「{note}」{'重新调研并' if do_research else ''}重写《{resolved['title']}》。\n":
            yield ("delta", {"text": ch})
        yield ("verify", {"total": 0, "verified": 0, "unverified": []})
        yield ("done", {})
        return

    try:
        # 可选: 按新方向重新检索, 把新文献并入文献池(只在用户点『重新调研重写』时)。
        if do_research:
            yield ("status", {"message": "正在把新方向转成检索式…"})
            direction = note + (f"（围绕：{title}）" if title else "")
            queries = await _gen_queries(direction, "", title)
            yield ("status", {"message": "正在检索 PubMed / Europe PMC / OpenAlex…"})
            res = await search_literature(queries, per_query=8, cap=12, sources=_RERESEARCH_SOURCES)
            refs, added = _merge_refs(refs, res.get("papers", []))
            if added:
                yield ("status", {"message": f"新增 {added} 篇文献，正在据新文献重写本节…"})
                yield ("references", {"items": refs})
            else:
                yield ("status", {"message": "未检索到新文献，按现有文献重写本节…"})

        refs_ctx = _refs_context(refs)
        scheme_brief = _scheme_brief(_norm_scheme(scheme, title)) if scheme else ""
        full = ""
        msgs = _revise_messages(
            resolved["title"], resolved["guide"], resolved["budget"], gt_name, gt_hint,
            title, scheme_brief, report, refs_ctx, background, current, note,
        )
        async for piece in stream_chat(msgs):
            full += piece
            yield ("delta", {"text": piece})
        if refs:
            yield ("verify", _verify_citations(full, refs))
        yield ("done", {})
    except Exception as e:  # noqa: BLE001
        print("[grant-revise] exception:\n" + traceback.format_exc(), flush=True)
        yield ("error", {"message": f"章节修改出错：{type(e).__name__}: {e}"})

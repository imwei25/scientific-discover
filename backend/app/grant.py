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
  ("review_data", {...})              评审组结构化结果(均分/等级/分节问题/覆盖度), 供前端联动逐节修订
  ("verify", {...})                   引用核验结果
  ("error", {"message": ...})
"""
from __future__ import annotations

import asyncio
import json
import traceback
from typing import AsyncIterator

from .config import settings
from .literature import search_literature
from .llm import stream_chat
# 复用找选题的: 引用核验(含支持句) / 支持句规则 / 主题→PubMed检索式 / 文献去重键
from .research import _verify_citations, _gen_queries, _pkey, _QUOTE_RULE
from .logutil import log_swallow

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
        "分: (1) 研究方法与技术路线; (2) 实验设计与关键技术; "
        "(3) 可行性分析(从科学依据、研究基础、技术条件三方面论证)。方法学要具体、可落地。"
        "在(1)末尾用一个 ```mermaid 代码块画技术路线图: 第一行 flowchart TD; 节点写成 A[\"简短中文标签\"] 形式"
        "(标签一律用双引号包住, 内不含引号/括号), 用 --> 连接、可用 -->|标注| 表示分支; 共 8-14 个节点, "
        "覆盖『科学问题→研究内容→关键方法→验证→预期产出』主线, 与正文描述一致。",
        "约 800-1100 字"),
    "innovation": ("四、本项目的特色与创新之处",
        "分点给出 2-4 条特色与创新; 每条对照研究现状指出『新在哪、与已有工作的差异』, 避免空泛口号。",
        "约 300-500 字"),
    "plan": ("五、年度研究计划与预期研究成果",
        "(1) 年度研究计划——按年度(如 3 年)列出阶段任务与里程碑(用 Markdown 表格或分点), 之后再用一个 "
        "```mermaid 代码块画甘特图: 第一行 gantt, 第二行 dateFormat YYYY-MM, 第三行 axisFormat %Y-%m; "
        "每年一个 section(如 section 第1年), 每行任务写成 `任务名 :y1a, 2027-01, 6M`"
        "(任务 id 用 y1a 这类简短英文且不重复, 起始年月按项目从 2027-01 开始的占位、供申请人改, 时长以 M 结尾; "
        "任务名内不要出现冒号或逗号); "
        "(2) 预期成果——论文/专利/人才培养等, 数量与去向用 [需申请人补充] 占位, 不虚报。",
        "约 300-500 字"),
    "foundation": ("六、研究基础与工作条件",
        "(1) 研究基础——申请人/团队与本项目相关的前期工作积累; (2) 工作条件——依托单位的平台、设备、样本来源等。"
        "本节涉及大量个人/单位事实, 凡上游材料未提供的一律用 [需申请人补充] 占位, 严禁编造论文、项目、设备或人员。",
        "约 300-500 字"),
}
_SECTION_ORDER = ["rationale", "objectives", "scheme", "innovation", "plan", "foundation"]


async def _complete(messages: list[dict], max_tokens: int = 400, task: str = "grant_plan") -> str:
    buf = ""
    async for piece in stream_chat(messages, task=task, max_tokens=max_tokens):
        buf += piece
    return buf


def _parse_json(raw: str, opener: str, closer: str):
    s, e = raw.find(opener), raw.rfind(closer)
    if s == -1 or e == -1:
        return None
    try:
        return json.loads(raw[s : e + 1])
    except Exception as exc:  # noqa: BLE001
        log_swallow("写标书: LLM 输出无法解析为 JSON(将走默认兜底)", exc)
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
            # 保留截断摘要: 撰写时据此逐字摘录『支持句』, 写完做支持句核验。
            "abstract": (p.get("abstract") or "").strip()[:800],
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
        line = (
            f"[{i}] {r.get('first_author', '')} ({r.get('year', '')}). {r.get('title', '')} "
            f"{r.get('journal', '')}. URL: {url}"
        )
        # 附摘要节选(原文): 供撰写立项依据时逐字摘录『支持句』, 不改写。
        ab = (r.get("abstract") or "").strip()
        if ab:
            line += f"\n    摘要(节选): {ab[:400]}"
        lines.append(line)
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
        "1) 引用文献时只能引用下面【可引用的真实文献】中确有的文献, 严禁编造任何文献、作者或链接; "
        + _QUOTE_RULE + "支持句必须逐字取自该文献下方的『摘要(节选)』;\n"
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
        "铁律: 1) 引用只能用下面【可引用的真实文献】中确有的文献, 严禁编造; " + _QUOTE_RULE +
        "支持句必须逐字取自该文献下方的『摘要(节选)』; "
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
    """单评委自查(多评委评审全部失败时的兜底)。"""
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


# ---------------------------------------------------------------------------
# 评审组模拟评审: 多评委独立评审(JSON 打分+问题) → 确定性汇总 → 合议意见(流式)
# 借鉴 Granted AI「独立评审+合议共识」、LXLTX 定量打分、jinyh 评审挂靠文献证据。
# ---------------------------------------------------------------------------

# 各资助子类型的评审侧重(与 _GRANT_TYPES 的"写作侧重"相对应, 注入每位评委的评审 prompt)。
_REVIEW_FOCUS = {
    "youth": "本子类型(青年科学基金)的评审侧重: 重点看申请人创新潜力与研究方案的匹配、科学问题是否聚焦不贪大、"
             "前期基础是否足以支撑; 对研究体系的完整性与团队规模要求相对宽松。",
    "general": "本子类型(面上项目)的评审侧重: 重点看科学问题的重要性与深度、研究设计的系统性、"
               "团队积累与前期工作的连续性; 创新性与可行性并重。",
    "regional": "本子类型(地区科学基金)的评审侧重: 兼顾科学价值与地区特色/资源优势, "
                "重点看依托单位条件是否支撑、研究是否结合区域实际问题。",
    "general_other": "本子类型(通用申请书)的评审侧重: 重点看研究意义、内容设置的合理性与可行性论证是否完整规范。",
}

# 评审组: key → (评委名称, 人设与关注点)。各自独立评审后由"组长"合议。
_PERSONAS: list[tuple[str, str, str]] = [
    ("peer", "同行领域专家",
     "你精通本领域研究现状。重点评: 科学问题是否重要且凝练、立项依据是否扎实、创新点相对已有工作是否成立; "
     "点评研究现状相关问题时, 尽量对照【可引用的真实文献】给出依据。"),
    ("methods", "方法学与统计专家",
     "你负责技术路线与研究设计。重点评: 技术路线是否完整可行、实验设计与统计考虑是否严谨、"
     "样本量/对照/偏倚控制是否交代、关键环节有无备选方案与风险预案。"),
    ("admin", "形式审查与申报要求专家",
     "你负责对照申报要求清单逐项检查完整性与规范性(清单见用户消息), 并关注占位符是否留待补充、预期成果是否虚报。"),
    ("devil", "以挑剔著称的资深评委",
     "你的任务是找致命伤: 科学假设可能不成立之处、与已有工作的实质性重复、工作量与研究周期是否匹配、"
     "研究基础能否支撑、论证链条的断点。宁可苛刻, 不可放过。"),
]

# 申报要求覆盖度清单(NSFC 通用): 由"形式审查"评委逐项判定 covered/partial/missing。
_COVERAGE_ITEMS = [
    "科学问题明确且凝练(是科学问题而非工作任务)",
    "科学假设清晰、可检验",
    "对照国内外研究现状, 指出了明确的研究空白",
    "创新点具体, 说清了『新在哪、与已有工作差异』",
    "研究内容与研究目标一一对应、聚焦不发散",
    "技术路线完整可行, 关键环节有备选方案或风险预案",
    "可行性从科学依据、研究基础、技术条件三方面论证",
    "年度计划有阶段任务与里程碑, 与研究内容匹配",
    "预期成果具体且不虚报(数量/去向留待申请人核实)",
    "研究基础与工作条件能支撑本项目(缺失处已用占位符标明)",
    "引用文献均为真实可溯源文献(带可点击链接)",
    "无法推断的申请人/经费/设备信息用 [需申请人补充] 占位而非杜撰",
]

_GRADE_LABELS = {"A": "优先资助", "B": "可资助", "C": "暂不建议资助（建议修改后再申报）"}

# 申报合规提醒(静态, 不走 LLM): 评审报告末尾固定追加。
_COMPLIANCE_NOTE = """

---

### ⚖️ 申报合规提醒

- 国家自然科学基金委已明确规范申请中的 AI 使用：**不得将生成式 AI 直接生成的内容作为申请书提交**。本产出仅为辅助初稿，请逐句人工改写、核实后再用于申报，并按依托单位要求如实说明 AI 辅助情况。
- 引用文献的真实性与恰当性由申请人负责——请点开正文中每条文献链接逐一核对（自动引用核验结果供参考）。
- 提交前请自查当年《项目指南》的**限项规定**、申请代码、研究期限与经费编制口径。
- 所有 `[需申请人补充]` 与 `[待验证]` 占位处必须补齐、核实后方可提交。
"""


def _persona_messages(
    pkey: str, pname: str, pfocus: str, gt_name: str, review_focus: str,
    title: str, scheme_brief: str, sec_keys: list[tuple[str, str]], full: str, refs_ctx: str,
) -> list[dict]:
    key_listing = "\n".join(f"  {k} = {t}" for k, t in sec_keys)
    coverage_field = ""
    coverage_block = ""
    if pkey == "admin":
        coverage_field = (
            ',\n  "coverage": [{"item": "原样照抄清单条目", "status": "covered|partial|missing", '
            '"note": "一句话依据"}]  // 对【申报要求清单】逐项判定'
        )
        coverage_block = "\n\n【申报要求清单(逐项判定)】\n" + "\n".join(f"- {it}" for it in _COVERAGE_ITEMS)
    system = (
        f"你是{gt_name}评审组中的一位评审专家: {pname}。{pfocus}\n{review_focus}\n"
        "请独立评审下面的申请书初稿, 只输出一个 JSON 对象(不要任何解释), 字段:\n"
        "{\n"
        '  "scores": {"<章节key>": 0到10的整数, ...},  // 逐章节打分, 章节key对照见下\n'
        '  "overall": 0到10的整数,                      // 总体印象分\n'
        '  "grade": "A|B|C",                            // A=优先资助, B=可资助, C=暂不建议资助\n'
        '  "strengths": ["优点", ...],                  // 1-3 条\n'
        '  "issues": [                                   // 3-6 条, 按严重度从高到低\n'
        '    {"section": "<章节key>", "severity": "高|中|低",\n'
        '     "problem": "问题描述(具体、指向稿件内容)",\n'
        '     "advice": "一句话修改建议",\n'
        '     "evidence": "若与研究现状有关且【可引用的真实文献】里有依据, 给 [第一作者 et al., 年份](URL); 否则留空字符串"}\n'
        "  ]" + coverage_field + "\n"
        "}\n"
        f"章节key对照:\n{key_listing}\n"
        "铁律: 只基于稿件与所给材料点评, 不编造稿件没有的内容; evidence 只能用【可引用的真实文献】中确有的链接, 不确定就留空。"
    )
    user = (
        f"【项目题名】{title}\n\n【方案骨架】\n{scheme_brief or '（无）'}\n\n"
        f"【申请书初稿(截断)】\n{full[:7000]}\n\n"
        f"【可引用的真实文献】\n{refs_ctx or '（无）'}" + coverage_block
    )
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


def _clamp_score(v) -> int | None:
    try:
        return max(0, min(10, int(round(float(v)))))
    except (TypeError, ValueError):
        return None


async def _persona_review(
    pkey: str, pname: str, pfocus: str, gt_name: str, review_focus: str,
    title: str, scheme_brief: str, sec_keys: list[tuple[str, str]], full: str, refs_ctx: str,
) -> dict | None:
    """一位评委的独立评审; 任何失败(网络/解析)都返回 None, 不阻断其他评委。"""
    try:
        raw = await _complete(
            _persona_messages(pkey, pname, pfocus, gt_name, review_focus,
                              title, scheme_brief, sec_keys, full, refs_ctx),
            max_tokens=2000, task="grant_review",
        )
    except Exception as exc:  # noqa: BLE001
        log_swallow(f"写标书/评审组: 评委「{pname}」评审失败(跳过该评委)", exc)
        return None
    obj = _parse_json(raw, "{", "}")
    if not isinstance(obj, dict):
        return None
    valid_keys = {k for k, _ in sec_keys}
    scores = {}
    if isinstance(obj.get("scores"), dict):
        for k, v in obj["scores"].items():
            s = _clamp_score(v)
            if k in valid_keys and s is not None:
                scores[k] = s
    issues = []
    for it in obj.get("issues") or []:
        if not isinstance(it, dict):
            continue
        problem = str(it.get("problem") or "").strip()
        if not problem:
            continue
        issues.append({
            "section": str(it.get("section") or "").strip(),
            "severity": str(it.get("severity") or "中").strip() or "中",
            "problem": problem[:400],
            "advice": str(it.get("advice") or "").strip()[:300],
            "evidence": str(it.get("evidence") or "").strip()[:300],
        })
    coverage = []
    for it in obj.get("coverage") or []:
        if not isinstance(it, dict):
            continue
        item = str(it.get("item") or "").strip()
        status = str(it.get("status") or "").strip().lower()
        if item and status in {"covered", "partial", "missing"}:
            coverage.append({"item": item[:120], "status": status,
                             "note": str(it.get("note") or "").strip()[:200]})
    grade = str(obj.get("grade") or "").strip().upper()
    return {
        "key": pkey, "persona": pname,
        "scores": scores,
        "overall": _clamp_score(obj.get("overall")),
        "grade": grade if grade in ("A", "B", "C") else None,
        "strengths": [str(s).strip()[:200] for s in (obj.get("strengths") or []) if str(s).strip()][:3],
        "issues": issues[:6],
        "coverage": coverage,
    }


def _aggregate_reviews(results: list[dict], sec_keys: list[tuple[str, str]]) -> dict:
    """把各评委的 JSON 汇总成结构化评审数据(均分/等级/分节问题/覆盖度)。"""
    sec_scores: dict[str, float | None] = {}
    for k, _t in sec_keys:
        vals = [r["scores"][k] for r in results if k in r.get("scores", {})]
        sec_scores[k] = round(sum(vals) / len(vals), 1) if vals else None
    overalls = [r["overall"] for r in results if r.get("overall") is not None]
    overall = round(sum(overalls) / len(overalls), 1) if overalls else None
    if overall is None:
        grade = "B"
    elif overall >= 8:
        grade = "A"
    elif overall >= 6:
        grade = "B"
    else:
        grade = "C"
    votes = {"A": 0, "B": 0, "C": 0}
    for r in results:
        if r.get("grade") in votes:
            votes[r["grade"]] += 1
    issues_by_sec: dict[str, list[dict]] = {}
    for r in results:
        for it in r.get("issues") or []:
            k = it.get("section") or "general"
            issues_by_sec.setdefault(k, []).append({**it, "by": r["persona"]})
    coverage = next((r["coverage"] for r in results if r.get("coverage")), [])
    return {
        "personas": [r["persona"] for r in results],
        "overall": overall,
        "grade": grade,
        "grade_label": _GRADE_LABELS[grade],
        "votes": votes,
        "scores": sec_scores,
        "sections": [
            {"key": k, "title": t, "score": sec_scores.get(k), "issues": issues_by_sec.get(k, [])}
            for k, t in sec_keys
        ],
        "general_issues": issues_by_sec.get("general", []),
        "coverage": coverage,
    }


_COVER_MARKS = {"covered": "✅", "partial": "⚠️", "missing": "❌"}


def _score_tables_md(agg: dict, results: list[dict], sec_keys: list[tuple[str, str]]) -> str:
    """确定性生成评分表 + 资助建议 + 覆盖度表(不走 LLM, 保证数字与 review_data 一致)。"""
    names = [r["persona"] for r in results]
    lines = [f"### 评审组评分（{len(results)} 位专家独立打分）", ""]
    lines.append("| 章节 | " + " | ".join(names) + " | 均分 |")
    lines.append("|---" * (len(names) + 2) + "|")
    for k, t in sec_keys:
        row = [t]
        for r in results:
            v = r.get("scores", {}).get(k)
            row.append("—" if v is None else str(v))
        avg = agg["scores"].get(k)
        row.append("—" if avg is None else f"**{avg}**")
        lines.append("| " + " | ".join(row) + " |")
    row = ["**总体**"]
    for r in results:
        row.append("—" if r.get("overall") is None else str(r["overall"]))
    row.append("—" if agg["overall"] is None else f"**{agg['overall']}**")
    lines.append("| " + " | ".join(row) + " |")
    votes = agg["votes"]
    vote_txt = " / ".join(f"{g}×{n}" for g, n in votes.items() if n)
    lines.append("")
    lines.append(f"**资助建议：{agg['grade']}（{agg['grade_label']}）**" + (f"（专家评级：{vote_txt}）" if vote_txt else ""))
    if agg.get("coverage"):
        lines += ["", "### 申报要求覆盖度", "", "| 申报要求 | 覆盖 | 说明 |", "|---|---|---|"]
        for c in agg["coverage"]:
            mark = _COVER_MARKS.get(c["status"], "⚠️")
            lines.append(f"| {c['item']} | {mark} | {c['note'] or '—'} |")
    lines.append("")
    return "\n".join(lines) + "\n"


def _consensus_messages(title: str, agg: dict, results: list[dict]) -> list[dict]:
    """合议: 组长把各评委意见合并去重成一份可操作的评审报告(流式)。"""
    system = (
        "你是基金评审组组长, 正在主持合议。下面给出各位评审专家的独立意见(JSON)。"
        "请把它们综合成一份合议评审意见, 用 Markdown 输出(不要输出评分表, 评分表已单独给出):\n"
        "### 合议意见\n一小段综合评价: 主要优点与总体判断, 结论须与给定的资助建议一致。\n"
        "### 主要问题与修改建议\n把各专家的问题合并去重后按严重度从高到低列 4-8 条; 每条格式:\n"
        "**［严重度·章节］** 问题描述。**修改建议：** 一句话。多位专家共同指出的, 注明(N 位专家指出); "
        "专家意见里带文献链接(evidence)的, 原样保留该 Markdown 链接作为依据。\n"
        "### 提交前完善清单\n用 `- [ ]` 勾选项列出提交前必须补充/核实的事项(尤其占位符与覆盖度为 partial/missing 的项)。\n"
        "铁律: 只综合专家意见与所给事实, 不新增编造; 文献链接只能原样搬运专家意见中已有的, 不得自造。"
    )
    user = (
        f"【项目题名】{title}\n\n【资助建议(已定)】{agg['grade']}（{agg['grade_label']}），总体均分 {agg['overall']}\n\n"
        f"【各专家独立意见(JSON)】\n{json.dumps(results, ensure_ascii=False)[:9000]}"
    )
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


async def _run_review(
    title: str, gt_key: str, scheme_brief: str, written: list[dict], refs: list[dict],
) -> AsyncIterator[tuple[str, dict]]:
    """评审组模拟评审流程, yield: section/status/review_data/delta。

    written: [{key,title,text}] 已写好的正文章节(不含评审节)。
    """
    gt_name, _ = _GRANT_TYPES.get(gt_key, _GRANT_TYPES["general"])
    review_focus = _REVIEW_FOCUS.get(gt_key, _REVIEW_FOCUS["general"])
    refs_ctx = _refs_context(refs)
    sec_keys = [(w["key"], w["title"]) for w in written]
    full = "\n\n".join(f"## {w['title']}\n{w['text']}" for w in written)

    yield ("section", {"key": "review", "title": "评审组模拟评审"})
    yield ("status", {"message": f"评审组 {len(_PERSONAS)} 位专家正在独立评审…"})

    tasks = [
        asyncio.create_task(_persona_review(
            pk, pn, pf, gt_name, review_focus, title, scheme_brief, sec_keys, full, refs_ctx))
        for pk, pn, pf in _PERSONAS
    ]
    results: list[dict] = []
    done_n = 0
    for fut in asyncio.as_completed(tasks):
        res = await fut
        done_n += 1
        yield ("status", {"message": f"独立评审进行中（{done_n}/{len(_PERSONAS)} 位专家完成）…"})
        if res:
            results.append(res)
    # 按评审组固定顺序排, 保证评分表列序稳定。
    order = {pk: i for i, (pk, _n, _f) in enumerate(_PERSONAS)}
    results.sort(key=lambda r: order.get(r["key"], 99))

    if not results:
        # 多评委全部失败: 退回单评委自查, 不阻断产出。
        yield ("status", {"message": "评审组评审未成功，退回单视角自查…"})
        async for piece in stream_chat(_review_messages(title, scheme_brief, full), task="grant_review"):
            yield ("delta", {"text": piece})
        yield ("delta", {"text": _COMPLIANCE_NOTE})
        return

    agg = _aggregate_reviews(results, sec_keys)
    yield ("review_data", agg)
    yield ("delta", {"text": _score_tables_md(agg, results, sec_keys)})

    yield ("status", {"message": "评审组正在合议…"})
    try:
        async for piece in stream_chat(_consensus_messages(title, agg, results), task="grant_review"):
            yield ("delta", {"text": piece})
    except Exception as exc:  # noqa: BLE001
        # 合议失败不吞掉已有产出: 评分表已给出, 直接罗列各评委原始问题兜底。
        log_swallow("写标书/评审组: 合议生成失败, 罗列各评委问题兜底", exc)
        lines = ["", "### 各评委主要问题（合议生成失败，原样罗列）", ""]
        for r in results:
            for it in r.get("issues") or []:
                ev = f" 依据: {it['evidence']}" if it.get("evidence") else ""
                lines.append(f"- **［{it['severity']}］**（{r['persona']}）{it['problem']}"
                             f"{' **建议：**' + it['advice'] if it.get('advice') else ''}{ev}")
        yield ("delta", {"text": "\n".join(lines) + "\n"})
    yield ("delta", {"text": _COMPLIANCE_NOTE})


def _grant_key(inputs: dict) -> str:
    k = (inputs.get("grant_type") or "general").strip()
    return k if k in _GRANT_TYPES else "general"


def _grant_type(inputs: dict) -> tuple[str, str]:
    return _GRANT_TYPES[_grant_key(inputs)]


async def extract_style_profile(sample_text: str) -> str:
    """从文风样例提炼一份简短中文『文风档案』(只描述语言风格, 不复述样例内容)。

    失败/空样例返回 ""(降级=撰写时不模仿, 不阻断)。
    """
    text = (sample_text or "").strip()
    if not text:
        return ""
    if settings.mock:
        return "[MOCK] 文风档案: 句式长短交错; 用词平实、术语克制; 先总后分; 少用套话。"
    system = (
        "你是资深中文科研写作分析师。下面给你一段作者的写作样例。"
        "请只【分析并总结它的语言风格】, 产出一份 150-250 字的中文『文风档案』, 用分点或短句描述:"
        "句子长短与节奏、用词倾向(书面/平实/术语密度)、语气(克制/热情/主观)、"
        "常用的连接与过渡方式、段落展开习惯(先总后分/先例后论等)、人称与时态偏好、"
        "是否爱用排比/设问/比喻等。\n"
        "铁律: 只描述『怎么写』, 严禁复述、引用或提及样例里的任何具体研究对象、数据、结论、"
        "专有名词或原句; 不要评价好坏; 只输出文风档案本身, 不要前后缀。"
    )
    try:
        profile = await _complete(
            [{"role": "system", "content": system}, {"role": "user", "content": text[:6000]}],
            max_tokens=500, task="grant_style",
        )
    except Exception:  # noqa: BLE001
        return ""
    return profile.strip()


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
def _mock_review_data(sections: list[dict]) -> dict:
    """演示/测试用的确定性评审结构化数据。"""
    secs = [s for s in sections if s.get("key") != "review"]
    return {
        "personas": ["同行领域专家", "方法学与统计专家", "形式审查与申报要求专家", "以挑剔著称的资深评委"],
        "overall": 7.0, "grade": "B", "grade_label": _GRADE_LABELS["B"],
        "votes": {"A": 0, "B": 3, "C": 1},
        "scores": {s["key"]: 7.0 for s in secs},
        "sections": [
            {"key": s["key"], "title": s["title"], "score": 7.0,
             "issues": [{"section": s["key"], "severity": "中",
                         "problem": f"[MOCK] 《{s['title']}》论证还可更充分。",
                         "advice": "[MOCK] 补充关键细节。", "evidence": "", "by": "同行领域专家"}]}
            for s in secs[:2]
        ],
        "general_issues": [],
        "coverage": [{"item": _COVERAGE_ITEMS[0], "status": "covered", "note": "[MOCK] 已覆盖"}],
    }


async def _mock_write(sections: list[dict]) -> AsyncIterator[tuple[str, dict]]:
    for s in sections:
        yield ("status", {"message": f"正在撰写{s['title']}…"})
        yield ("section", {"key": s["key"], "title": s["title"]})
        for ch in f"[MOCK] 本节（{s['title']}）为演示文本, 真实模式下会据选题报告与文献撰写。\n\n":
            yield ("delta", {"text": ch})
    yield ("status", {"message": "评审组 4 位专家正在独立评审…"})
    yield ("section", {"key": "review", "title": "评审组模拟评审"})
    yield ("review_data", _mock_review_data(sections))
    for ch in ("### 评审组评分（4 位专家独立打分）\n\n[MOCK] 评分表见结构化数据。\n\n"
               "**资助建议：B（可资助）**\n\n### 合议意见\n[MOCK] 科学问题需更聚焦。**修改建议：** 在第二节凝练为单一核心问题。\n"):
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
        written: list[dict] = []  # [{key,title,text}] 供评审组按章节打分
        n = len(sections)
        for i, s in enumerate(sections):
            yield ("status", {"message": f"正在撰写《{s['title']}》（{i + 1}/{n}）…"})
            yield ("section", {"key": s["key"], "title": s["title"]})
            full += f"\n\n## {s['title']}\n"
            msgs = _section_messages(
                s["title"], s["guide"], s["budget"], gt_name, gt_hint,
                final_title, scheme_brief, report, refs_ctx, background,
            )
            sec_buf = ""
            async for piece in stream_chat(msgs, task="grant_write"):
                sec_buf += piece
                full += piece
                yield ("delta", {"text": piece})
            written.append({"key": s["key"], "title": s["title"], "text": sec_buf})

        # 评审组模拟评审(多评委独立评审 + 合议)
        yield ("status", {"message": "初稿完成, 评审组开始独立评审…"})
        async for event, data in _run_review(final_title, _grant_key(inputs), scheme_brief, written, refs):
            if event == "delta":
                full += data.get("text", "")
            yield (event, data)

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
        async for piece in stream_chat(msgs, task="grant_revise"):
            full += piece
            yield ("delta", {"text": piece})
        if refs:
            yield ("verify", _verify_citations(full, refs))
        yield ("done", {})
    except Exception as e:  # noqa: BLE001
        print("[grant-revise] exception:\n" + traceback.format_exc(), flush=True)
        yield ("error", {"message": f"章节修改出错：{type(e).__name__}: {e}"})


# ---------------------------------------------------------------------------
# 独立重评(流式): 对当前全文重新跑一遍评审组(修订后回头看改进了没)
# ---------------------------------------------------------------------------
async def review_grant(inputs: dict) -> AsyncIterator[tuple[str, dict]]:
    """inputs.sections = [{key,title,text}] 为正文章节(不含评审节); 产出与写作末尾的评审一致。"""
    title = (inputs.get("title") or "").strip()
    scheme = inputs.get("scheme") if isinstance(inputs.get("scheme"), dict) else {}
    refs = inputs.get("references") or inputs.get("refs") or []
    if not isinstance(refs, list):
        refs = []
    raw_secs = inputs.get("sections")
    written = []
    if isinstance(raw_secs, list):
        for s in raw_secs:
            if not isinstance(s, dict):
                continue
            text = str(s.get("text") or "").strip()
            t = str(s.get("title") or "").strip()
            if not text or not t or s.get("key") == "review":
                continue
            written.append({"key": str(s.get("key") or f"sec{len(written) + 1}"), "title": t, "text": text})
    if not written:
        yield ("error", {"message": "没有可评审的章节正文，请先生成或粘贴申请书内容。"})
        return

    if settings.mock:
        yield ("section", {"key": "review", "title": "评审组模拟评审"})
        yield ("review_data", _mock_review_data(written))
        for ch in "[MOCK] 重新评审完成：**资助建议：B（可资助）**\n":
            yield ("delta", {"text": ch})
        yield ("done", {})
        return

    try:
        scheme_brief = _scheme_brief(_norm_scheme(scheme, title)) if scheme else ""
        async for event, data in _run_review(title or "（未命名项目）", _grant_key(inputs), scheme_brief, written, refs):
            yield (event, data)
        yield ("done", {})
    except Exception as e:  # noqa: BLE001
        print("[grant-review] exception:\n" + traceback.format_exc(), flush=True)
        yield ("error", {"message": f"重新评审出错：{type(e).__name__}: {e}"})

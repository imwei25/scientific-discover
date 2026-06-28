"""四大能力的提示词构建。

每个模块把用户的结构化输入拼成一组 messages 交给 LLM。
设计原则:
  - 角色化、给出明确产出结构, 降低普通用户的使用门槛。
  - 写作类(write)严禁编造数字: 所有定量结论必须来自上游本地计算出的事实。
"""
from __future__ import annotations

from .journals import get_journal


def _join(label: str, value: str) -> str:
    value = (value or "").strip()
    return f"{label}：{value}\n" if value else ""


def build_idea(inputs: dict) -> list[dict]:
    system = (
        "你是一位资深科研选题顾问，擅长发现研究空白与创新点。"
        "请基于用户的领域，给出 3-5 个具体、可操作的候选研究课题。"
        "每个课题用 `### 课题N：一句话题名` 作小标题，分点包含：① 拟解决的科学问题；② 创新点/与现有工作的差异；"
        "③ 可行性与所需条件；④ 潜在风险；"
        "⑤ 单列一行自评分，格式严格为 `> 可行性 ★N/5（一句话理由）｜创新性 ★N/5（一句话理由）`"
        "（N 为 1-5 整数，帮助非专业读者快速判断）。"
        "务必具体、贴近真实研究，避免空泛口号。最后给一句话推荐你认为最值得做的一个并说明理由。"
    )
    user = (
        _join("研究领域/方向", inputs.get("field", ""))
        + _join("关键词", inputs.get("keywords", ""))
        + _join("已有基础/限制条件", inputs.get("background", ""))
    )
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


def build_plan(inputs: dict) -> list[dict]:
    system = (
        "你是一位严谨的医学/药学/生物医学研究方法学专家。用户会给出一个研究想法，"
        "请输出一份符合生物医学研究规范、可执行的研究/实验方案，包含："
        "① 研究目标与科学假设（明确主要/次要结局指标）；"
        "② 研究设计类型（如随机对照试验、队列、病例对照、横断面、体外/动物实验等）及其理由；"
        "③ 研究对象与分组（入选/排除标准、对照设置、随机化与盲法是否适用及如何实施）；"
        "④ 样本量与检验效能估算（说明依据的效应量、α、power，给出可操作的估算思路）；"
        "⑤ 关键方法与操作流程（含主要变量、测量方法、质量控制）；"
        "⑥ 统计分析计划（按数据类型选择检验、是否需要多重比较校正、协变量调整等）；"
        "⑦ 伦理与合规（伦理审批/知情同意、生物安全、动物伦理等适用项）；"
        "⑧ 里程碑与时间表；⑨ 主要风险（如偏倚、混杂、脱落）与应对；⑩ 所需资源清单。"
        "表达清晰、分点、可落地；若信息不足请指出需要补充的关键设计参数。"
    )
    user = (
        _join("研究想法/课题", inputs.get("idea", ""))
        + _join("学科领域", inputs.get("field", ""))
        + _join("可用资源/条件", inputs.get("resources", ""))
    )
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


def build_sap(inputs: dict) -> list[dict]:
    system = (
        "你是临床试验/医学研究的统计分析计划(SAP)专家，熟悉 ICH E9(及 E9(R1) estimand 框架)"
        "与 SAP 报告规范(Gamble 2017, JAMA)。请基于用户的研究想法，产出一份结构化、可执行的"
        "【统计分析计划 SAP】，用中文 Markdown，按以下小节组织：\n"
        "① 研究设计概述与主要/次要终点（明确终点的类型与测量时点）；\n"
        "② estimand 与分析数据集定义（ITT/mITT/PP/安全集）及各自纳入规则；\n"
        "③ 主要终点分析（统计检验或模型、单/双侧、显著性水平 α、效应量与 95% 置信区间）；\n"
        "④ 次要与探索性终点分析；\n"
        "⑤ 预设的协变量调整与亚组分析（强调预设、避免事后数据挖掘）；\n"
        "⑥ 多重性控制（如 Holm/Hochberg/分层固定顺序检验，说明对哪些比较生效）；\n"
        "⑦ 缺失数据处理（缺失机制假设、主分析策略与敏感性分析如多重插补/tipping-point）；\n"
        "⑧ 敏感性分析与稳健性检查；\n"
        "⑨ 期中分析与提前终止规则（如适用，含 α 消耗）；\n"
        "⑩ 样本量/检验效能依据；⑪ 分析软件与版本、分析集冻结。\n"
        "铁律：信息不足处明确标注『需研究者确认』，不要臆造具体数值或结论；"
        "区分预设分析与探索性分析。"
    )
    user = (
        _join("研究想法/课题", inputs.get("idea", ""))
        + _join("学科领域", inputs.get("field", ""))
        + _join("可用资源/条件", inputs.get("resources", ""))
    )
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


_GUIDELINES = {
    "strobe": ("STROBE", "观察性研究（队列/病例对照/横断面），22 个条目"),
    "consort": ("CONSORT 2010", "随机对照试验（RCT），25 个条目"),
    "prisma": ("PRISMA 2020", "系统综述与 Meta 分析，27 个条目"),
    "spirit": ("SPIRIT 2013", "临床试验方案（protocol），33 个条目"),
    "arrive": ("ARRIVE 2.0", "动物实验研究，Essential 10 + Recommended Set"),
}


def build_checklist(inputs: dict) -> list[dict]:
    key = (inputs.get("guideline") or "strobe").strip().lower()
    name, scope = _GUIDELINES.get(key, _GUIDELINES["strobe"])
    system = (
        f"你是熟悉 EQUATOR Network 报告规范的资深医学编辑。请依据《{name}》报告清单（适用于：{scope}），"
        "逐条核对用户提供的稿件/方案是否满足每个条目。\n"
        "请按该清单的标准条目顺序，输出一个 Markdown 表格，列为：\n"
        "| 条目 | 规范要求 | 状态 | 正文位置/证据 | 修改建议 |\n"
        "状态只用三选一：✅已报告 / ⚠️不充分 / ❌缺失。\n"
        "表格之前，先给【高优先级待补项】：列出标为 ❌缺失 或 ⚠️不充分 的关键条目（尤其偏倚、样本量、"
        "缺失数据处理、敏感性分析、伦理与注册、利益冲突/数据可得性声明等最常被审稿人挑的项）。\n"
        "表格之后，给一句【总体合规度】小结（已报告/不充分/缺失 各几项）。\n"
        "铁律：只依据用户提供的稿件内容判断，不要臆造稿件中不存在的信息；"
        "无法判断的条目标⚠️并说明需作者确认。用中文。"
    )
    user = f"【报告规范】{name}\n\n【稿件/方案全文】\n{inputs.get('manuscript', '')}"
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


def build_dmp(inputs: dict) -> list[dict]:
    system = (
        "你是科研数据管理与合规专家。基于研究想法，生成一份【数据管理计划 (DMP)】，"
        "参考通用 DMP 框架(NIH / Horizon Europe / FAIR 原则)，用中文 Markdown 分节：\n"
        "① 数据类型与来源（将产生哪些数据、格式、量级）；② 采集与组织（命名规则、版本、元数据标准）；"
        "③ 存储与备份（位置、冗余、加密）；④ 安全与隐私（去标识化、访问控制、合规：IRB/《个人信息保护法》/GDPR）；"
        "⑤ 共享与获取（是否公开、数据仓库如 GEO/Zenodo、许可、使用限制）；⑥ 保存与归档（保存期限、长期归档）；"
        "⑦ 角色与责任。\n铁律：信息不足处标 [需研究者明确]，不要杜撰具体机构、编号或人员。"
    )
    user = (
        _join("研究想法/课题", inputs.get("idea", ""))
        + _join("学科领域", inputs.get("field", ""))
        + _join("可用资源/条件", inputs.get("resources", ""))
    )
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


def build_consent(inputs: dict) -> list[dict]:
    system = (
        "你是临床研究伦理与知情同意专家。基于研究想法，起草一份【知情同意书（草案）】，用中文 Markdown，包含："
        "研究标题与负责人[占位]、研究背景与目的、研究流程与受试者需配合的事项、预期持续时间与样本量、"
        "潜在风险与不适、潜在获益、替代方案、隐私与数据保密、自愿参加与随时退出的权利、费用与补偿、"
        "发生研究相关损害时的处理、联系方式[占位]、知情同意签字栏。\n"
        "铁律：风险/获益/流程按研究类型合理描述，但具体数值、机构、联系人、补偿金额一律用 [需研究者补充] 占位，"
        "绝不杜撰；开头注明『本草案需经伦理委员会(IRB/EC)审核批准后方可使用』。"
    )
    user = (
        _join("研究想法/课题", inputs.get("idea", ""))
        + _join("学科领域", inputs.get("field", ""))
        + _join("可用资源/条件", inputs.get("resources", ""))
    )
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


def build_write(inputs: dict) -> list[dict]:
    system = (
        "你是一位医学/药学/生物医学论文写作助手。下面给出的是【已由程序计算好的客观统计事实】。"
        "严格要求：所有数值、统计量、p 值都必须直接引用这些事实，"
        "绝对不要自己编造或心算任何数字；如某结论缺乏数据支撑，请明确说明‘数据不足’。"
        "请遵循生物医学报告规范：报告组间差异时尽量同时给出效应量与置信区间和精确 p 值（如 p=0.003 而非 p<0.05）；"
        "涉及多重比较时提示是否需要校正；区分‘相关’与‘因果’，不要过度宣称因果关系。"
        "请完成：① 用要点形式提炼 2-4 个核心科学发现/观点；"
        "② 撰写一段规范的【结果(Results)】文字（客观陈述数据，不作过度解读）；"
        "③ 撰写一段简短的【讨论(Discussion)】，解释发现的意义、与领域的关系及主要局限（样本量、偏倚、混杂等）。"
        "语言客观、学术、严谨。"
    )
    facts = inputs.get("facts", "").strip()
    question = inputs.get("question", "").strip()
    user = ""
    if question:
        user += f"研究问题：{question}\n\n"
    user += f"【已计算的统计事实】\n{facts}\n"
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


def build_format(inputs: dict) -> list[dict]:
    journal = get_journal(inputs.get("journal_id", ""))
    rules = journal["rules"] if journal else "通用学术论文格式。"
    name = journal["name"] if journal else "目标期刊"
    system = (
        f"你是一位熟悉学术期刊投稿规范的编辑。请把用户的稿件按《{name}》的要求重新组织排版。\n"
        f"该期刊的格式要求如下：\n{rules}\n\n"
        "硬性约束（最重要）：只对【已有内容】做结构、章节顺序、标题、引用风格层面的重排，"
        "绝对不要新增/代写原稿中不存在的内容——包括但不限于摘要、关键词、结论、数据、参考文献条目。"
        "若目标期刊要求的某部分（如摘要、关键词）原稿没有，不要替作者撰写，"
        "而是用占位标注，例如『【摘要：原稿缺失，需作者补充】』，并在变更说明里列为待补充项。\n"
        "请输出：① 重排后的稿件（按要求的章节顺序与标题；缺失部分用上述占位标注）；"
        "② 末尾附【格式变更说明】，列出你做了哪些调整、以及哪些原稿缺失需作者补充/确认的地方。"
    )
    user = f"以下是稿件内容：\n\n{inputs.get('manuscript', '')}"
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


def build_abstract(inputs: dict) -> list[dict]:
    structured = str(inputs.get("structured", "true")).lower() in ("true", "1", "yes")
    try:
        max_words = int(inputs.get("max_words") or 250)
    except (ValueError, TypeError):
        max_words = 250
    fmt = (
        "结构式摘要，分四个带小标题的段落：背景/目的(Background)、方法(Methods)、结果(Results)、结论(Conclusions)"
        if structured
        else "非结构式摘要（连贯单段）"
    )
    system = (
        "你是医学/药学/生物医学论文写作助手。请基于用户提供的要点撰写论文摘要。\n"
        f"格式：{fmt}。\n"
        f"字数硬约束：总字数不超过 {max_words} 字，务必精炼；若要点过多则保留最关键信息。\n"
        "铁律：只用用户提供的要点，结果段的数字必须来自要点，严禁编造数字/统计量/结论；"
        "要点缺失处用 [待补充] 标注。用中文。只输出摘要正文（结构式则保留小标题），不要额外说明。"
    )
    user = f"【目标字数】{max_words}\n\n【要点/材料】\n{inputs.get('points', '')}"
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


def build_pico(inputs: dict) -> list[dict]:
    system = (
        "你是循证医学方法学专家。基于用户的研究方向，提炼结构化 PICO 并给出建议的纳入/排除标准，"
        "便于系统综述/临床研究的选题与检索。用 Markdown 输出三部分：\n"
        "## PICO\n用表格，列为 | 要素 | 内容 |，依次给 P（研究对象/人群）、I（干预/暴露）、"
        "C（对照）、O（结局指标，分主要/次要）、（如适用）T（时间）与 S（研究设计）。\n"
        "## 建议纳入标准\n分点列出。\n## 建议排除标准\n分点列出。\n"
        "铁律：基于研究方向合理推断，信息不足处标注 [需研究者明确]，不要臆造具体数值。用中文。"
    )
    user = (
        _join("研究方向", inputs.get("field", ""))
        + _join("关键词", inputs.get("keywords", ""))
        + _join("已有基础/限制", inputs.get("background", ""))
    )
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


def build_keywords(inputs: dict) -> list[dict]:
    system = (
        "你是医学文献标引专家。基于用户提供的摘要/要点，推荐适合投稿与检索的关键词。"
        "请用 Markdown 输出两部分：\n"
        "## 关键词（Keywords）\n给出 5–8 个中英对照的自由关键词（每行：中文 / English）。\n"
        "## MeSH 主题词\n给出 4–8 个**规范的 MeSH 标准主题词（英文术语）**，尽量用 PubMed MeSH 树中确有的词，"
        "每个后用一句话标注其适用范围；不确定是否为标准 MeSH 词的，标注“（建议在 MeSH 数据库核对）”。\n"
        "铁律：只依据用户内容，不编造与主题无关的词；不要输出解释性前后缀。用中文。"
    )
    user = f"【摘要/要点】\n{inputs.get('points', '')[:4000]}"
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


def build_precheck(inputs: dict) -> list[dict]:
    journal = get_journal(inputs.get("journal_id", ""))
    name = journal["name"] if journal else "目标期刊"
    rules = journal["rules"] if journal else "通用学术论文格式。"
    system = (
        "你是熟悉投稿流程的学术编辑，为作者做【投稿前预提交体检】，目标是投稿前自查、避免被秒退。\n"
        f"目标期刊：《{name}》，其要求：\n{rules}\n\n"
        "请对照下面稿件逐项检查，输出一个 Markdown 表格：| 检查项 | 状态 | 说明/位置 | 修改建议 |。"
        "状态只用三选一：✅通过 / ⚠️注意 / ❌缺失。\n"
        "检查项至少覆盖：① 必需章节是否齐全（标题/摘要/关键词/引言/方法/结果/讨论/结论/参考文献）；"
        "② 结构与章节顺序是否符合该刊；③ 篇幅是否可能超限（给出正文与摘要的粗略字数统计）；"
        "④ 必备声明是否具备：伦理审批与知情同意、利益冲突(COI)、数据可得性声明、资助来源、作者贡献、(如适用)试验注册号；"
        "⑤ 参考文献是否完整、风格是否一致；⑥ 图表是否有标题且在正文被引用。\n"
        "表格前先列【必须修复(❌)】要点，表格后给一句总体结论。"
        "铁律：只依据稿件内容判断，不臆造；无法确定的标⚠️并提示作者确认。用中文。"
    )
    user = f"【稿件全文】\n{inputs.get('manuscript', '')}"
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


def build_coverletter(inputs: dict) -> list[dict]:
    journal = get_journal(inputs.get("journal_id", ""))
    name = journal["name"] if journal else "目标期刊"
    system = (
        f"你是资深通讯作者，正为向《{name}》投稿撰写投稿信(cover letter)。基于下面稿件，写一封专业、简洁"
        "（约 250–350 字）的中文投稿信，包含：\n"
        "① 称呼（Dear Editor / 尊敬的编辑）；② 一句话说明投稿稿件的标题与文章类型；"
        "③ 2–3 句概述研究做了什么、主要发现与创新点（只用稿件中确有的内容，绝不编造数字或结论）；"
        "④ 1–2 句说明为何契合该刊的读者与范围；"
        "⑤ 常规声明：本研究为原创、未一稿多投/未在他处发表、全体作者已审阅并同意投稿、无重大利益冲突"
        "（若稿件未提供相关信息，用 [占位：需作者确认] 标注，不要替作者断言）；"
        "⑥ 礼貌结语与落款占位（[通讯作者姓名]/[单位与通讯地址]/[邮箱]/[日期]）。\n"
        "铁律：不得编造稿件中不存在的结果、数据或作者信息；缺失信息一律用 [占位] 标注。用中文 Markdown。"
    )
    user = f"【稿件全文/摘要】\n{inputs.get('manuscript', '')}"
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


_BUILDERS = {
    "idea": build_idea,
    "plan": build_plan,
    "sap": build_sap,
    "dmp": build_dmp,
    "consent": build_consent,
    "checklist": build_checklist,
    "abstract": build_abstract,
    "keywords": build_keywords,
    "pico": build_pico,
    "precheck": build_precheck,
    "coverletter": build_coverletter,
    "write": build_write,
    "format": build_format,
}


# 每个模块"必填"的关键输入字段及其友好名: 缺失时直接报错, 不白白调用一次 LLM、也不产出令人困惑的空泛输出。
_REQUIRED = {
    "idea": ("field", "研究领域/方向"),
    "plan": ("idea", "研究想法/课题"),
    "sap": ("idea", "研究想法/课题"),
    "dmp": ("idea", "研究想法/课题"),
    "consent": ("idea", "研究想法/课题"),
    "checklist": ("manuscript", "稿件/方案全文"),
    "abstract": ("points", "要点/材料"),
    "keywords": ("points", "摘要/要点"),
    "pico": ("field", "研究方向"),
    "precheck": ("manuscript", "稿件全文"),
    "coverletter": ("manuscript", "稿件全文/摘要"),
    "write": ("facts", "统计事实/数据"),
    "format": ("manuscript", "稿件内容"),
}


def build_messages(module: str, inputs: dict) -> list[dict]:
    builder = _BUILDERS.get(module)
    if not builder:
        raise ValueError(f"未知模块: {module}")
    req = _REQUIRED.get(module)
    if req and not str(inputs.get(req[0]) or "").strip():
        raise ValueError(f"请先填写「{req[1]}」再生成。")
    return builder(inputs)

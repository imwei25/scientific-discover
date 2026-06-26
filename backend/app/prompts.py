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
        "每个课题包含：① 课题名称；② 拟解决的科学问题；③ 创新点/与现有工作的差异；"
        "④ 可行性与所需条件；⑤ 潜在风险。"
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


_BUILDERS = {
    "idea": build_idea,
    "plan": build_plan,
    "write": build_write,
    "format": build_format,
}


def build_messages(module: str, inputs: dict) -> list[dict]:
    builder = _BUILDERS.get(module)
    if not builder:
        raise ValueError(f"未知模块: {module}")
    return builder(inputs)

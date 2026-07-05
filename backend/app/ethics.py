"""伦理审查文书生成 (knowingly programmatic, 不读外部 .docx 模板)。

支持 4 种模板:
  - informed_consent     知情同意书
  - protocol             研究方案
  - crf                  病例报告表(CRF)
  - data_use_commitment  数据使用承诺

设计:
  - 模板用 python-docx 程序化生成: 结构稳定, 易维护, 占位符高亮明显;
  - 占位符约定: {字段名}, 调用时 fields={"研究名称": "...", ...} 替换;
  - 缺失字段保留 [占位] 标记, 而不是空白(让审查者一眼能看到要补充什么)。

接口:
  render(template: str, fields: dict) -> bytes  # 返回 .docx 字节流
  check_ethics_readiness(inputs: dict) -> dict  # 出稿前伦理硬校验
"""
from __future__ import annotations

import io
import re
from typing import Callable

from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.shared import Pt, RGBColor


# ---------- 共享样式工具 ----------

_PLACEHOLDER_COLOR = RGBColor(0xD9, 0x77, 0x06)  # 暖色琥珀(D6 设计变量), 让占位醒目


def _add_title(doc: Document, text: str) -> None:
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    r = p.add_run(text)
    r.bold = True
    r.font.size = Pt(18)


def _add_section(doc: Document, text: str) -> None:
    p = doc.add_paragraph()
    r = p.add_run(text)
    r.bold = True
    r.font.size = Pt(13)


def _add_para(doc: Document, *parts: str | tuple[str, str]) -> None:
    """段落写入: 字符串 = 普通文本; tuple("placeholder","key") = 占位高亮 [key]。"""
    p = doc.add_paragraph()
    for part in parts:
        if isinstance(part, tuple) and len(part) == 2 and part[0] == "placeholder":
            r = p.add_run(f"[{part[1]}]")
            r.font.color.rgb = _PLACEHOLDER_COLOR
            r.bold = True
        else:
            p.add_run(str(part))


def _fill(value: str | None, key: str) -> str | tuple[str, str]:
    """如果 value 非空返回值, 否则返回空串(前端已将必填改为可选, 未填项在 Word 中留空)。"""
    if value is None or str(value).strip() == "":
        return ""
    return str(value)


def _add_materials_section(doc: Document, materials: str | None) -> None:
    """将「附加材料」文本附加到文末, 供用户自行整理未填项对应内容。"""
    text = (materials or "").strip()
    if not text:
        return
    _add_section(doc, "附加材料")
    for para in text.split("\n\n"):
        para = para.strip("\n")
        if not para:
            continue
        for line in para.split("\n"):
            doc.add_paragraph(line)
        doc.add_paragraph()


# ---------- 4 个模板 ----------

def _render_informed_consent(doc: Document, f: dict) -> None:
    _add_title(doc, "知情同意书")
    doc.add_paragraph(
        "本草案需经伦理委员会(IRB/EC)审核批准后方可使用。"
    ).runs[0].italic = True

    _add_section(doc, "一、研究信息")
    _add_para(doc, "研究名称: ", _fill(f.get("研究名称"), "研究名称"))
    _add_para(doc, "研究者: ", _fill(f.get("研究者"), "研究者"))
    _add_para(doc, "所属机构: ", _fill(f.get("机构"), "机构"))
    _add_para(doc, "联系方式: ", _fill(f.get("联系方式"), "联系方式"))
    _add_para(doc, "日期: ", _fill(f.get("日期"), "日期"))

    _add_section(doc, "二、研究目的")
    _add_para(doc, _fill(f.get("研究目的"), "研究目的"))

    _add_section(doc, "三、研究流程")
    doc.add_paragraph(
        "您将被邀请参与本研究, 大致流程包括: 入组评估、按方案接受相应检测/干预、"
        "随访与数据采集。具体步骤会由研究人员当面说明。"
    )

    _add_section(doc, "四、潜在风险")
    _add_para(doc, _fill(f.get("风险"), "风险"))

    _add_section(doc, "五、可能的获益")
    _add_para(doc, _fill(f.get("受益"), "受益"))

    _add_section(doc, "六、自愿参加与退出")
    doc.add_paragraph(
        "您完全自愿参加本研究, 可在任何时间退出, 不影响您今后接受医疗服务的权利。"
    )

    _add_section(doc, "七、隐私与数据保密")
    doc.add_paragraph(
        "您的个人信息将被严格保密, 数据仅用于本研究目的。发表时不会暴露可识别的个人信息。"
    )

    _add_section(doc, "八、费用与补偿")
    doc.add_paragraph("研究相关检测/干预的费用承担与补偿安排, 请向研究者咨询。")

    _add_section(doc, "九、研究相关损害的处理")
    doc.add_paragraph("如发生与研究相关的健康损害, 研究方将按伦理委员会批准的方案给予处理。")

    _add_section(doc, "十、签字栏")
    doc.add_paragraph("受试者签字: _______________   日期: _______________")
    doc.add_paragraph("法定代理人签字(如适用): _______________   日期: _______________")
    doc.add_paragraph("研究者签字: _______________   日期: _______________")


def _render_protocol(doc: Document, f: dict) -> None:
    _add_title(doc, "研究方案")

    _add_section(doc, "1. 研究基本信息")
    _add_para(doc, "研究名称: ", _fill(f.get("研究名称"), "研究名称"))
    _add_para(doc, "主要研究者(PI): ", _fill(f.get("研究者"), "研究者"))
    _add_para(doc, "承担机构: ", _fill(f.get("机构"), "机构"))
    _add_para(doc, "联系方式: ", _fill(f.get("联系方式"), "联系方式"))
    _add_para(doc, "起止日期: ", _fill(f.get("日期"), "日期"))

    _add_section(doc, "2. 研究背景与目的")
    _add_para(doc, _fill(f.get("研究目的"), "研究目的"))

    _add_section(doc, "3. 研究设计")
    _add_para(doc, _fill(f.get("研究设计"), "研究设计"))

    _add_section(doc, "4. 入选与排除标准")
    _add_para(doc, "入选标准: ", _fill(f.get("入选标准"), "入选标准"))
    _add_para(doc, "排除标准: ", _fill(f.get("排除标准"), "排除标准"))

    _add_section(doc, "5. 样本量")
    _add_para(doc, _fill(f.get("样本量"), "样本量"))

    _add_section(doc, "6. 主要/次要终点")
    _add_para(doc, "主要终点: ", _fill(f.get("主要终点"), "主要终点"))
    _add_para(doc, "次要终点: ", _fill(f.get("次要终点"), "次要终点"))

    _add_section(doc, "7. 干预/操作流程")
    _add_para(doc, _fill(f.get("干预措施"), "干预措施"))

    _add_section(doc, "8. 统计分析计划")
    _add_para(doc, _fill(f.get("统计分析"), "统计分析"))

    _add_section(doc, "9. 风险与获益评估")
    _add_para(doc, "风险: ", _fill(f.get("风险"), "风险"))
    _add_para(doc, "受益: ", _fill(f.get("受益"), "受益"))

    _add_section(doc, "10. 伦理与知情同意")
    doc.add_paragraph(
        "本研究将提交所在机构伦理委员会审查, 所有受试者签署知情同意书后方可入组。"
    )

    _add_section(doc, "11. 数据管理与保密")
    doc.add_paragraph("所有数据将去标识化处理, 严格保密, 仅本研究使用。")


def _render_crf(doc: Document, f: dict) -> None:
    _add_title(doc, "病例报告表 (CRF)")

    _add_para(doc, "研究名称: ", _fill(f.get("研究名称"), "研究名称"))
    _add_para(doc, "受试者编号: ____________   入组日期: ____________")
    doc.add_paragraph()

    _add_section(doc, "一、基本信息")
    table = doc.add_table(rows=4, cols=2)
    table.style = "Light Grid Accent 1"
    cells = [
        ("性别", "□ 男  □ 女"),
        ("出生年份", "______"),
        ("身高 (cm)", "______"),
        ("体重 (kg)", "______"),
    ]
    for i, (k, v) in enumerate(cells):
        table.rows[i].cells[0].text = k
        table.rows[i].cells[1].text = v

    _add_section(doc, "二、入选与排除评估")
    _add_para(doc, "入选标准全部满足: □ 是  □ 否")
    _add_para(doc, "排除标准均不满足: □ 是  □ 否")

    _add_section(doc, "三、基线评估")
    doc.add_paragraph("(由研究人员根据方案要求填写)")
    doc.add_paragraph("__________________________________________________")
    doc.add_paragraph("__________________________________________________")

    _add_section(doc, "四、干预/治疗记录")
    _add_para(doc, "干预类型: ", _fill(f.get("干预措施"), "干预措施"))
    doc.add_paragraph("开始日期: ____________   结束日期: ____________")

    _add_section(doc, "五、终点指标")
    _add_para(doc, "主要终点: ", _fill(f.get("主要终点"), "主要终点"))
    _add_para(doc, "次要终点: ", _fill(f.get("次要终点"), "次要终点"))

    _add_section(doc, "六、不良事件 (AE) 记录")
    doc.add_paragraph("□ 无  □ 有(请详述, 含严重程度、持续时间、与研究的相关性)")
    doc.add_paragraph("__________________________________________________")

    _add_section(doc, "七、研究者签字")
    doc.add_paragraph("研究者: _______________   日期: _______________")


def _render_data_use_commitment(doc: Document, f: dict) -> None:
    _add_title(doc, "数据使用承诺书")

    doc.add_paragraph(
        "本承诺书由研究项目主要研究者出具, 用于声明对研究数据使用、存储、共享与"
        "保密的承诺, 提交伦理委员会备案。"
    )

    _add_section(doc, "一、项目信息")
    _add_para(doc, "研究名称: ", _fill(f.get("研究名称"), "研究名称"))
    _add_para(doc, "主要研究者: ", _fill(f.get("研究者"), "研究者"))
    _add_para(doc, "承担机构: ", _fill(f.get("机构"), "机构"))
    _add_para(doc, "联系方式: ", _fill(f.get("联系方式"), "联系方式"))

    _add_section(doc, "二、数据来源与范围")
    _add_para(doc, _fill(f.get("数据来源"), "数据来源"))

    _add_section(doc, "三、使用承诺")
    doc.add_paragraph("本人/本团队承诺:")
    doc.add_paragraph("1. 仅将所获数据用于上述研究目的, 不用于其他任何用途;")
    doc.add_paragraph("2. 对涉及个人隐私的数据进行去标识化处理, 严格保密;")
    doc.add_paragraph("3. 数据存储在受控环境, 访问权限仅授予研究授权人员;")
    doc.add_paragraph("4. 不擅自向第三方提供原始数据; 如需共享, 须报伦理委员会批准;")
    doc.add_paragraph("5. 研究结束后按规定保存数据, 保存期限到期后按规定销毁。")

    _add_section(doc, "四、保存与销毁")
    _add_para(doc, "保存期限: ", _fill(f.get("保存期限"), "保存期限"))
    _add_para(doc, "存储位置: ", _fill(f.get("存储位置"), "存储位置"))

    _add_section(doc, "五、签字")
    doc.add_paragraph("承诺人(研究者): _______________   日期: ", )
    _add_para(doc, "日期: ", _fill(f.get("日期"), "日期"))
    doc.add_paragraph("机构盖章: _______________")


# ---------- 调度 ----------

_TEMPLATES: dict[str, Callable[[Document, dict], None]] = {
    "informed_consent": _render_informed_consent,
    "protocol": _render_protocol,
    "crf": _render_crf,
    "data_use_commitment": _render_data_use_commitment,
}


def list_templates() -> list[str]:
    return list(_TEMPLATES.keys())


# ---------- 出稿前伦理硬校验 ----------

# 未成年人 / 弱势群体 / 精神障碍 等关键词, 命中即触发"须提交对应保护措施"检查
_VULNERABLE_KEYWORDS = (
    "未成年", "未成年人", "儿童", "小儿", "婴儿", "青少年",
    "精神障碍", "认知障碍", "痴呆", "阿尔茨海默",
    "孕妇", "妊娠", "哺乳期",
    "囚犯", "在押人员",
    "老年痴呆", "植物人", "昏迷",
)

# 弱势群体保护措施相关关键词, 只要材料/字段中出现任意一个即视为已考虑
_VULNERABLE_SAFEGUARD_KEYWORDS = (
    "法定代理人", "监护人", "监护", "代签", "代理签署",
    "特殊人群保护", "弱势群体保护", "额外保护措施",
    "简易语言", "分级同意", "assent",
)

# 知情同意勾选字段的候选键名, 兼容前端可能的多种命名
_CONSENT_KEYS = (
    "已获知情同意", "知情同意", "informed_consent_obtained",
    "informed_consent", "consent_obtained", "consent",
)

# 伦理审批编号字段候选
_IRB_KEYS = (
    "伦理编号", "伦理审批编号", "伦理批号", "IRB编号", "IRB_number",
    "irb_number", "ethics_number", "ethics_approval_no",
)

# 样本量字段候选
_SAMPLE_SIZE_KEYS = (
    "样本量", "样本量估算", "sample_size", "n_total",
)


def _flatten_text(inputs: dict) -> str:
    """把 fields + materials 拼成一段大文本, 用关键词粗筛。"""
    parts: list[str] = []
    fields = inputs.get("fields") or {}
    if isinstance(fields, dict):
        for v in fields.values():
            if v is None:
                continue
            parts.append(str(v))
    materials = inputs.get("materials") or ""
    if materials:
        parts.append(str(materials))
    return "\n".join(parts)


def _get_field(fields: dict, keys: tuple[str, ...]) -> str | None:
    for k in keys:
        if k in fields and fields[k] not in (None, ""):
            return str(fields[k]).strip()
    return None


def _parse_int(s: str | None) -> int | None:
    if not s:
        return None
    m = re.search(r"-?\d+", s)
    if not m:
        return None
    try:
        return int(m.group(0))
    except ValueError:
        return None


def check_ethics_readiness(inputs: dict) -> dict:
    """出稿前的伦理硬校验层。

    inputs 结构 (与 /api/ethics/render 请求体一致):
      {
        "template": "informed_consent" | ... ,
        "fields": {...},
        "materials": "..."
      }

    返回:
      {
        "ok": bool,                 # False 表示存在 red_flags
        "red_flags": [str, ...],    # 严重问题, 必须解决否则不给出稿
        "warnings": [str, ...],     # 建议改进但不阻断
      }
    """
    fields = inputs.get("fields") if isinstance(inputs.get("fields"), dict) else {}
    materials = str(inputs.get("materials") or "")
    text_all = _flatten_text(inputs)

    red_flags: list[str] = []
    warnings: list[str] = []

    # 1. 样本量: <=0 或缺失 -> red flag
    sample_raw = _get_field(fields, _SAMPLE_SIZE_KEYS)
    # materials 中也可能写 "样本量: 120"
    if not sample_raw:
        m = re.search(r"样本量[::\s]*([0-9]+)", materials)
        if m:
            sample_raw = m.group(1)
    sample_n = _parse_int(sample_raw)
    if sample_raw is None:
        red_flags.append("样本量缺失: 请在字段或附加材料中给出明确的样本量估算 (含 α、power、效应量依据)。")
    elif sample_n is not None and sample_n <= 0:
        red_flags.append(f"样本量非法 (={sample_n}): 必须为正整数, 请重新估算。")

    # 2. 伦理审批编号缺失 -> red flag
    irb_raw = _get_field(fields, _IRB_KEYS)
    if not irb_raw:
        # 允许在 materials 里以自然语句形式出现
        if not re.search(r"(伦理\s*(审批)?\s*(编号|批号|号)|IRB\s*[No\.#:]?|批件号)", text_all, re.IGNORECASE):
            red_flags.append("伦理审批编号缺失: 请填写机构伦理委员会 (IRB/EC) 批件号, 未获批不得启动研究。")

    # 3. 未勾选"已获知情同意" -> red flag
    consent_raw = _get_field(fields, _CONSENT_KEYS)
    consent_ok = False
    if consent_raw is not None:
        cs = consent_raw.strip().lower()
        if cs in ("true", "1", "yes", "y", "是", "已获", "已获得", "已勾选", "✓", "√", "on"):
            consent_ok = True
        elif cs in ("false", "0", "no", "n", "否", "未获", "未勾选", "off"):
            consent_ok = False
        else:
            # 视作已填写的自由文本描述, 但仍要含正向表述
            consent_ok = bool(re.search(r"(已\s*(获|签署|取得)|签署.*同意|获得知情同意)", consent_raw))
    else:
        # 从 materials/其它字段扫描是否描述了知情同意流程
        if re.search(r"(已\s*(获|签署|取得).*(知情)?同意|签署.*知情同意书|获得.*知情同意)", text_all):
            consent_ok = True
    if not consent_ok:
        red_flags.append("未确认'已获知情同意': 请勾选或在附加材料中明确说明知情同意的获取流程与证据。")

    # 4. 涉及特殊人群但未提交对应保护措施 -> red flag
    hit_vuln = [kw for kw in _VULNERABLE_KEYWORDS if kw in text_all]
    if hit_vuln:
        has_safeguard = any(kw in text_all for kw in _VULNERABLE_SAFEGUARD_KEYWORDS)
        if not has_safeguard:
            red_flags.append(
                "涉及特殊人群 (" + "、".join(sorted(set(hit_vuln))[:4]) +
                ") 但未见针对性的保护措施: 需补充法定代理人/监护人同意流程、"
                "分级/简化同意 (assent) 或额外保护措施, 才能提交伦理。"
            )

    # 5. warnings: 数据保存期限 / DMP 未附 / 联系方式 / 主要研究者
    if not re.search(r"(保存期限|保留期限|存档期|retention)", text_all, re.IGNORECASE):
        warnings.append("未见明确的数据保存期限, 建议在数据管理段补充 (依据法规与机构要求)。")
    if not re.search(r"(数据管理计划|DMP|Data\s+Management\s+Plan)", text_all, re.IGNORECASE):
        warnings.append("未附数据管理计划 (DMP), 建议单独提交或在方案中并入。")
    if not _get_field(fields, ("联系方式", "contact", "phone", "email")) \
            and not re.search(r"(联系方式|联系电话|电话|邮箱|@)", text_all):
        warnings.append("未见受试者咨询/投诉联系方式, 建议补充电话或邮箱。")
    if not _get_field(fields, ("研究者", "主要研究者", "PI", "pi")):
        if not re.search(r"(主要研究者|PI\b)", text_all):
            warnings.append("未填写主要研究者 (PI), 建议补齐姓名与职称以便伦理归档。")

    return {
        "ok": len(red_flags) == 0,
        "red_flags": red_flags,
        "warnings": warnings,
    }


def render(template: str, fields: dict | None = None, materials: str | None = None) -> bytes:
    """根据模板与字段渲染 .docx 字节流。

    template ∈ {'informed_consent','protocol','crf','data_use_commitment'}
    fields 缺失项在正文中留空,建议由用户在 Word 中人工补写。
    materials(可选)会作为「附加材料」段附在文末,供审查时参考。
    """
    builder = _TEMPLATES.get(template)
    if not builder:
        raise ValueError(f"未知伦理材料模板: {template}")
    doc = Document()
    # 全局默认字体(中英文)
    style = doc.styles["Normal"]
    style.font.name = "Microsoft YaHei"
    style.font.size = Pt(11)

    builder(doc, fields or {})
    _add_materials_section(doc, materials)

    buf = io.BytesIO()
    doc.save(buf)
    return buf.getvalue()

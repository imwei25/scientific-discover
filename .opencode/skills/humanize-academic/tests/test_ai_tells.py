#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""ai_tells.py 回归测试。

用例直接照抄 2026-08 那份外部 AI 检测评价点名的六类证据造样本——
每个检测项都要能在"照着评价复刻出来的稿子"上打响，并且在正当学术写法上闭嘴。
后一半（不许误报）比前一半重要：假阳性会让改写去删本该保留的表达。

跑：  python tests/test_ai_tells.py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import ai_tells as T  # noqa: E402

FAILED = []


def check(name, cond, detail=""):
    print(("  PASS  " if cond else "  FAIL  ") + name + (("  — " + detail) if detail and not cond else ""))
    if not cond:
        FAILED.append(name)


def m(R, key):
    return R["findings"][key]["metric"]


# ── 依据 B：段末句式高度重复 + 每段必升华 ──────────────────────
# 评价原文：「"这一发现提示/表明，……"出现 8 次以上」「几乎每个段落都以"引文+一句推论"收尾」
B_BAD = "\n\n".join(
    f"研究{i}纳入了相应队列并报告了对应的检出率差异[{i}]。"
    f"该队列的样本量与随访时长均符合既定标准[{i}]。"
    f"这一发现提示，该指标在低级别肿瘤中的表现仍需谨慎解读[{i}]。"
    for i in range(1, 9)
)
# 正当写法：同样是 8 段，但收尾各不相同、并非段段升华
B_OK = "\n\n".join([
    "研究1纳入312例患者，检出率为62.3%[1]。对照组同期检出率为41.7%[2]。",
    "在随访满24个月的亚组中，复发率降至18%[3]。",
    "该平台的批间变异系数为4.1%，低于厂商声明的上限[4]。",
    "上尿路病例的取材量普遍偏低，约三成标本细胞数不足[5]。",
    "两个中心的判读标准存在差异，阈值分别设为4个细胞与5个细胞[6]。",
    "成本方面，单次检测的物料费约为230元[7]。",
    "现有数据尚不足以支持将其纳入常规随访方案[8]。",
    "本文其余部分聚焦于两种技术在同一队列中的直接比较[9]。",
])


def test_B():
    bad, ok = T.detect(B_BAD), T.detect(B_OK)
    check("B 段末引导语雷同：复刻稿打响", m(bad, "tail_lead_repeat") >= 5,
          f"实测 {m(bad, 'tail_lead_repeat')}")
    check("B 段末引导语雷同：正当稿不误报", m(ok, "tail_lead_repeat") < 3,
          f"实测 {m(ok, 'tail_lead_repeat')}")
    check("B 每段必升华：复刻稿打响", m(bad, "uplift_ending") >= 0.6,
          f"实测 {m(bad, 'uplift_ending')}")
    check("B 每段必升华：正当稿不误报", m(ok, "uplift_ending") < 0.4,
          f"实测 {m(ok, 'uplift_ending')}")


# ── 依据 D：句长均匀（low burstiness）────────────────────────
D_BAD = "\n\n".join(
    "该技术在临床应用中展现出较为稳定的检测效能表现。"
    "其操作流程需要专业人员完成规范化的判读工作。"
    "不同中心之间的一致性水平仍有待进一步提升。"
    "现有证据支持其作为辅助诊断手段的应用价值。"
    for _ in range(4)
)
D_OK = "\n\n".join([
    "检出率62.3%。这一数字来自一项纳入312例连续入组患者、随访满两年的前瞻性队列，"
    "其中低级别病例占41%，判读由两名细胞遗传学技师独立完成、分歧由第三人仲裁[1]。"
    "结果并不乐观。",
    "成本是另一回事。单次物料费约230元，但加上人力与设备折旧，实际单次成本可达700元以上，"
    "这在基层几乎不可行[2]。",
])


def test_D():
    bad, ok = T.detect(D_BAD), T.detect(D_OK)
    check("D 句长突发性：复刻稿打响（CV 低）", m(bad, "burstiness") <= 0.32,
          f"实测 {m(bad, 'burstiness')}")
    check("D 句长突发性：长短交错稿不误报", m(ok, "burstiness") > 0.42,
          f"实测 {m(ok, 'burstiness')}")


# ── 依据 E：条目化对仗收尾 ──────────────────────────────────
E_BAD = (
    "未来工作应从以下方面推进。第一，建立统一的判读标准并开展室间质评[1]。"
    "第二，扩大多中心前瞻性队列的样本量[2]。第三，推动检测成本的进一步下降[3]。"
    "第四，加强基层人员的规范化培训[4]。第五，完善配套的医保支付政策[5]。\n\n"
    "质量控制应涵盖：①标本采集与固定；②探针批次验证；③阴阳性对照的同步检测；"
    "④判读结果的双人复核。\n\n"
    "此外，还需注意标本运输时限对结果的影响[6]。"
)
# 正当写法：中文学术里「首先/其次/最后」三连非常常见，不该被判 AI 腔
E_OK = (
    "FISH在低级别肿瘤中的敏感性受限有三个原因。首先，其检测靶标在低级别肿瘤中的发生率本就较低[1]。"
    "其次，判读依赖经验，不同实验室阈值不一[2]。最后，标本细胞量不足会直接降低检出率[3]。"
)


def test_E():
    bad, ok = T.detect(E_BAD), T.detect(E_OK)
    check("E 对仗枚举：第一…第五 + ①②③④ 打响", m(bad, "enumeration") >= 2,
          f"实测 {m(bad, 'enumeration')}")
    check("E 对仗枚举：首先/其次/最后 三连不误报", m(ok, "enumeration") == 0,
          f"实测 {m(ok, 'enumeration')}")


# ── 依据 F：异文字混入 / 中英夹生残留 ────────────────────────
# 评价原文点名：西里尔"и"、"underlying的染色体重排性质"、"clinicallyrelevantSVs"、"国际cohorts"
F_BAD = (
    "质量监控环节应同时设置已知阳性и阴性标本作为对照，并记录每批次的信号强度[1]。\n\n"
    "该方法难以识别underlying的染色体重排性质，也无法区分apparent孤立缺失与复杂事件[2]。\n\n"
    "该平台报告的clinicallyrelevantSVs比例为12.4%，与国际cohorts的结果基本一致[3]。"
)
F_OK = (
    "UroVysion FISH通过检测CEP3、CEP7与9p21位点的异常进行分子诊断，已获FDA批准[1]。\n\n"
    "cfDNA与microRNA标志物在同一队列中的表现见Bladder EpiCheck的验证研究[2]。\n\n"
    "统计学显著性水平设为α=0.05，效应量以Cohen's d表示，组间差异采用β校正[3]。"
)


def test_F():
    bad = T.detect(F_BAD)
    ok = T.detect(F_OK, terms=["UroVysion", "EpiCheck", "cfDNA", "microRNA"])
    f = bad["findings"]["charset"]
    kinds = {i["kind"] for i in f["foreign_chars"]}
    words = {i["word"] for i in f["mixed_words"]}
    glued = {i["word"] for i in f["glued_words"]}
    check("F 西里尔字母 и 被抓到", "西里尔字母" in kinds, str(kinds))
    check("F underlying的 / apparent孤立 被抓到",
          "underlying" in words and "apparent" in words, str(words))
    check("F cohorts（中文后接小写英文）被抓到", "cohorts" in words, str(words))
    check("F clinicallyrelevantSVs 粘连被抓到", "clinicallyrelevantSVs" in glued, str(glued))
    check("F 正当术语（cfDNA/microRNA/α/β/EpiCheck）零误报", m(ok, "charset") == 0,
          str(ok["findings"]["charset"]))


# ── 依据 C：类比外推填充（上报项，不参与判级）────────────────
C_BAD = (
    "南非豪登省的一项研究显示当地实验室间存在显著差异[1]。将这一逻辑延伸至我国国内，"
    "南北方实验室之间同样可能存在类似的一致性问题。\n\n"
    "泰国的单中心经验提示培训体系是关键变量[2]。将此逻辑应用于我国南北方差异分析，"
    "可以合理推测东部地区的规范化程度更高。"
)


def test_C():
    bad = T.detect(C_BAD)
    check("C 类比外推被标为上报项", m(bad, "extrapolation") >= 3,
          f"实测 {m(bad, 'extrapolation')}")
    check("C 上报项不参与判级（不影响总判）",
          bad["findings"]["extrapolation"].get("report_only") is True)


# ── 依据 G：引文装饰性（上报项）──────────────────────────────
def test_G():
    bad = T.detect(B_BAD)   # 每句尾都挂 [n]
    check("G 句末挂引文比例被测出", m(bad, "citation_decor") >= 0.9,
          f"实测 {m(bad, 'citation_decor')}")
    check("G 整段每句都挂引文的段落被点名",
          bad["findings"]["citation_decor"]["fully_cited_paragraphs"] >= 8)
    check("G 上报项不参与判级",
          bad["findings"]["citation_decor"].get("report_only") is True)


# ── 闸模式：润色自己引入同构收尾要被拦下 ─────────────────────
def test_gate():
    before, after = T.detect(B_OK), T.detect(B_BAD)     # 改写把稿子改成了同构收尾
    _txt, badlist = T.compare(before, after)
    check("闸模式：改写引入同构收尾 → FAIL", len(badlist) >= 1, str(badlist))
    _txt2, badlist2 = T.compare(T.detect(B_BAD), T.detect(B_OK))   # 反向：确实改好了
    check("闸模式：真改好了 → PASS", badlist2 == [], str(badlist2))
    _txt3, badlist3 = T.compare(T.detect(B_OK), T.detect(B_OK))    # 没动
    check("闸模式：同一份稿子自比 → PASS", badlist3 == [], str(badlist3))


# ── 输入格式：docx_extract.py 的段落清单要能直接吃 ───────────
def test_para_format():
    txt = "\n".join(f"[[p{i:04d}]] 研究{i}报告了相应结果[{i}]。这一发现提示，该指标仍需验证[{i}]。"
                    for i in range(1, 7))
    R = T.detect(txt)
    check("段落清单格式被识别（[[pNNNN]]）", R["stats"]["paragraphs"] == 6,
          str(R["stats"]))
    check("段落清单里的段落用 pNNNN 定位",
          R["findings"]["uplift_ending"]["at"][:1] == ["p0001"],
          str(R["findings"]["uplift_ending"]["at"][:3]))


# ── 假阳性回归：这两个坑是在真稿上实测踩出来的，别再犯 ────────
def test_reflow_join_no_false_glue():
    """PDF 硬换行把 "Cancer Genomics / Consortium" 断成两行，
    拼接时不补空格就会造出 GenomicsConsortium，被"粘连缺空格"闸误判成硬伤。"""
    pdf_text = (
        "本节讨论室间质评的国际经验与我国现状，重点比较不同体系下的一致性水平。\n"
        "FISH 仍被公认为检测遗传异常的金标准临床检测方法，但Cancer Genomics\n"
        "Consortium 的调查显示，不同实验室在判读阈值上存在明显差异[1]。\n"
        "在多发性骨髓瘤领域，Cancer\n"
        "Genomics Consortium 浆细胞肿瘤工作组基于102 例样本提出了推荐方案[2]。\n"
    )
    R = T.detect(pdf_text, reflow=True)
    glued = {i["word"] for i in R["findings"]["charset"]["glued_words"]}
    check("reflow 跨行拼接不造假粘连", glued == set(), str(glued))
    # 真粘连仍要抓到（原文里就连在一起，不是断行造成的）
    R2 = T.detect("商业化探针标记的SpectrumOrange 荧光信号在20 年内保持稳定，未见明显衰减[1]。\n",
                  reflow=True)
    check("真粘连 SpectrumOrange 仍抓得到",
          "SpectrumOrange" in {i["word"] for i in R2["findings"]["charset"]["glued_words"]},
          str(R2["findings"]["charset"]))


def test_u037e_is_note_not_finding():
    """U+037E 与半角分号**规范等价**（NFC 后就是 ;）。从 PDF 抽文本时会整篇冒出来，
    源文其实是正常分号——实测两份 pandoc→LaTeX 出的 PDF 都这样。所以只作提示、不判硬伤。"""
    txt = ("FISH 用于检测t(8;21)、inv(16)和del(17p) 等常见异常，"
           "在急性髓系白血病的分型中具有明确价值[1]。\n")
    R = T.detect(txt)
    f = R["findings"]["charset"]
    check("U+037E 不计入硬伤", m(R, "charset") == 0, str(f))
    check("U+037E 记为提示", f.get("notes_total", 0) >= 1, str(f))
    check("NFC(U+037E) 确实是半角分号",
          __import__("unicodedata").normalize("NFC", ";") == ";")
    # 真正没有正当用途的异文字（西里尔）仍然判硬伤
    R2 = T.detect("验证应使用已知阳性и阴性标本，并记录详细的性能参数[1]。\n")
    check("西里尔字母仍判硬伤", m(R2, "charset") >= 1, str(R2["findings"]["charset"]))


if __name__ == "__main__":
    for fn in (test_B, test_D, test_E, test_F, test_C, test_G, test_gate, test_para_format,
               test_reflow_join_no_false_glue, test_u037e_is_note_not_finding):
        print(f"\n── {fn.__name__} ──")
        fn()
    print()
    if FAILED:
        print(f"✗ {len(FAILED)} 项失败：" + "、".join(FAILED))
        sys.exit(1)
    print("✓ 全部通过")

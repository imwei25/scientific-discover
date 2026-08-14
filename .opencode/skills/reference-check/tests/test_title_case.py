#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""标题比对的大小写回归测试（纯离线，不联网）。

盯的是这类假阳性：**引用完全正确、只是大小写写法不同，却被判 MISMATCH(红) / CHECK(黄)**。
参考文献的大小写风格本来就五花八门——EndNote 导出常是全大写、多数期刊用句首大写、
有些用 Title Case——这些差异一律不该影响真实性判定。
同时保留负例，证明闸没被放松成"谁都过"。

跑法（项目根 .venv）：
    .venv/Scripts/python.exe .opencode/skills/reference-check/tests/test_title_case.py   # Windows
    .venv/bin/python .opencode/skills/reference-check/tests/test_title_case.py           # Linux/macOS
也可以 `python -m unittest discover -s .opencode/skills/reference-check/tests`。
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import verify_refs as V  # noqa: E402

# 库里的真标题（句首大写，Crossref/EPMC 的常见形态）
REAL = "Global cancer statistics 2020: GLOBOCAN estimates of incidence and mortality"


def verdict(claimed, found=REAL):
    """只取判定，忽略相似度与 note。"""
    return V._decide_title(claimed, found, "DOI")[0]


class TitleCaseInsensitive(unittest.TestCase):
    """同一篇文献、不同大小写写法 → 必须都判 OK。"""

    def test_all_caps(self):
        # EndNote / 部分中文期刊的英文参考文献导出成全大写
        self.assertEqual(verdict(REAL.upper()), "OK")

    def test_title_case_vs_sentence_case(self):
        # Title Case（每个词首字母大写）vs 库里的句首大写
        self.assertEqual(
            verdict("Global Cancer Statistics 2020: GLOBOCAN Estimates Of Incidence And Mortality"),
            "OK")

    def test_all_lower(self):
        self.assertEqual(verdict(REAL.lower()), "OK")

    def test_case_plus_messy_whitespace(self):
        # 大小写 + 多余空白/换行混在一起（从 PDF 里拷参考文献的典型样子）
        self.assertEqual(
            verdict("  GLOBAL   cancer\tStatistics 2020 :  globocan  ESTIMATES\n"
                    "of Incidence and MORTALITY  "),
            "OK")

    def test_full_citation_line_all_caps(self):
        # .txt 输入：整行完整著录且全大写，标题应仍被认出吻合
        line = ("[1] SUNG H, FERLAY J, SIEGEL RL, ET AL. "
                "GLOBAL CANCER STATISTICS 2020: GLOBOCAN ESTIMATES OF INCIDENCE AND MORTALITY. "
                "CA CANCER J CLIN. 2021;71(3):209-249. DOI:10.3322/CAAC.21660")
        self.assertEqual(verdict(line), "OK")

    def test_casefold_not_lower(self):
        """casefold 而非 lower：德语全大写按排印惯例把 ß 写成 SS。

        lower() 下 'GROSSE GEFÄSSE' vs 'Große Gefäße' 归一成
        'grosse gef sse' vs 'gro e gef e'，相似度 0.80 → 被判 CHECK（假黄）。
        """
        self.assertEqual(verdict("GROSSE GEFÄSSE", "Große Gefäße"), "OK")

    def test_norm_and_sim_are_case_blind(self):
        self.assertEqual(V.norm_title(REAL.upper()), V.norm_title(REAL.lower()))
        self.assertEqual(V.title_sim(REAL.upper(), REAL), 1.0)
        self.assertEqual(V.compare_titles(REAL.upper(), REAL), (1.0, True))

    def test_cjk_case_mixed_title(self):
        # 中英混排的中文刊标题，英文部分大小写不同 → 仍吻合
        zh = "COVID-19 相关急性呼吸窘迫综合征的临床特征"
        self.assertEqual(verdict("covid-19 相关急性呼吸窘迫综合征的临床特征", zh), "OK")


class GateStillCatchesRealMismatch(unittest.TestCase):
    """负例：别把闸放松成谁都过。"""

    def test_different_title_still_mismatch(self):
        # 真 DOI 配错标题（张冠李戴）—— 即使两边大小写一致也必须报 MISMATCH
        self.assertEqual(verdict("Radial neuropathy after humeral shaft fracture: a case series"),
                         "MISMATCH")

    def test_different_title_all_caps_still_mismatch(self):
        # 把上面那条改成全大写，不能因为"忽略大小写"就蒙混过关
        self.assertEqual(verdict("RADIAL NEUROPATHY AFTER HUMERAL SHAFT FRACTURE: A CASE SERIES"),
                         "MISMATCH")

    def test_two_different_chinese_titles_not_ok(self):
        self.assertNotEqual(
            verdict("桡神经损伤的手术治疗", "肝细胞癌免疫治疗的研究进展"), "OK")

    def test_no_claimed_title_stays_unverified(self):
        # 只喂裸标识符时绝不能判 OK（否则等于把整道闸关掉）
        self.assertEqual(verdict(""), "UNVERIFIED")

    def test_partial_overlap_still_needs_human(self):
        # 相似度落在 0.6~0.85 之间 → CHECK，人工看；不因大小写归一而升成 OK
        self.assertEqual(
            verdict("Global cancer statistics 2012: estimates of incidence and prevalence"),
            "CHECK")


class AuthorCaseInsensitive(unittest.TestCase):
    """首作者姓的比对同样只该看字母，不该看大小写。"""

    @staticmethod
    def flags(claimed_authors, found_authors, year=None, found_year=None):
        return V._author_year_flags(
            {"claimed_authors": claimed_authors, "claimed_year": year},
            {"authors": found_authors, "year": found_year})

    def test_all_caps_author_field(self):
        self.assertEqual(self.flags("GROSS, PETER and MEIER, HANS", "Gross P, Meier H, et al"), "")

    def test_vancouver_all_caps(self):
        self.assertEqual(self.flags("FINN RS, QIN S, IKEDA M, ET AL", "Finn RS, Qin S, Ikeda M"), "")

    def test_sharp_s_surname(self):
        # 著录写 WEISS（全大写把 ß 折成 SS），库里是 Weiß
        self.assertEqual(self.flags("WEISS, KLAUS", "Weiß K, Müller T"), "")

    def test_genuinely_different_author_still_flagged(self):
        self.assertIn("首作者不符", self.flags("Smith, John", "Zhang X, Li Y, Wang Z"))


if __name__ == "__main__":
    unittest.main(verbosity=2)

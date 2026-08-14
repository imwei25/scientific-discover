#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""跨条目查重的回归测试（纯离线，不联网）。

盯的是这个漏报：**AI 手写参考文献列表时把同一篇文献分配了两个编号**
（实测形态：[3] 与 [5] 同为 DOI:10.3390/ijms241814374，标题各自截断得略有不同），
而核查是逐条独立跑的——两条各自查真、各自判 OK，报告全绿、可疑 0 条，
主控据此宣布"引用核查通过"直接排版出件。

同时保留负例：查重不能宽到把 `…Part I` / `…Part II` 这类姊妹篇判成重复
（那会让用户去删一条真实存在的独立文献），也不能把两条各自编造的引用
凑成一组"重复"。

跑法（项目根 .venv）：
    .venv/Scripts/python.exe .opencode/skills/reference-check/tests/test_duplicates.py   # Windows
    .venv/bin/python .opencode/skills/reference-check/tests/test_duplicates.py           # Linux/macOS
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import verify_refs as V  # noqa: E402

FULL = ("Ferroptosis in hepatocellular carcinoma: mechanisms, "
        "therapeutic implications and future perspectives")
OTHER = "Global cancer statistics 2020: GLOBOCAN estimates of incidence and mortality"


def res(seq, cite_no="", verdict="OK", claimed="", found="", doi=None, pmid=None,
        sim=1.0, id_=None, year=None, match_doi=None, match_pmid=None):
    """造一条 verify_one 形状的结果（字段与真实产出一致）。"""
    if id_ is None:
        id_ = f"doi:{doi}" if doi else (f"pmid:{pmid}" if pmid else "title")
    return {"seq": seq, "cite_no": cite_no, "verdict": verdict, "sim": sim,
            "claimed_title": claimed, "found_title": found, "id": id_,
            "note": "标题吻合", "raw": claimed, "doi": doi, "pmid": pmid,
            "claimed_year": year, "_match_doi": match_doi, "_match_pmid": match_pmid}


class CatchesTheRealBug(unittest.TestCase):
    """必须抓到的重复形态。"""

    def test_same_doi_truncated_titles(self):
        """★ 用户实际踩到的那条：同 DOI、标题各自截断得略有不同、两条都判 OK。"""
        rs = [
            res(1, "3", claimed=FULL[:60], found=FULL, doi="10.3390/ijms241814374"),
            res(2, "5", claimed=FULL[:48] + " and outlook", found=FULL,
                doi="10.3390/ijms241814374"),
        ]
        groups, suspects = V.mark_duplicates(rs)
        self.assertEqual(len(groups), 1)
        self.assertEqual([V.cite_label(x) for x in groups[0]], ["[3]", "[5]"])
        self.assertEqual(rs[1]["dup_of"], "[3]")     # 后出现的那条挂到首现的编号上
        self.assertNotIn("dup_of", rs[0])            # 首现的不标
        self.assertIn("重复编号", rs[1]["note"])      # CSV 逐条读的人也看得到
        self.assertIn("重复引用", rs[0]["note"])

    def test_doi_written_in_different_forms(self):
        """同一个 DOI 写成 URL / doi: 前缀 / 大小写不同，仍是同一篇。"""
        rs = [
            res(1, "3", claimed=FULL, found=FULL, doi="10.3390/IJMS241814374"),
            res(2, "9", claimed=FULL, found=FULL,
                doi="https://doi.org/10.3390/ijms241814374"),
        ]
        groups, _ = V.mark_duplicates(rs)
        self.assertEqual(len(groups), 1)

    def test_one_has_doi_the_other_title_only(self):
        """claimed 侧对不上（一条有 DOI、一条只有标题），但解析到的是同一篇。
        这一种光比用户写的 DOI 永远抓不到，必须靠【解析回来的身份】。"""
        rs = [
            res(1, "3", claimed=FULL, found=FULL, doi="10.3390/ijms241814374"),
            res(2, "8", claimed=FULL, found=FULL, id_="title", sim=0.98,
                match_doi="10.3390/ijms241814374"),
        ]
        groups, _ = V.mark_duplicates(rs)
        self.assertEqual(len(groups), 1)
        self.assertEqual(rs[1]["dup_of"], "[3]")

    def test_preprint_and_journal_version(self):
        """两条各写了不同的 DOI（预印本 vs 正式版），但解析到同一个标题。"""
        rs = [
            res(1, "2", claimed=FULL, found=FULL, doi="10.1101/2023.01.01.522222"),
            res(2, "7", claimed=FULL, found=FULL, doi="10.3390/ijms241814374"),
        ]
        groups, _ = V.mark_duplicates(rs)
        self.assertEqual(len(groups), 1)

    def test_three_way_group(self):
        rs = [
            res(1, "1", claimed=FULL, found=FULL, doi="10.3390/ijms241814374"),
            res(2, "4", claimed=FULL, found=FULL, doi="10.3390/ijms241814374"),
            res(3, "6", claimed=FULL, found=FULL, pmid="37762649",
                match_doi="10.3390/ijms241814374", id_="pmid:37762649"),
        ]
        groups, _ = V.mark_duplicates(rs)
        self.assertEqual(len(groups), 1)
        self.assertEqual(len(groups[0]), 3)

    def test_retracted_verdict_survives(self):
        """重复不能覆写 verdict——一条重复的引用也可能同时是撤稿的，
        覆写就把撤稿这个更高危的结论吞掉了。"""
        rs = [
            res(1, "3", verdict="RETRACTED", claimed=FULL, found=FULL,
                doi="10.3390/ijms241814374"),
            res(2, "5", verdict="RETRACTED", claimed=FULL, found=FULL,
                doi="10.3390/ijms241814374"),
        ]
        V.mark_duplicates(rs)
        self.assertEqual([r["verdict"] for r in rs], ["RETRACTED", "RETRACTED"])

    def test_near_identical_titles_without_ids(self):
        """都没有 DOI/PMID、也没查到（中文期刊/老文献的常态），只能靠标题——
        这种只报"疑似"，不下重复的定论。"""
        rs = [
            res(1, "3", verdict="CHECK", claimed="肝细胞癌铁死亡机制的研究进展",
                id_="title", sim=0.0),
            res(2, "5", verdict="CHECK", claimed="肝细胞癌铁死亡机制研究进展",
                id_="title", sim=0.0),
        ]
        groups, suspects = V.mark_duplicates(rs)
        self.assertEqual(groups, [])
        self.assertEqual(len(suspects), 1)
        self.assertIn("高度相似", rs[0]["note"])


class DoesNotOverreach(unittest.TestCase):
    """负例：查重不能宽到误伤真实存在的独立文献。"""

    def test_different_papers_not_grouped(self):
        rs = [
            res(1, "1", claimed=FULL, found=FULL, doi="10.3390/ijms241814374"),
            res(2, "2", claimed=OTHER, found=OTHER, doi="10.3322/caac.21660"),
        ]
        groups, suspects = V.mark_duplicates(rs)
        self.assertEqual(groups, [])
        self.assertEqual(suspects, [])

    def test_part_one_and_part_two(self):
        """`…Part I` / `…Part II` 归一化后相似度 >0.92，但两条各自解析到了
        【不同的】记录 —— 已被证明是两篇，不该再按标题猜成重复。"""
        a = "Management of chronic hepatitis B: part I, diagnosis and assessment"
        b = "Management of chronic hepatitis B: part II, treatment and follow up"
        rs = [
            res(1, "1", claimed=a, found=a, doi="10.1000/aaa"),
            res(2, "2", claimed=b, found=b, doi="10.1000/bbb"),
        ]
        groups, suspects = V.mark_duplicates(rs)
        self.assertEqual(groups, [])
        self.assertEqual(suspects, [])

    def test_two_fabricated_entries_not_grouped(self):
        """两条各自编造的引用，found_title 是 title_search 的弱匹配(sim<0.85)，
        恰好落到同一篇真文献上 —— 拿它当身份键会凑出一组假"重复"。"""
        rs = [
            res(1, "1", verdict="FABRICATED", claimed="Ferroptosis and immune escape in HCC",
                found=FULL, doi="10.9999/fake1", sim=0.61),
            res(2, "2", verdict="FABRICATED", claimed="Autophagy and drug resistance in HCC",
                found=FULL, doi="10.9999/fake2", sim=0.58),
        ]
        groups, suspects = V.mark_duplicates(rs)
        self.assertEqual(groups, [])
        self.assertEqual(suspects, [])

    def test_same_title_different_year_not_suspect(self):
        """年份明确不同的两条（如年度统计报告），不按标题猜成同一篇。"""
        t = "Global cancer statistics: estimates of incidence and mortality"
        rs = [
            res(1, "1", verdict="CHECK", claimed=t, id_="title", sim=0.0, year="2018"),
            res(2, "2", verdict="CHECK", claimed=t, id_="title", sim=0.0, year="2021"),
        ]
        groups, suspects = V.mark_duplicates(rs)
        self.assertEqual(groups, [])
        self.assertEqual(suspects, [])

    def test_short_titles_not_paired(self):
        """太短的标题容易撞车，不参与标题档比对。"""
        rs = [
            res(1, "1", verdict="CHECK", claimed="COVID-19", id_="title", sim=0.0),
            res(2, "2", verdict="CHECK", claimed="COVID-19.", id_="title", sim=0.0),
        ]
        groups, suspects = V.mark_duplicates(rs)
        self.assertEqual(groups, [])
        self.assertEqual(suspects, [])

    def test_clean_list_stays_clean(self):
        rs = [res(i, str(i), claimed=f"{FULL} number {i}", found=f"{FULL} number {i}",
                  doi=f"10.1000/x{i}") for i in range(1, 9)]
        groups, suspects = V.mark_duplicates(rs)
        self.assertEqual((groups, suspects), ([], []))
        self.assertTrue(all("dup_of" not in r for r in rs))


class CiteNumbering(unittest.TestCase):
    """编号要从著录里原样抽出来——报告得能说"[3] 与 [5]"，用户才知道去改哪。"""

    def test_extract_bracket_number(self):
        line = ("[3] Sung H, Ferlay J, et al. " + OTHER +
                ". CA Cancer J Clin. 2021;71(3):209-249. doi:10.3322/caac.21660")
        self.assertEqual(V.extract(line)["cite_no"], "3")

    def test_extract_dot_number(self):
        self.assertEqual(V.extract("12. " + OTHER)["cite_no"], "12")

    def test_extract_paren_and_cjk_forms(self):
        self.assertEqual(V.extract("(7) " + OTHER)["cite_no"], "7")
        self.assertEqual(V.extract("8、张三. 肝细胞癌的免疫治疗. 中华肝脏病杂志. 2020")["cite_no"], "8")

    def test_no_number_leaves_blank(self):
        self.assertEqual(V.extract(OTHER)["cite_no"], "")

    def test_label_falls_back_to_seq(self):
        """.bib/.ris 没有方括号号 —— 绝不能拿条目序号冒充 `[n]`，
        那会把用户指向错误的编号去改正文。"""
        self.assertEqual(V.cite_label({"seq": 4, "cite_no": ""}), "第4条")
        self.assertEqual(V.cite_label({"seq": 4, "cite_no": "9"}), "[9]")

    def test_number_entries_fills_seq(self):
        es = V._number_entries([{"raw": "a"}, {"raw": "b", "cite_no": "5"}])
        self.assertEqual([e["seq"] for e in es], [1, 2])
        self.assertEqual([e["cite_no"] for e in es], ["", "5"])


class NormDoi(unittest.TestCase):
    def test_forms(self):
        for s in ("10.3390/ijms241814374", "10.3390/IJMS241814374",
                  "https://doi.org/10.3390/ijms241814374",
                  "http://dx.doi.org/10.3390/ijms241814374",
                  "doi:10.3390/ijms241814374", " 10.3390/ijms241814374. "):
            self.assertEqual(V.norm_doi(s), "10.3390/ijms241814374", s)

    def test_empty(self):
        self.assertEqual(V.norm_doi(None), "")
        self.assertEqual(V.norm_doi(""), "")


if __name__ == "__main__":
    unittest.main(verbosity=2)

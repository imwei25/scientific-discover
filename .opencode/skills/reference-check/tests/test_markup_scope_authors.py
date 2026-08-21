# -*- coding: utf-8 -*-
"""2026-08-21 打包版实测暴露的四个缺陷的回归测试：
① Crossref/EPMC 标题里的 JATS 标签（<scp> 等）把真引用判成 CHECK（假阳性）；
② 纯文本输入从不设 claimed_authors → 首作者交叉核对是死代码（张冠李戴被放行）；
③ 旁路核查（验候选文献）覆盖 reference_check.md 与闸裁定 → 假绿（fail-open）；
④ 参考文献列表没有 [n] 编号时，「正文引用位置」整列作废且诊断指错方向。
"""
import os, sys, types, unittest
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import verify_refs as V


class TestMarkup(unittest.TestCase):
    def test_strip_scp(self):
        self.assertEqual(V.strip_markup("In Advanced <scp>HCC</scp>?"), "In Advanced HCC ?")

    def test_strip_escaped_entity(self):
        self.assertNotIn("scp", V.strip_markup("&lt;scp&gt;PD&lt;/scp&gt;-L1").lower())

    def test_real_case_similarity_now_full(self):
        a = "From Theory to Practice: Which Biomarkers Are Ready for Predicting Response in Advanced HCC?"
        b = "From Theory to Practice: Which Biomarkers Are Ready for Predicting Response in Advanced <scp>HCC</scp>?"
        self.assertEqual(V.title_sim(a, b), 1.0)          # 修复前 0.64 → 判 CHECK 打红闸

    def test_math_angle_not_eaten(self):
        self.assertEqual(V.strip_markup("Cases where a<b and T<0.05"), "Cases where a<b and T<0.05")

    def test_italic_gene_names(self):
        self.assertEqual(V.strip_markup("<i>BRAF</i> V600E"), "BRAF V600E")


class TestAuthors(unittest.TestCase):
    def test_vancouver(self):
        e = V.extract("Finn RS, Qin S, et al. Atezo plus Bev. N Engl J Med. 2020;382(20):1894-1905.")
        self.assertTrue(e["claimed_authors"].startswith("Finn RS"))

    def test_wrong_first_author_now_flagged(self):
        e = V.extract("[30] Kong H, Li Q. Something about PD-L1. Liver Int. 2026;46(5):e70647.")
        self.assertIn("首作者不符", V._author_year_flags(e, {"authors": "Wang X, Li Q", "year": "2026"}))

    def test_right_first_author_silent(self):
        e = V.extract("[30] Wang X, Li Q. Something. Liver Int. 2026;46(5):e70647.")
        self.assertEqual(V._author_year_flags(e, {"authors": "Wang X, Li Q", "year": "2026"}), "")

    def test_title_first_line_gives_no_false_authors(self):
        # 著录以标题开头（没有作者段）→ 必须回空串，绝不能把标题当成作者制造假警报
        e = V.extract("Atezolizumab plus Bevacizumab in Unresectable HCC. N Engl J Med. 2020;382:1894.")
        self.assertEqual(e["claimed_authors"], "")

    def test_chinese_authors(self):
        e = V.extract("张三, 李四, 等. 中国肝癌诊疗指南. 中华肝脏病杂志. 2024;32(1):1-10.")
        self.assertEqual(e["claimed_authors"], "张三, 李四, 等")


class TestDiacritics(unittest.TestCase):
    """带变音符的姓名。既是覆盖洞（Núñez 抽不出作者段 → 静默跳过比对），
    也是【新引进来的假红闸】：引用写 ASCII 而库里是原拼 → 逐字比对判"首作者不符"。"""

    def test_fold_latin_marks(self):
        self.assertEqual(V._fold_diacritics("Núñez Bayés-Genís"), "Nunez Bayes-Genis")

    def test_fold_standalone_letters(self):
        # ø/æ/ł 不是"字母+组合符"，NFD 分解不出 ASCII 基字，靠单独的映射表
        self.assertEqual(V._fold_diacritics("Løvdahl"), "Lovdahl")
        self.assertEqual(V._fold_diacritics("Sæther"), "Saether")
        self.assertEqual(V._fold_diacritics("Wałęsa"), "Walesa")

    def test_cjk_and_kana_untouched(self):
        # ★ 绝不能 NFKD 全剥：那会把浊音符剥掉（が→か）、把谚文拆开，改变字义
        self.assertEqual(V._fold_diacritics("がぎ 東京 한글"), "がぎ 東京 한글")

    def test_accented_name_now_extracted(self):
        e = V.extract("Núñez J, Bayés-Genís A, et al. Empagliflozin in acute HF. Eur Heart J. 2021;42(3):200-210.")
        self.assertTrue(e["claimed_authors"].startswith("Núñez J"))

    def test_ascii_citation_vs_accented_record_is_silent(self):
        # 修复前：'首作者不符(引用nunez)' —— 一份干净稿子被打红闸
        e = V.extract("Nunez J, Bayes-Genis A, et al. Empagliflozin. Eur Heart J. 2021;42(3):200-210.")
        self.assertEqual(V._author_year_flags(e, {"authors": "Núñez J, Bayés-Genís A", "year": "2021"}), "")

    def test_accented_citation_vs_ascii_record_is_silent(self):
        e = V.extract("Núñez J, Bayés-Genís A, et al. Empagliflozin. Eur Heart J. 2021;42(3):200-210.")
        self.assertEqual(V._author_year_flags(e, {"authors": "Nunez J, Bayes-Genis A", "year": "2021"}), "")

    def test_real_mismatch_still_caught(self):
        # 折变音符不能把"张冠李戴"一起折没了
        e = V.extract("Nunez J, Li Q. Something. Eur Heart J. 2021;42(3):200-210.")
        self.assertIn("首作者不符", V._author_year_flags(e, {"authors": "Wang X, Li Q", "year": "2021"}))

    def test_title_with_accents_matches(self):
        self.assertEqual(V.title_sim("Lovdahl study of Nunez criteria",
                                     "Løvdahl study of Núñez criteria"), 1.0)


def _args(**kw):
    d = dict(scope="auto", ids=[], input=None)
    d.update(kw)
    return types.SimpleNamespace(**d)


class TestScope(unittest.TestCase):
    def test_plain_refs_is_manuscript(self):
        self.assertEqual(V._run_scope(_args(input="refs.txt")), "manuscript")

    def test_scratch_input_is_adhoc(self):
        self.assertEqual(V._run_scope(_args(input=".scratch/candidate_refs.txt")), "adhoc")
        self.assertEqual(V._run_scope(_args(input=r".scratch\candidate_refs.txt")), "adhoc")

    def test_bare_titles_are_adhoc(self):
        self.assertEqual(V._run_scope(_args(ids=["Critical Appraisal of Guideline…"])), "adhoc")

    def test_explicit_override(self):
        self.assertEqual(V._run_scope(_args(ids=["x"], scope="manuscript")), "manuscript")
        self.assertEqual(V._run_scope(_args(input="refs.txt", scope="adhoc")), "adhoc")

    def test_refs_only_run_still_counts_as_manuscript(self):
        # 只有列表、没有正文的正式核查是合法用法：不能因为没给 --manuscript 就判成旁路，
        # 否则这类会话的闸永远绿不了。
        self.assertEqual(V._run_scope(_args(input="refs.bib")), "manuscript")


class TestAutoNumber(unittest.TestCase):
    def _res(self, n):
        return [{"seq": i, "cite_no": ""} for i in range(1, n + 1)]

    def _paras(self, text):
        return [{"no": 1, "sno": 1, "section": "正文", "text": text}]

    def test_assigns_by_list_order(self):
        rs = self._res(3)
        self.assertTrue(V._autonumber_by_body(rs, self._paras("如前所述[1]，另有报道[2-3]。")))
        self.assertEqual([r["cite_no"] for r in rs], ["1", "2", "3"])

    def test_respects_existing_numbers(self):
        rs = self._res(3)
        rs[0]["cite_no"] = "7"
        self.assertFalse(V._autonumber_by_body(rs, self._paras("见[1]")))

    def test_no_marks_no_numbering(self):
        rs = self._res(3)
        self.assertFalse(V._autonumber_by_body(rs, self._paras("按 (Packer et al., 2020) 的说法")))

    def test_marks_exceed_entries_bails_out(self):
        rs = self._res(3)
        self.assertFalse(V._autonumber_by_body(rs, self._paras("见[9]")))
        self.assertEqual([r["cite_no"] for r in rs], ["", "", ""])


if __name__ == "__main__":
    unittest.main(verbosity=1)

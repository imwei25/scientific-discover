#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""正文引用定位（--manuscript）的回归测试（纯离线，不联网）。

盯的是这个漏报：**参考文献表里躺着一条正文从没引过的文献**——改稿删段落时把正文引用删了、
题录却留在表里，或模型为了凑参考文献数多列几条。逐条核查全 OK、查重也不报，报告全绿。

同时保留负例：
  · 参考文献那一节必须被排除（否则列表里逐字提到了每条，每条都"被引用"，这道闸等于没做）；
  · 圆括号数字 `(1)` 不算引用标记（正文里绝大多数是分点编号）；
  · 编号没抽全时不许报"悬空引用"（表里其实有那篇，报了用户会去删正文里的真引用）。

跑法（项目根 .venv）：
    .venv/Scripts/python.exe .opencode/skills/reference-check/tests/test_cited_in.py   # Windows
    .venv/bin/python .opencode/skills/reference-check/tests/test_cited_in.py           # Linux/macOS
"""
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from verify_refs import (parse_cite_marks, load_manuscript,  # noqa: E402
                         locate_in_manuscript, extract, _number_entries)

BODY = """# 引言

肝癌是常见恶性肿瘤[1]。既往研究提示免疫治疗有效[2,3]。

# 讨论

本研究与既往结果一致[1]。

## 参考文献

[1] Villanueva A. Hepatocellular carcinoma. N Engl J Med. 2019;380(15):1450-1462. doi:10.1056/NEJMra1713263
[2] Finn RS, Qin S. Atezolizumab plus bevacizumab. N Engl J Med. 2020;382(20):1894-1905.
[3] Someone A. A never cited paper. J Test. 2021;1(1):1-2.
"""


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()

    def body(self, text, name="body.md"):
        p = os.path.join(self.tmp, name)
        with open(p, "w", encoding="utf-8") as f:
            f.write(text)
        return load_manuscript(p)


class TestMarks(unittest.TestCase):
    def test_forms(self):
        self.assertEqual(parse_cite_marks("如前所述[1]"), {1})
        self.assertEqual(parse_cite_marks("多条[3,5]与[7；9]"), {3, 5, 7, 9})
        self.assertEqual(parse_cite_marks("区间[3-6]"), {3, 4, 5, 6})
        self.assertEqual(parse_cite_marks("全角【12】"), {12})
        self.assertEqual(parse_cite_marks("上标¹²"), {12})
        self.assertEqual(parse_cite_marks("上标¹,²"), {1, 2})

    def test_ignores_parens_and_prose(self):
        # 圆括号里的数字在正文里绝大多数是分点编号，认了会满篇假命中
        self.assertEqual(parse_cite_marks("(1) 首先 (2) 其次"), set())
        self.assertEqual(parse_cite_marks("见 [图1] 与 [Table 2]"), set())
        # 页码/年份区间不像引用（跨度过大）
        self.assertEqual(parse_cite_marks("[1990-2020]"), set())


class TestSectioning(Base):
    def test_reference_section_excluded(self):
        paras = self.body(BODY)
        texts = " ".join(p["text"] for p in paras)
        self.assertNotIn("Villanueva", texts,
                         "参考文献节必须被排除，否则每条都会'被引用'，这道闸等于没做")
        self.assertEqual(paras[0]["section"], "引言")
        self.assertEqual(paras[-1]["section"], "讨论")

    def test_numbered_cn_headings(self):
        paras = self.body("1. 引言\n\n甲[1]。\n\n3. 讨论\n\n乙[1]。\n\n参考文献\n\n[1] x\n")
        self.assertEqual([p["section"] for p in paras], ["引言", "讨论"])
        self.assertTrue(all("[1] x" not in p["text"] for p in paras))


class TestLocate(Base):
    def test_uncited_detected(self):
        refs = _number_entries([
            extract("[1] Villanueva A. Hepatocellular carcinoma. N Engl J Med. 2019;380(15):1450-1462."),
            extract("[2] Finn RS, Qin S. Atezolizumab plus bevacizumab. N Engl J Med. 2020;382(20):1894-1905."),
        ])
        paras = self.body("# 引言\n\n仅引第一条[1]。\n\n## 参考文献\n\n[1] x\n")
        dangling, coverage, has_no = locate_in_manuscript(refs, paras)
        self.assertEqual(refs[0]["cited_in"], "引言¶1")
        self.assertEqual(refs[1]["cited_in"], "")        # 未被正文引用
        self.assertEqual(dangling, [])
        self.assertTrue(has_no)
        self.assertEqual(coverage, 0.5)

    def test_all_marks_matched(self):
        refs = _number_entries([extract("[%d] Author A. Title %d. J Test. 2020;1(1):1." % (i, i))
                                for i in (1, 2, 3)])
        paras = self.body(BODY)
        dangling, coverage, _ = locate_in_manuscript(refs, paras)
        self.assertEqual(coverage, 1.0)
        self.assertEqual(refs[0]["cited_in"], "引言¶1、讨论¶1")   # [1] 被引两处
        self.assertEqual(dangling, [])

    def test_dangling_cite_no(self):
        refs = _number_entries([extract("[1] Author A. Title. J Test. 2020;1(1):1.")])
        paras = self.body("# 引言\n\n引了一个不存在的编号[9]。\n")
        dangling, _, _ = locate_in_manuscript(refs, paras)
        self.assertEqual([n for n, _ in dangling], [9])

    def test_partial_numbering_no_false_dangling(self):
        refs = _number_entries([extract("[1] Author A. Title. J Test. 2020;1(1):1."),
                                extract("Author B. Numberless entry. J Test. 2021;2(2):2.")])
        paras = self.body("# 引言\n\n甲[1]，乙[2]。\n")
        dangling, _, _ = locate_in_manuscript(refs, paras)
        self.assertEqual(dangling, [], "编号没抽全时报悬空引用是假警报")

    def test_author_year_fallback(self):
        """作者-年份体系（正文无方括号编号）也要能定位。"""
        refs = _number_entries([extract(
            "Finn RS, Qin S. Atezolizumab plus bevacizumab in hepatocellular carcinoma. "
            "N Engl J Med. 2020;382(20):1894-1905.")])
        paras = self.body("# 引言\n\n如 Finn et al. (2020) 所示，联合治疗改善总生存。\n")
        locate_in_manuscript(refs, paras)
        self.assertEqual(refs[0]["cited_in"], "引言¶1")

    def test_doi_written_in_body(self):
        refs = _number_entries([extract(
            "Villanueva A. Hepatocellular carcinoma. N Engl J Med. 2019;380(15):1450-1462. "
            "doi:10.1056/NEJMra1713263")])
        paras = self.body("# 方法\n\n按 doi:10.1056/NEJMra1713263 的定义分期。\n")
        locate_in_manuscript(refs, paras)
        self.assertEqual(refs[0]["cited_in"], "方法¶1")

    def test_no_manuscript_leaves_column_empty(self):
        refs = _number_entries([extract("[1] Author A. Title. J Test. 2020;1(1):1.")])
        dangling, coverage, has_no = locate_in_manuscript(refs, [])
        self.assertEqual(refs[0]["cited_in"], "")
        self.assertEqual((dangling, coverage, has_no), ([], 0.0, False))


if __name__ == "__main__":
    unittest.main(verbosity=2)

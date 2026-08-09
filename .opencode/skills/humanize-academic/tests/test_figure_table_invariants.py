#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""润色丢图表的回归测试（纯离线）。

盯的是这个真实故障：上传一份带图带表的 .docx 去润色，拿回来的稿子里图和表没了，
而全链路一句红字都没有 —— check_invariants.py 当时只比对数字与引用，图表整块消失
照样打印 "[OK] ... 一致"，用户据此以为过了闸；等到排版时 pandoc 也只是打一句
`Could not fetch resource` 然后退 0，出来的 .docx 里一张图都没有。

这里钉住三种丢法都必须判红，外加一条最要紧的负例：**忠实润色不许误报**
（图题措辞改了、表格列宽 padding 变了都属正常，误报会把这道闸变成噪声，
而数字闸和它挤在同一份输出里，一起被用户学会无视）。

跑法（项目根 .venv）：
    .venv/Scripts/python.exe .opencode/skills/humanize-academic/tests/test_figure_table_invariants.py   # Windows
    .venv/bin/python .opencode/skills/humanize-academic/tests/test_figure_table_invariants.py           # Linux/macOS
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts"))
import check_invariants as C  # noqa: E402

BEFORE = """# 稿件

本研究纳入 120 例患者[1]。

**表1. 基线特征**

| 变量 | A 组 (n=60) | B 组 (n=60) | P 值 |
|------|------------|------------|------|
| 年龄 | 62.3 ± 8.1 | 61.9 ± 7.8 | 0.78 |
| 男性 | 34 (56.7)  | 36 (60.0)  | 0.71 |

![图1. 生存曲线](manu_files/fig_001.png){width="3.2in" height="2.4in"}
"""

# 忠实润色：改了行文与图题措辞、表格列宽 padding 变了，但图表本身一个没少
FAITHFUL = """# 稿件

本研究共纳入 120 例患者[1]。

**表1. 基线特征**

| 变量 | A 组 (n=60) | B 组 (n=60) | P 值 |
|---|---|---|---|
| 年龄 | 62.3 ± 8.1 | 61.9 ± 7.8 | 0.78 |
| 男性 | 34 (56.7) | 36 (60.0) | 0.71 |

![图1. Kaplan-Meier 生存曲线](manu_files/fig_001.png){width="3.2in" height="2.4in"}
"""

# 事故 A：整篇重写时把图那一行漏掉了
LOST_FIGURE = FAITHFUL.replace(
    '![图1. Kaplan-Meier 生存曲线](manu_files/fig_001.png){width="3.2in" height="2.4in"}', "")

# 事故 B：把表"改写成一段更流畅的文字"
FLAT_TABLE = """# 稿件

本研究共纳入 120 例患者[1]。

**表1. 基线特征**

A 组平均年龄 62.3 ± 8.1 岁，B 组 61.9 ± 7.8 岁（P = 0.78）。

![图1. 生存曲线](manu_files/fig_001.png){width="3.2in" height="2.4in"}
"""

# 事故 C：链接还写着，文件却不在（最隐蔽的一种 —— 排版时无声消失）
DANGLING = FAITHFUL.replace("manu_files/fig_001.png", "media/rId10.png")


def kinds(before, after):
    """跑一遍抽取 + diff，返回 {类别: (丢失, 新增)}。"""
    eb, ea = C.extract(before), C.extract(after)
    out = {}
    for k in eb:
        lost, added = C.diff_counter(eb[k], ea.get(k, C.Counter()))
        if lost or added:
            out[k] = (lost, added)
    return out


class TestFigureTableInvariants(unittest.TestCase):
    def test_faithful_polish_is_clean(self):
        """负例最要紧：改图题、改列宽 padding 都不许报 —— 误报会把整道闸变成噪声。"""
        self.assertEqual(kinds(BEFORE, FAITHFUL), {},
                         "忠实润色被误判了，图表闸会连带把数字闸一起变成噪声")

    def test_lost_figure_is_caught(self):
        d = kinds(BEFORE, LOST_FIGURE)
        self.assertIn("图片", d)
        self.assertIn("manu_files/fig_001.png", d["图片"][0])

    def test_flattened_table_is_caught(self):
        d = kinds(BEFORE, FLAT_TABLE)
        self.assertIn("表格", d)
        self.assertTrue(any("变量" in s for s in d["表格"][0]),
                        "报错要指出是哪张表，只说『少了一张表』用户无从下手")

    def test_swapped_image_path_is_caught(self):
        d = kinds(BEFORE, DANGLING)
        self.assertIn("图片", d)
        self.assertIn("manu_files/fig_001.png", d["图片"][0])
        self.assertIn("media/rId10.png", d["图片"][1])

    def test_image_path_digits_do_not_pollute_number_diff(self):
        """路径里的 001 / 宽高里的 3.2in 不能进"数字"。

        数字闸是本脚本最要紧的一条。抽取时不抹掉图片链接的话，每份正常润色稿都会
        报"数字有变化"，用户学会无视之后，真的改了 p 值也不会有人看。
        """
        nums = C.extract(BEFORE)["数字"]
        for noise in ("001", "3.2in", "2.4in"):
            self.assertNotIn(noise, nums, f"{noise!r} 是图片路径/尺寸里的噪声，不该算数字")
        for real in ("120", "62.3", "0.78"):
            self.assertIn(real, nums, f"{real!r} 是正文里的真数字，不能被一起抹掉")

    def test_table_signature_counts_rows(self):
        """少了两行数据（复制粘贴截断）也要判红，不是只看"表还在不在"。"""
        short = FAITHFUL.replace("| 男性 | 34 (56.7) | 36 (60.0) | 0.71 |\n", "")
        d = kinds(BEFORE, short)
        self.assertIn("表格", d)


if __name__ == "__main__":
    unittest.main(verbosity=2)

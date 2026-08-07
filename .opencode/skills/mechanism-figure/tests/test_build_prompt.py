#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""build_prompt.py 的离线回归测试（不联网、不花钱）。

跑法（项目根 .venv）：
  .venv/Scripts/python.exe .opencode/skills/mechanism-figure/tests/test_build_prompt.py   # Windows
  .venv/bin/python .opencode/skills/mechanism-figure/tests/test_build_prompt.py           # Linux

重点守住两件事：
  ① 反编造闸真的会拦（标签不在用户材料里 → errors 非空）；
  ② 构图骨架该出现的都出现（栏数/序号圆圈/横向膜/单引号标签/负面词），
     因为这些正是"画成左侧一个巨大竖细胞"那类翻车的唯一防线。
"""
import json
import sys
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))

import build_prompt as bp  # noqa: E402


def spec(**over):
    s = {
        "style": "flat",
        "aspect_ratio": "1:1",
        "panels": [
            {"name": "Trigger", "labels": ["CaOx"], "elements": ["extracellular space"]},
            {"name": "ER stress", "labels": ["GRP78 ↑", "CHOP ↑"], "elements": ["tubular ER network"]},
        ],
        "arrows": [{"from": "CaOx", "to": "GRP78 ↑", "type": "activate"}],
    }
    s.update(over)
    return s


SRC = "我们发现 CaOx 晶体刺激后 GRP78 与 CHOP 表达上调，提示内质网应激被激活。"


class TestAntiFabrication(unittest.TestCase):
    """反编造闸 —— 本技能存在的首要理由。"""

    def test_label_absent_from_source_is_blocked(self):
        s = spec(panels=[{"name": "S1", "labels": ["CaOx", "GPX4"]}])   # GPX4 原文里没有
        errs, _ = bp.validate(s, SRC)
        self.assertTrue(errs)
        self.assertTrue(any("GPX4" in e for e in errs), errs)

    def test_all_labels_present_passes(self):
        errs, _ = bp.validate(spec(), SRC)
        self.assertEqual(errs, [], errs)

    def test_arrow_modifier_and_case_are_ignored_when_matching(self):
        # 材料里写的是 "GRP78"，spec 里写 "grp78 ↑" 也该算找到（↑ 是我们加的强调，不是分子名的一部分）
        s = spec(panels=[{"name": "S1", "labels": ["grp78 ↑"]}], arrows=[])
        errs, _ = bp.validate(s, SRC)
        self.assertEqual(errs, [], errs)

    def test_no_source_only_warns(self):
        errs, warns = bp.validate(spec(), None)
        self.assertEqual(errs, [])
        self.assertTrue(any("--source" in w for w in warns), warns)

    def test_generic_textbook_phrase_rejected(self):
        s = spec(panels=[{"name": "S1", "labels": ["CaOx", "kinase cascade"]}], arrows=[])
        errs, _ = bp.validate(s, SRC)
        self.assertTrue(any("泛化词" in e for e in errs), errs)

    def test_generic_phrase_allowed_if_user_really_wrote_it(self):
        s = spec(panels=[{"name": "S1", "labels": ["kinase cascade"]}], arrows=[])
        errs, _ = bp.validate(s, "本文讨论 kinase cascade 的作用")
        self.assertEqual(errs, [], errs)

    def test_arrow_relation_label_only_warns(self):
        """箭头上的关系描述是英文表述，中文材料里本来就没有原词 —— 只能提醒，不能拦。

        拦了的后果不是"更严格"，而是每份中文稿件都被挡 → 用户学会绕过整个闸 → 反编造彻底失效。
        """
        s = spec(arrows=[{"from": "CaOx", "to": "GRP78 ↑", "type": "convert",
                          "label": "GSH degradation"}])
        errs, warns = bp.validate(s, SRC)
        self.assertEqual(errs, [], errs)
        self.assertTrue(any("关系描述" in w for w in warns), warns)

    def test_entity_endpoints_of_arrows_are_still_strict(self):
        """箭头两端是实体，照旧严查 —— 别让 arrows 成为绕过闸的后门。"""
        s = spec(arrows=[{"from": "CaOx", "to": "SLC7A11", "type": "activate"}])
        errs, _ = bp.validate(s, SRC)
        self.assertTrue(any("SLC7A11" in e for e in errs), errs)

    def test_allow_exempts_translated_entity_but_warns(self):
        s = spec(panels=[{"name": "S1", "labels": ["CaOx"]}], arrows=[])
        src_zh = "草酸钙晶体刺激后内质网应激激活"          # 材料是中文全称，图上用国际缩写
        errs, _ = bp.validate(s, src_zh)
        self.assertTrue(errs, "没声明就该拦")
        errs2, warns2 = bp.validate(s, src_zh, allow=["CaOx"])
        self.assertEqual(errs2, [], errs2)
        self.assertTrue(any("--allow" in w and "CaOx" in w for w in warns2), warns2)

    def test_allow_does_not_whitelist_other_labels(self):
        s = spec(panels=[{"name": "S1", "labels": ["CaOx", "GPX4"]}], arrows=[])
        errs, _ = bp.validate(s, "草酸钙", allow=["CaOx"])
        self.assertTrue(any("GPX4" in e for e in errs), errs)
        self.assertFalse(any("CaOx" in e for e in errs), errs)


class TestGuards(unittest.TestCase):
    def test_panel_count_bounds(self):
        many = [{"name": f"S{i}", "labels": ["CaOx"]} for i in range(1, 8)]
        errs, _ = bp.validate(spec(panels=many, arrows=[]), SRC)
        self.assertTrue(any("panels" in e for e in errs), errs)
        errs2, _ = bp.validate(spec(panels=[], arrows=[]), SRC)
        self.assertTrue(any("panels" in e for e in errs2), errs2)

    def test_too_many_labels_in_one_panel(self):
        s = spec(panels=[{"name": "S1", "labels": [f"CaOx{i}" for i in range(9)]}], arrows=[])
        errs, _ = bp.validate(s, None)
        self.assertTrue(any("每栏上限" in e for e in errs), errs)

    def test_single_quote_in_label_rejected(self):
        s = spec(panels=[{"name": "S1", "labels": ["CaOx's"]}], arrows=[])
        errs, _ = bp.validate(s, None)
        self.assertTrue(any("单引号" in e for e in errs), errs)

    def test_unknown_style_and_arrow_type(self):
        errs, _ = bp.validate(spec(style="anime"), SRC)
        self.assertTrue(any("style" in e for e in errs), errs)
        errs2, _ = bp.validate(spec(arrows=[{"from": "CaOx", "to": "GRP78 ↑", "type": "explode"}]), SRC)
        self.assertTrue(any("type" in e for e in errs2), errs2)

    def test_arrow_needs_both_ends(self):
        errs, _ = bp.validate(spec(arrows=[{"from": "CaOx", "type": "activate"}]), SRC)
        self.assertTrue(any("from" in e and "to" in e for e in errs), errs)


class TestLayoutSkeleton(unittest.TestCase):
    """构图骨架：这些串少一个，就可能回到"左侧一个巨大竖细胞"的老毛病。"""

    def test_flat_multipanel_skeleton(self):
        p, neg = bp.build(spec())
        self.assertIn("2 distinct vertical pastel background colour panels", p)
        self.assertIn("(1), (2)", p)                       # 顶部序号圆圈
        self.assertIn("HORIZONTALLY", p)                   # 横向细胞膜
        self.assertIn("no giant brush border on the left", p)
        self.assertIn("giant vertical cell on left", neg)  # 负面词
        self.assertIn("blurry labels", neg)

    def test_labels_are_single_quoted(self):
        p, _ = bp.build(spec())
        self.assertIn("'GRP78 ↑'", p)
        self.assertIn("'CHOP ↑'", p)

    def test_quotes_declared_as_delimiters_not_glyphs(self):
        """引号是定界符，不能被画进图里。

        真机实测过：不说这句，模型会把撇号一起画出来（满图 'GRP78 ↑），
        看着像排版事故；而"事后 PS 掉"恰恰是各刊明令禁止的图像操作。正文与负面词各堵一次。
        """
        p, neg = bp.build(spec())
        self.assertIn("never draw the quotation marks", p)
        self.assertIn("delimiters", p)
        self.assertIn("quotation marks", neg)
        self.assertIn("appear exactly once", p, "同一标签画两遍也实测出现过")

    def test_no_markdown_survives(self):
        s = spec(panels=[{"name": "**Trigger**", "labels": ["CaOx"],
                          "elements": ["# heading", "- bullet", "`code`"]}], arrows=[])
        p, _ = bp.build(s)
        for bad in ("**", "#", "`", "\n"):
            self.assertNotIn(bad, p, f"prompt 里不该出现 {bad!r}（生图 API 会把它当字面量画进去）")

    def test_arrow_semantics_map_to_fixed_drawing(self):
        s = spec(arrows=[
            {"from": "GSH", "to": "GPX4", "type": "inhibit"},
            {"from": "CHOP", "to": "Nucleus", "type": "translocate", "label": "CHAC1"},
            {"from": "PD-1", "to": "PD-L1", "type": "block"},
        ])
        p, _ = bp.build(s)
        self.assertIn("T-bar inhibition line", p)
        self.assertIn("translocation of 'CHOP'", p)
        self.assertIn("red X cross symbol", p)

    def test_single_panel_skips_column_skeleton(self):
        s = spec(panels=[{"name": "Docking", "labels": ["PD-1"]}], arrows=[])
        p, _ = bp.build(s)
        self.assertNotIn("vertical pastel background colour panels", p)
        self.assertIn("Scene", p)

    def test_style_tails_differ(self):
        f, fneg = bp.build(spec(style="flat"))
        r, rneg = bp.build(spec(style="realistic"))
        st, _ = bp.build(spec(style="structure"))
        self.assertIn("flat 2D vector", f)
        self.assertIn("3D render", fneg)                 # 扁平风要排掉 3D
        self.assertIn("volumetric lighting", r)
        self.assertIn("flat 2D clipart", rneg)           # 拟真风反过来排掉扁平
        self.assertIn("ribbon", st)

    def test_ascii_labels_add_cjk_negative(self):
        _, neg = bp.build(spec())
        self.assertIn("chinese characters", neg)

    def test_cjk_labels_do_not_ban_cjk(self):
        s = spec(panels=[{"name": "S1", "labels": ["草酸钙"]}], arrows=[])
        _, neg = bp.build(s)
        self.assertNotIn("chinese characters", neg)

    def test_extra_negative_appended(self):
        _, neg = bp.build(spec(extra_negative=["red blood cells"]))
        self.assertIn("red blood cells", neg)

    def test_panel_colors_default_when_absent(self):
        p, _ = bp.build(spec())
        self.assertIn("light yellow", p)
        self.assertIn("light blue", p)


class TestShippedTemplate(unittest.TestCase):
    def test_example_spec_builds_and_validates(self):
        tpl = Path(__file__).resolve().parents[1] / "templates" / "spec.example.json"
        s = json.loads(tpl.read_text(encoding="utf-8"))
        errs, _ = bp.validate(s, None)
        self.assertEqual(errs, [], f"随包模板自己都过不了检查：{errs}")
        p, neg = bp.build(s)
        self.assertGreater(len(p), 500)
        self.assertIn("4 distinct vertical pastel background colour panels", p)
        self.assertNotIn("_说明", p, "下划线注释键不该被画进图里")


if __name__ == "__main__":
    unittest.main(verbosity=2)

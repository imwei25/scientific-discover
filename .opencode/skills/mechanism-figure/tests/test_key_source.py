#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""render_figure.py 的 key 来源解析测试（离线、不联网、不需要真 key）。

跑法：
  .venv/Scripts/python.exe .opencode/skills/mechanism-figure/tests/test_key_source.py   # Windows
  .venv/bin/python .opencode/skills/mechanism-figure/tests/test_key_source.py           # Linux

守住三件事（每一件都对应一个真实的泄露/误配途径）：
  ① 仓库内的 key 文件必须被拦 —— 这是"key 进 git 历史"的唯一入口，一进历史就只能换 key；
  ② key 文件只能设白名单里那几个变量 —— 否则一个文本文件就能改本进程的 PATH/代理；
  ③ 进程环境变量优先于 key 文件 —— 服务器上 key 由容器注入，那是权威来源。
"""
import os
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))

import render_figure as rf  # noqa: E402

FAKE = "fake-key-for-tests-only"


class KeySourceTest(unittest.TestCase):
    def setUp(self):
        self._env = dict(os.environ)
        for k in ("QWEN_API_KEY", "DASHSCOPE_API_KEY", "QWEN_MODEL", "QWEN_BASE_URL", "SCI_IMAGE_ENV"):
            os.environ.pop(k, None)
        self._tmp = tempfile.mkdtemp(prefix="mechfig-key-")

    def tearDown(self):
        os.environ.clear()
        os.environ.update(self._env)

    def _write(self, text, name="image.env"):
        p = Path(self._tmp) / name
        p.write_text(text, encoding="utf-8")
        return p

    def test_repo_root_is_found_by_marker_not_by_depth(self):
        """按标志文件向上找，不数目录层数：数层数在技能被拷到别处时会静默指错，
        而指错的后果就是下面那道仓库内守卫完全失效（第一版就是这么错的）。"""
        root = rf._repo_root()
        self.assertTrue((root / ".git").exists() or (root / "AGENTS.md").is_file(),
                        f"没找到仓库根，拿到的是 {root}")
        self.assertTrue(str(SCRIPTS).startswith(str(root)), "脚本应在仓库根之下")

    def test_key_file_inside_repo_is_refused(self):
        inside = rf._repo_root() / "AGENTS.md"        # 用已存在的仓库文件，不必真写一个 key 进去
        os.environ["SCI_IMAGE_ENV"] = str(inside)
        with self.assertRaises(SystemExit) as cm:
            rf.load_key_file()
        self.assertIn("仓库目录内", str(cm.exception))

    def test_key_file_outside_repo_is_loaded(self):
        p = self._write(f"# 注释行\nQWEN_API_KEY={FAKE}\n")
        os.environ["SCI_IMAGE_ENV"] = str(p)
        self.assertEqual(rf.load_key_file(), p)
        self.assertEqual(os.environ["QWEN_API_KEY"], FAKE)

    def test_only_whitelisted_keys_are_applied(self):
        p = self._write(f"QWEN_API_KEY={FAKE}\nPATH=/hijacked\nHTTPS_PROXY=http://evil\n")
        os.environ["SCI_IMAGE_ENV"] = str(p)
        before_path = os.environ.get("PATH")
        rf.load_key_file()
        self.assertEqual(os.environ["QWEN_API_KEY"], FAKE)
        self.assertEqual(os.environ.get("PATH"), before_path, "key 文件不该能改 PATH")
        self.assertNotEqual(os.environ.get("HTTPS_PROXY"), "http://evil")

    def test_process_env_wins_over_file(self):
        p = self._write("QWEN_API_KEY=from-file\n")
        os.environ["SCI_IMAGE_ENV"] = str(p)
        os.environ["QWEN_API_KEY"] = "from-process"   # 服务器上就是这条：容器注入的才是权威
        rf.load_key_file()
        self.assertEqual(os.environ["QWEN_API_KEY"], "from-process")

    def test_quotes_and_blank_lines_tolerated(self):
        p = self._write(f"\n\nQWEN_API_KEY = '{FAKE}'  \n# 尾注释\nQWEN_MODEL=\"qwen-image-2.0\"\n")
        os.environ["SCI_IMAGE_ENV"] = str(p)
        rf.load_key_file()
        self.assertEqual(os.environ["QWEN_API_KEY"], FAKE)
        self.assertEqual(os.environ["QWEN_MODEL"], "qwen-image-2.0")

    def test_missing_key_message_tells_user_both_safe_ways(self):
        os.environ["SCI_IMAGE_ENV"] = str(Path(self._tmp) / "does-not-exist.env")
        with self.assertRaises(SystemExit) as cm:
            rf.api_key()
        msg = str(cm.exception)
        self.assertIn(".sci-agent", msg, "要给出仓库外的推荐位置")
        self.assertIn("QWEN_API_KEY", msg)
        self.assertIn("dry-run", msg, "要告诉用户没 key 也能先做提示词")
        self.assertNotIn("sk-", msg.replace("sk-xxxx", ""), "示例之外不该出现任何疑似真 key 的串")


if __name__ == "__main__":
    unittest.main(verbosity=2)

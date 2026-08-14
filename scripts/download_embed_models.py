#!/usr/bin/env python3
"""下载 zotero-library 全文 RAG 用的本地嵌入/精排模型（从 ModelScope）。

被 install.ps1 -WithEmbed / install.sh --with-embed 调用，也可单独跑。
前提：已装 modelscope + sentence-transformers（install 脚本的 -WithEmbed 会先装）。
全程本地，不走任何远程大模型端点。模型缓存在 ~/.cache/modelscope（幂等，重复跑走缓存）。
"""
from __future__ import annotations

import sys

for _s in (sys.stdout, sys.stderr):  # Windows 控制台 GBK → 强制 UTF-8
    try:
        _s.reconfigure(encoding="utf-8")  # type: ignore[union-attr]
    except Exception:  # noqa: BLE001
        pass

MODELS = [
    ("maidalun/bce-embedding-base_v1", "BCE 双语嵌入（--backend embed）"),
    ("maidalun/bce-reranker-base_v1", "BCE 双语精排（--rerank）"),
]


def main() -> int:
    try:
        from modelscope import snapshot_download
    except Exception:  # noqa: BLE001
        print("[embed-models] 未装 modelscope/sentence-transformers。先跑：\n"
              "  pip install -i https://pypi.tuna.tsinghua.edu.cn/simple "
              "modelscope sentence-transformers", file=sys.stderr)
        return 2
    ok = True
    for model_id, desc in MODELS:
        try:
            path = snapshot_download(model_id)
            print(f"[embed-models] OK  {model_id}  ({desc})\n            -> {path}")
        except Exception as e:  # noqa: BLE001
            ok = False
            print(f"[embed-models] FAIL {model_id}: {e}", file=sys.stderr)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())

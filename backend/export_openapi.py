"""把 FastAPI 的 OpenAPI 契约导出到 docs/api-openapi.json。

用途: docs/api-contracts.md 是人肉维护的说明, 会漂移; 这份 JSON 由代码直接生成,
CI 里跑本脚本后 `git diff --exit-code` 校验——改了接口忘了重新导出会直接红。

运行: cd backend && .venv\\Scripts\\python.exe export_openapi.py
"""
import json
from pathlib import Path

from app.main import app

out = Path(__file__).resolve().parent.parent / "docs" / "api-openapi.json"
out.write_text(
    json.dumps(app.openapi(), ensure_ascii=False, indent=2) + "\n",
    encoding="utf-8",
)
print(f"written: {out}")

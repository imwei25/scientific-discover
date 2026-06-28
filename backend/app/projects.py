"""项目（多工作区）存储层与 FastAPI 路由。

数据布局:
  <DATA_DIR>/projects/<uuid>.json     单项目文件
  <DATA_DIR>/projects/index.json      列表 meta 缓存（崩了能重建）

DATA_DIR 解析顺序:
  1. 环境变量 RA_DATA_DIR (测试/CI 用)
  2. 模块全局 set_data_dir(...) (Tauri 启动时由 main.py 调用)
  3. 默认: backend/data/
"""
from __future__ import annotations

import json
import os
import time
import uuid as uuid_mod
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

MAX_NAME_LEN = 80
MAX_PROJECT_BYTES = 50 * 1024 * 1024  # 50 MB


class PayloadTooLarge(Exception):
    pass


# ── DATA_DIR 解析 ────────────────────────────────────────────
_explicit_data_dir: Optional[Path] = None


def set_data_dir(p: Path | str) -> None:
    """由 main.py 在启动时调用（生产路径来自 Tauri）。"""
    global _explicit_data_dir
    _explicit_data_dir = Path(p)
    _reset_for_tests()


def _data_dir() -> Path:
    env = os.environ.get("RA_DATA_DIR")
    if env:
        return Path(env)
    if _explicit_data_dir is not None:
        return _explicit_data_dir
    return Path(__file__).resolve().parent.parent / "data"


def _projects_dir() -> Path:
    d = _data_dir() / "projects"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _index_path() -> Path:
    return _projects_dir() / "index.json"


def _project_path(pid: str) -> Path:
    return _projects_dir() / f"{pid}.json"


# ── index 缓存 ───────────────────────────────────────────────
_index_cache: Optional[list[dict[str, Any]]] = None


def _reset_for_tests() -> None:
    """测试 fixture 用; 切 RA_DATA_DIR 后必须重置。"""
    global _index_cache
    _index_cache = None


def _load_index() -> list[dict[str, Any]]:
    global _index_cache
    if _index_cache is not None:
        return _index_cache
    path = _index_path()
    if path.exists():
        try:
            _index_cache = json.loads(path.read_text(encoding="utf-8"))
            return _index_cache
        except (json.JSONDecodeError, OSError):
            pass  # 损坏 → 走重建
    # 重建: 扫描 *.json 文件
    rebuilt: list[dict[str, Any]] = []
    for f in _projects_dir().glob("*.json"):
        if f.name == "index.json":
            continue
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
            rebuilt.append({
                "id": data["id"],
                "name": data["name"],
                "updated_at": data["updated_at"],
            })
        except (json.JSONDecodeError, KeyError, OSError):
            continue
    _index_cache = rebuilt
    _save_index()
    return _index_cache


def _save_index() -> None:
    if _index_cache is None:
        return
    _atomic_write(_index_path(), _index_cache)


def _upsert_index(meta: dict[str, Any]) -> None:
    idx = _load_index()
    idx = [x for x in idx if x["id"] != meta["id"]]
    idx.append(meta)
    globals()["_index_cache"] = idx
    _save_index()


def _remove_from_index(pid: str) -> None:
    idx = _load_index()
    globals()["_index_cache"] = [x for x in idx if x["id"] != pid]
    _save_index()


# ── 原子写 ───────────────────────────────────────────────────
def _atomic_write(path: Path, data: Any) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    try:
        tmp.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, path)
    except Exception:
        if tmp.exists():
            try:
                tmp.unlink()
            except OSError:
                pass
        raise


# ── 名字清洗 / id 校验 ───────────────────────────────────────
def _clean_name(name: str) -> str:
    s = (name or "").strip()
    if len(s) > MAX_NAME_LEN:
        s = s[:MAX_NAME_LEN]
    return s


def _validate_uuid(pid: str) -> None:
    try:
        uuid_mod.UUID(pid)
    except (ValueError, AttributeError, TypeError) as e:
        raise ValueError(f"invalid uuid: {pid!r}") from e


# ── 公共 API ─────────────────────────────────────────────────
def create_project(id: str, name: str) -> dict[str, Any]:
    _validate_uuid(id)
    if _project_path(id).exists():
        raise ValueError(f"project {id} already exists")
    now = int(time.time() * 1000)
    project = {
        "id": id,
        "name": _clean_name(name) or "未命名项目",
        "created_at": now,
        "updated_at": now,
        "state": {},
        "history": [],
    }
    _atomic_write(_project_path(id), project)
    _upsert_index({"id": id, "name": project["name"], "updated_at": now})
    return project


def get_project(pid: str) -> Optional[dict[str, Any]]:
    path = _project_path(pid)
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def list_projects() -> list[dict[str, Any]]:
    idx = list(_load_index())
    idx.sort(key=lambda x: x["updated_at"], reverse=True)
    return idx


def update_state(pid: str, state: dict[str, Any], history: list[dict[str, Any]]) -> dict[str, Any]:
    project = get_project(pid)
    if project is None:
        raise KeyError(pid)
    project["state"] = state
    project["history"] = history
    project["updated_at"] = int(time.time() * 1000)
    # 大小预检
    serialized = json.dumps(project, ensure_ascii=False)
    if len(serialized.encode("utf-8")) > MAX_PROJECT_BYTES:
        raise PayloadTooLarge(f"project {pid} exceeds {MAX_PROJECT_BYTES} bytes")
    _atomic_write(_project_path(pid), project)
    _upsert_index({"id": pid, "name": project["name"], "updated_at": project["updated_at"]})
    return {"updated_at": project["updated_at"]}


def rename_project(pid: str, name: str) -> dict[str, Any]:
    project = get_project(pid)
    if project is None:
        raise KeyError(pid)
    project["name"] = _clean_name(name) or project["name"]
    project["updated_at"] = int(time.time() * 1000)
    _atomic_write(_project_path(pid), project)
    _upsert_index({"id": pid, "name": project["name"], "updated_at": project["updated_at"]})
    return {"id": pid, "name": project["name"], "updated_at": project["updated_at"]}


def delete_project(pid: str) -> bool:
    path = _project_path(pid)
    if not path.exists():
        return False
    path.unlink()
    _remove_from_index(pid)
    return True


# ── FastAPI 路由 ─────────────────────────────────────────────
router = APIRouter(prefix="/api/projects", tags=["projects"])


class CreateBody(BaseModel):
    id: str
    name: str


class UpdateStateBody(BaseModel):
    state: dict[str, Any] = Field(default_factory=dict)
    history: list[dict[str, Any]] = Field(default_factory=list)


class RenameBody(BaseModel):
    name: str


@router.get("")
def route_list() -> list[dict[str, Any]]:
    return list_projects()


@router.post("")
def route_create(body: CreateBody) -> dict[str, Any]:
    try:
        return create_project(id=body.id, name=body.name)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/{pid}")
def route_get(pid: str) -> dict[str, Any]:
    try:
        _validate_uuid(pid)
    except ValueError:
        raise HTTPException(status_code=400, detail=f"invalid project id: {pid!r}")
    p = get_project(pid)
    if p is None:
        raise HTTPException(status_code=404, detail=f"project {pid} not found")
    return p


@router.put("/{pid}/state")
def route_update_state(pid: str, body: UpdateStateBody) -> dict[str, Any]:
    try:
        _validate_uuid(pid)
    except ValueError:
        raise HTTPException(status_code=400, detail=f"invalid project id: {pid!r}")
    try:
        return update_state(pid, state=body.state, history=body.history)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"project {pid} not found")
    except PayloadTooLarge as e:
        raise HTTPException(status_code=413, detail=str(e))


@router.patch("/{pid}")
def route_rename(pid: str, body: RenameBody) -> dict[str, Any]:
    try:
        _validate_uuid(pid)
    except ValueError:
        raise HTTPException(status_code=400, detail=f"invalid project id: {pid!r}")
    try:
        return rename_project(pid, body.name)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"project {pid} not found")


@router.delete("/{pid}", status_code=204, response_model=None)
def route_delete(pid: str) -> None:
    try:
        _validate_uuid(pid)
    except ValueError:
        raise HTTPException(status_code=400, detail=f"invalid project id: {pid!r}")
    if not delete_project(pid):
        raise HTTPException(status_code=404, detail=f"project {pid} not found")

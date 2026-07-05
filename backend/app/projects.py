"""项目（多工作区）存储层与 FastAPI 路由。

数据布局:
  <DATA_DIR>/projects/<uuid>.json     单项目文件
  <DATA_DIR>/projects/index.json      列表 meta 缓存（崩了能重建）

DATA_DIR 解析顺序:
  1. 环境变量 RA_DATA_DIR (测试/CI 用)
  2. 模块全局 set_data_dir(...) (可选覆盖)
  3. 打包态(PyInstaller, sys.frozen): 用户配置目录(%APPDATA%\\科研助手\\data)。
     绝不能落在 __file__ 相对路径——onefile 下那是每次退出即删的 _MEI 临时解压目录,
     项目数据会随进程结束整个丢失。
  4. 开发态默认: backend/data/
"""
from __future__ import annotations

import json
import os
import re
import sys
import time
import uuid as uuid_mod
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Request
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
    if getattr(sys, "frozen", False):
        from .config import _user_config_dir
        return _user_config_dir() / "data"
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
    # tmp 加进程 pid + 随机后缀, 避免两个并发写同一 pid 时抢同一个 .tmp 文件 (Windows 上会
    # PermissionError / FileExistsError, 之前 20 并发 PUT /api/projects/{pid}/state 稳定 500).
    tmp = path.with_suffix(f"{path.suffix}.{os.getpid()}.{uuid_mod.uuid4().hex[:8]}.tmp")
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
_CTRL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")  # 控制字符, 保留 \t\n\r


def _clean_name(name: str) -> str:
    s = (name or "")
    # 剥离控制字符 (NUL / SOH / 等), 折叠内嵌换行为空格; 否则会污染 index.json 与前端渲染
    s = _CTRL_RE.sub("", s)
    s = re.sub(r"\s+", " ", s).strip()
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
        raise ValueError(f"该项目 id 已存在: {id}")
    cleaned = _clean_name(name)
    # 空 name 现在明确拒绝, 而不是静默变成 "未命名项目" (用户不知道自己起的名没生效)
    if not cleaned:
        raise ValueError("项目名不能为空。")
    now = int(time.time() * 1000)
    project = {
        "id": id,
        "name": cleaned,
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
    raw = path.read_text(encoding="utf-8")
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        # 项目文件已损坏 (常见于旧版并发写入产生的 tmp 合并事故). 尝试截到最后一个平衡的 }
        # 若截取后仍无法解析则视为不存在, 让 route 返回 404 而不是 500.
        stack = 0
        last_close = -1
        for i, ch in enumerate(raw):
            if ch == "{":
                stack += 1
            elif ch == "}":
                stack -= 1
                if stack == 0:
                    last_close = i
                    break
        if last_close >= 0:
            try:
                return json.loads(raw[: last_close + 1])
            except json.JSONDecodeError:
                pass
        print(f"[projects] 项目文件损坏, 视为不存在: {path.name}", flush=True)
        return None


def list_projects() -> list[dict[str, Any]]:
    idx = list(_load_index())
    # 过滤幽灵条目: 索引里有但磁盘上项目文件已丢失 (旧版并发写留下的孤儿).
    # 顺手把幽灵从缓存里踢掉并回写 index.json, 避免下次重启前一直挂着.
    alive: list[dict[str, Any]] = []
    dropped: list[str] = []
    for m in idx:
        if _project_path(m["id"]).exists():
            alive.append(m)
        else:
            dropped.append(m["id"])
    if dropped:
        globals()["_index_cache"] = list(alive)
        try:
            _save_index()
        except Exception:  # noqa: BLE001
            pass
        print(f"[projects] 清理 {len(dropped)} 条幽灵索引: {dropped}", flush=True)
    alive.sort(key=lambda x: x["updated_at"], reverse=True)
    return alive


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
    cleaned = _clean_name(name)
    # 空/纯空白 rename 拒绝, 避免"改名成功"提示但名字未变的迷惑 UX
    if not cleaned:
        raise ValueError("项目名不能为空。")
    project["name"] = cleaned
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


def _require_localhost(request: "Request") -> None:
    """所有修改类接口只允许 127.0.0.1 调用. 局域网模式 (HOST=0.0.0.0) 下,
    任何同网段用户都能删项目/覆写 state, 加此闸门堵住 CSRF + LAN 侧攻击面.
    (R19 P0 安全审计). "testclient" 是 fastapi TestClient 的默认 host, 放行以便测试."""
    client = request.client
    host = (client.host if client else "") or ""
    if host not in {"127.0.0.1", "::1", "localhost", "testclient"}:
        raise HTTPException(status_code=403, detail="该接口仅允许本机访问")


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
def route_create(body: CreateBody, request: Request) -> dict[str, Any]:
    _require_localhost(request)
    try:
        return create_project(id=body.id, name=body.name)
    except ValueError as e:
        # create_project 抛的 ValueError 已经是中文 (R10 修复)
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/{pid}")
def route_get(pid: str) -> dict[str, Any]:
    try:
        _validate_uuid(pid)
    except ValueError:
        raise HTTPException(status_code=400, detail=f"项目 id 格式不正确: {pid}")
    p = get_project(pid)
    if p is None:
        raise HTTPException(status_code=404, detail=f"项目 {pid} 不存在或已删除")
    return p


@router.put("/{pid}/state")
def route_update_state(pid: str, body: UpdateStateBody, request: Request) -> dict[str, Any]:
    _require_localhost(request)
    try:
        _validate_uuid(pid)
    except ValueError:
        raise HTTPException(status_code=400, detail=f"项目 id 格式不正确: {pid}")
    try:
        return update_state(pid, state=body.state, history=body.history)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"项目 {pid} 不存在或已删除")
    except PayloadTooLarge as e:
        raise HTTPException(status_code=413, detail=f"项目数据过大: {e}")


@router.patch("/{pid}")
def route_rename(pid: str, body: RenameBody, request: Request) -> dict[str, Any]:
    _require_localhost(request)
    try:
        _validate_uuid(pid)
    except ValueError:
        raise HTTPException(status_code=400, detail=f"项目 id 格式不正确: {pid}")
    try:
        return rename_project(pid, body.name)
    except ValueError as e:
        # rename_project 抛的 ValueError 已中文 (R10)
        raise HTTPException(status_code=400, detail=str(e))
    except KeyError:
        raise HTTPException(status_code=404, detail=f"项目 {pid} 不存在或已删除")


@router.delete("/{pid}", status_code=204, response_model=None)
def route_delete(pid: str, request: Request) -> None:
    _require_localhost(request)
    try:
        _validate_uuid(pid)
    except ValueError:
        raise HTTPException(status_code=400, detail=f"项目 id 格式不正确: {pid}")
    if not delete_project(pid):
        raise HTTPException(status_code=404, detail=f"项目 {pid} 不存在或已删除")

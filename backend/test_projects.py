"""项目存储层测试 - 纯文件 IO, 不涉及 FastAPI。

运行: python test_projects.py  (或 pytest test_projects.py -v)
"""
import json
import os
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import projects


@pytest.fixture
def tmp_data(tmp_path, monkeypatch):
    """每个测试一份独立的 data 目录，避免相互污染。"""
    monkeypatch.setenv("RA_DATA_DIR", str(tmp_path))
    # projects 模块用环境变量解析目录；重置内部缓存
    projects._reset_for_tests()
    return tmp_path


def test_create_get_delete(tmp_data):
    p = projects.create_project(id="11111111-1111-1111-1111-111111111111", name="A")
    assert p["id"] == "11111111-1111-1111-1111-111111111111"
    assert p["name"] == "A"
    assert p["state"] == {}
    assert p["history"] == []

    got = projects.get_project(p["id"])
    assert got["name"] == "A"

    projects.delete_project(p["id"])
    assert projects.get_project(p["id"]) is None


def test_list_sorted_by_updated_at(tmp_data):
    a = projects.create_project(id="a" * 8 + "-" + "a" * 4 + "-" + "a" * 4 + "-" + "a" * 4 + "-" + "a" * 12, name="A")
    time.sleep(0.02)
    b = projects.create_project(id="b" * 8 + "-" + "b" * 4 + "-" + "b" * 4 + "-" + "b" * 4 + "-" + "b" * 12, name="B")
    items = projects.list_projects()
    assert [x["id"] for x in items] == [b["id"], a["id"]]
    # 只返回 meta, 不含 state/history
    assert "state" not in items[0]
    assert "history" not in items[0]


def test_update_state_changes_updated_at(tmp_data):
    p = projects.create_project(id="cccccccc-cccc-cccc-cccc-cccccccccccc", name="X")
    t0 = p["updated_at"]
    time.sleep(0.02)
    res = projects.update_state(p["id"], state={"idea:field": "x"}, history=[])
    assert res["updated_at"] > t0
    got = projects.get_project(p["id"])
    assert got["state"]["idea:field"] == "x"


def test_rename(tmp_data):
    p = projects.create_project(id="dddddddd-dddd-dddd-dddd-dddddddddddd", name="Old")
    projects.rename_project(p["id"], "New")
    assert projects.get_project(p["id"])["name"] == "New"


def test_name_trim_and_limit(tmp_data):
    p = projects.create_project(id="eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee", name="  hello  ")
    assert p["name"] == "hello"
    long_name = "x" * 200
    p2 = projects.create_project(id="ffffffff-ffff-ffff-ffff-ffffffffffff", name=long_name)
    assert len(p2["name"]) == 80


def test_payload_too_large(tmp_data):
    p = projects.create_project(id="11112222-3333-4444-5555-666677778888", name="big")
    big_state = {"k": "x" * (60 * 1024 * 1024)}  # ~60 MB
    with pytest.raises(projects.PayloadTooLarge):
        projects.update_state(p["id"], state=big_state, history=[])


def test_atomic_write_no_partial_file(tmp_data, monkeypatch):
    p = projects.create_project(id="22223333-4444-5555-6666-777788889999", name="atom")
    # 模拟 rename 抛异常: 临时文件应被清理, 原文件保持旧内容
    original_state = projects.get_project(p["id"])["state"]

    # 使用一个会抛异常的 replace 替代品，但要保留对原始 replace 的引用
    import os as os_module
    original_replace = os_module.replace

    def failing_replace(*a, **kw):
        raise OSError("disk full")

    monkeypatch.setattr("os.replace", failing_replace)

    with pytest.raises(OSError):
        projects.update_state(p["id"], state={"idea:field": "broken"}, history=[])

    # 恢复 replace，然后检查原文件
    monkeypatch.setattr("os.replace", original_replace)
    projects._reset_for_tests()  # 重置缓存，强制重读文件

    again = projects.get_project(p["id"])
    assert again is not None, "Project file was deleted or corrupted"
    assert again["state"] == original_state

    # 临时文件不存在
    tmpfiles = list((tmp_data / "projects").glob("*.json.tmp"))
    assert tmpfiles == []


def test_index_rebuild_when_missing(tmp_data):
    p1 = projects.create_project(id="33334444-5555-6666-7777-888899990000", name="P1")
    p2 = projects.create_project(id="44445555-6666-7777-8888-999900001111", name="P2")
    # 删掉 index, 重置模块缓存
    (tmp_data / "projects" / "index.json").unlink()
    projects._reset_for_tests()
    items = projects.list_projects()
    ids = {x["id"] for x in items}
    assert ids == {p1["id"], p2["id"]}
    # 重建后 index 应该回来
    assert (tmp_data / "projects" / "index.json").exists()


def test_invalid_uuid_rejected(tmp_data):
    with pytest.raises(ValueError):
        projects.create_project(id="not-a-uuid", name="x")


# ── 路由层测试 ───────────────────────────────────────────────
@pytest.fixture
def client(tmp_data):
    from app.main import app
    return TestClient(app)


def test_route_post_get_list_delete(client):
    pid = "aaaa0000-0000-0000-0000-000000000001"
    r = client.post("/api/projects", json={"id": pid, "name": "T1"})
    assert r.status_code == 200
    assert r.json()["name"] == "T1"

    r = client.get("/api/projects")
    assert r.status_code == 200
    items = r.json()
    assert any(x["id"] == pid for x in items)

    r = client.get(f"/api/projects/{pid}")
    assert r.status_code == 200
    assert r.json()["state"] == {}

    r = client.delete(f"/api/projects/{pid}")
    assert r.status_code == 204

    r = client.get(f"/api/projects/{pid}")
    assert r.status_code == 404


def test_route_put_state(client):
    pid = "aaaa0000-0000-0000-0000-000000000002"
    client.post("/api/projects", json={"id": pid, "name": "S"})
    r = client.put(f"/api/projects/{pid}/state", json={"state": {"idea:field": "x"}, "history": []})
    assert r.status_code == 200
    assert "updated_at" in r.json()
    r2 = client.get(f"/api/projects/{pid}")
    assert r2.json()["state"]["idea:field"] == "x"


def test_route_patch_name(client):
    pid = "aaaa0000-0000-0000-0000-000000000003"
    client.post("/api/projects", json={"id": pid, "name": "Old"})
    r = client.patch(f"/api/projects/{pid}", json={"name": "New"})
    assert r.status_code == 200
    assert r.json()["name"] == "New"


def test_route_413_on_oversize(client):
    pid = "aaaa0000-0000-0000-0000-000000000004"
    client.post("/api/projects", json={"id": pid, "name": "big"})
    big = {"k": "x" * (60 * 1024 * 1024)}
    r = client.put(f"/api/projects/{pid}/state", json={"state": big, "history": []})
    assert r.status_code == 413


def test_route_404_on_missing(client):
    r = client.get("/api/projects/aaaa0000-0000-0000-0000-00000000ffff")
    assert r.status_code == 404


def test_route_400_on_invalid_pid(client):
    # Path traversal attempt + non-UUID strings should be rejected before touching the filesystem.
    for bad in ["../etc/passwd", "not-a-uuid", "a/b/c", "../../foo"]:
        r = client.get(f"/api/projects/{bad}")
        assert r.status_code in (400, 404), f"expected 400/404 for {bad!r}, got {r.status_code}"
    # PUT/PATCH/DELETE should also reject invalid pids
    r = client.put("/api/projects/not-a-uuid/state", json={"state": {}, "history": []})
    assert r.status_code == 400
    r = client.patch("/api/projects/not-a-uuid", json={"name": "x"})
    assert r.status_code == 400
    r = client.delete("/api/projects/not-a-uuid")
    assert r.status_code == 400


def test_frozen_data_dir_uses_user_config_dir(monkeypatch):
    """打包态(sys.frozen)下数据目录必须落在用户配置目录, 绝不能落在 __file__ 相对路径。

    PyInstaller --onefile 的 __file__ 在 _MEI 临时解压目录里, 进程退出即删——
    若落在那里, 用户项目数据每次关应用就整个丢失(回归保护)。
    """
    import sys as _sys

    monkeypatch.delenv("RA_DATA_DIR", raising=False)
    monkeypatch.setattr(projects, "_explicit_data_dir", None)
    monkeypatch.setattr(_sys, "frozen", True, raising=False)
    d = projects._data_dir()
    from app.config import _user_config_dir

    assert d == _user_config_dir() / "data"
    # 兜底路径与 backend 源码目录无关
    assert Path(__file__).resolve().parent not in d.parents


def test_dev_data_dir_stays_in_backend(monkeypatch):
    """开发态(非 frozen)保持历史行为: backend/data。"""
    import sys as _sys

    monkeypatch.delenv("RA_DATA_DIR", raising=False)
    monkeypatch.setattr(projects, "_explicit_data_dir", None)
    monkeypatch.setattr(_sys, "frozen", False, raising=False)
    assert projects._data_dir() == Path(__file__).resolve().parent / "data"


if __name__ == "__main__":
    import sys
    sys.exit(pytest.main([__file__, "-v"]))

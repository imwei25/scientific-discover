"""项目存储层测试 - 纯文件 IO, 不涉及 FastAPI。

运行: python test_projects.py  (或 pytest test_projects.py -v)
"""
import json
import os
import time
from pathlib import Path

import pytest

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


if __name__ == "__main__":
    import sys
    sys.exit(pytest.main([__file__, "-v"]))

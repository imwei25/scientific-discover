"""随机化分组表生成（确定性，零额度）。

每个 RCT 都需要可复现的随机分配序列。支持简单随机与置换区组随机，
用固定种子保证可复现（同种子→同序列），导出供方案/统计计划与执行使用。

对外: generate(params) -> {"ok", "rows", "counts", "method", "block_size"} 或 {"ok": False, "error"}。
"""
from __future__ import annotations

import random


def generate(params: dict) -> dict:
    try:
        n = int(params.get("n") or 0)
    except (ValueError, TypeError):
        return {"ok": False, "error": "样本量 n 必须是整数。"}
    if not (1 <= n <= 100000):
        return {"ok": False, "error": "样本量 n 需在 1–100000 之间。"}

    groups = [g.strip() for g in str(params.get("groups") or "试验组,对照组").split(",") if g.strip()]
    if len(groups) < 2:
        return {"ok": False, "error": "至少需要两个分组（用逗号分隔）。"}
    if len(set(groups)) != len(groups):
        return {"ok": False, "error": "分组名称不能重复。"}

    ratio_raw = str(params.get("ratio") or "").strip()
    if ratio_raw:
        try:
            ratio = [int(x) for x in ratio_raw.split(",")]
        except ValueError:
            return {"ok": False, "error": "分配比例必须是整数（如 1,1 或 2,1）。"}
        if len(ratio) != len(groups) or any(r <= 0 for r in ratio):
            return {"ok": False, "error": "分配比例数量需与分组一致且为正整数。"}
    else:
        ratio = [1] * len(groups)

    method = (params.get("method") or "block").strip()
    try:
        seed = int(params.get("seed") or 0)
    except (ValueError, TypeError):
        seed = 0
    rng = random.Random(seed)
    unit = sum(ratio)

    seq: list[str] = []
    block_size = None
    if method == "simple":
        for _ in range(n):
            seq.append(rng.choices(groups, weights=ratio, k=1)[0])
    else:  # 置换区组随机
        try:
            bs = int(params.get("block_size") or unit * 2)
        except (ValueError, TypeError):
            bs = unit * 2
        if bs % unit != 0:
            bs = unit * max(1, round(bs / unit))   # 取整为单位的整数倍
        bs = max(bs, unit)                          # 防 0/负 区组大小导致 base 为空→死循环
        per = bs // unit
        base: list[str] = []
        for g, r in zip(groups, ratio):
            base += [g] * (r * per)
        while len(seq) < n:
            blk = base[:]
            rng.shuffle(blk)
            seq += blk
        seq = seq[:n]
        block_size = bs

    rows = [{"seq": i + 1, "group": seq[i]} for i in range(n)]
    counts = {g: seq.count(g) for g in groups}
    return {"ok": True, "rows": rows, "counts": counts, "method": method, "block_size": block_size, "seed": seed}

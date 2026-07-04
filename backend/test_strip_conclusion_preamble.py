"""结论前置裁剪回归。运行: .venv\\Scripts\\python.exe test_strip_conclusion_preamble.py"""
import asyncio, sys
import app.dataanalysis as da


async def _drive(pieces):
    async def gen():
        for p in pieces:
            yield p
    out = []
    async for piece in da._strip_conclusion_preamble_stream(gen()):
        out.append(piece)
    return "".join(out)


def main():
    ok, fail = 0, 0

    # 1. 正常带开场白 → 裁掉
    r = asyncio.run(_drive(["好的,我为您总结如下。\n", "## 核心发现\n", "p=0.003"]))
    if r == "## 核心发现\np=0.003":
        print("PASS 裁掉开场白"); ok += 1
    else:
        print("FAIL 裁掉开场白:", repr(r)); fail += 1

    # 2. `##` 跨 chunk 拆开
    r = asyncio.run(_drive(["前言 ", "#", "# 核心发现", "\np=0.5"]))
    if r == "## 核心发现\np=0.5":
        print("PASS 跨 chunk"); ok += 1
    else:
        print("FAIL 跨 chunk:", repr(r)); fail += 1

    # 3. 全程无 `##` → 兜底原样送出
    r = asyncio.run(_drive(["核心发现: p=0.003", " 局限: 小样本"]))
    if r == "核心发现: p=0.003 局限: 小样本":
        print("PASS 兜底"); ok += 1
    else:
        print("FAIL 兜底:", repr(r)); fail += 1

    # 4. 首个 chunk 就以 `##` 开头 → 全部转发
    r = asyncio.run(_drive(["## 核心发现\n", "p=0.01"]))
    if r == "## 核心发现\np=0.01":
        print("PASS 首块即 ##"); ok += 1
    else:
        print("FAIL 首块即 ##:", repr(r)); fail += 1

    # 5. 空流 → 空字符串
    r = asyncio.run(_drive([]))
    if r == "":
        print("PASS 空流"); ok += 1
    else:
        print("FAIL 空流:", repr(r)); fail += 1

    print(f"\nRESULT: {ok} passed, {fail} failed")
    sys.exit(0 if fail == 0 else 1)


if __name__ == "__main__":
    main()

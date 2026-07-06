"""标书分节流的 preamble/字数标注裁剪回归。
运行: .venv\\Scripts\\python.exe test_strip_grant_preamble.py"""
import asyncio, sys
import app.grant as g


async def _drive(pieces):
    async def gen():
        for p in pieces:
            yield p
    out = []
    async for piece in g._clean_section_stream(gen()):
        out.append(piece)
    return "".join(out)


def _chunk(s, n=17):
    """把整段切成小块, 模拟 SSE 流式分片。"""
    return [s[i:i + n] for i in range(0, len(s), n)]


BODY = (
    "本项目面向XX领域的关键科学问题, 拟通过系统的实验与建模, 阐明其内在机制。"
    "研究表明该方向具有重要的理论与应用价值[1], 现有工作尚存在明显空白。"
    "为此我们设计了三条相互印证的技术路线, 并已具备相应的前期基础与工作条件。"
    "预期成果将为后续研究提供可靠支撑, 具有良好的推广前景与显著的社会效益。"
)  # 足够长, 触发非 probing 分支


def main():
    ok = fail = 0

    def check(name, got, want):
        nonlocal ok, fail
        if got == want:
            print("PASS", name); ok += 1
        else:
            print("FAIL", name, "\n  got :", repr(got), "\n  want:", repr(want)); fail += 1

    # 1. 长章节 + 前置说明句 + 结尾字数 → 两头都裁掉
    src = "以下是根据您提供的材料撰写的《立项依据》章节内容：\n\n" + BODY + "（总字数：798字）"
    check("长章节·preamble+总字数", asyncio.run(_drive(_chunk(src))), BODY)

    # 2. 用户报告的原样: “以下是第一章…” + 结尾 “共xx字”
    src = "以下是第一章立项依据的正文：\n" + BODY + "\n\n共798字"
    check("以下是第一章+共798字", asyncio.run(_drive(_chunk(src))), BODY)

    # 3. “好的，下面是…如下：” 开场
    src = "好的，下面是本章节内容如下：\n" + BODY + " 全文约800字。"
    check("好的下面是+全文约800字", asyncio.run(_drive(_chunk(src))), BODY)

    # 4. 结尾字数带括号并独占一行
    src = BODY + "\n\n（字数：798）"
    check("尾部括号字数独占行", asyncio.run(_drive(_chunk(src))), BODY)

    # 5. 干净正文, 无 meta → 原样(仅去尾部空白)
    check("干净正文原样", asyncio.run(_drive(_chunk(BODY))), BODY)

    # 6. 短章节(<200字) + preamble + 字数
    short = "本章简述研究基础与队伍构成, 条件完备。"
    src = "以下是内容：\n" + short + "（共30字）"
    check("短章节·probing 分支", asyncio.run(_drive([src])), short)

    # 7. 正文里合法出现“共...字样”不应被误删(非结尾)
    body2 = "研究共分三个阶段推进" + BODY
    check("正文中间含共字不误删", asyncio.run(_drive(_chunk(body2))), body2)

    # 8. 空流
    check("空流", asyncio.run(_drive([])), "")

    print(f"\nRESULT: {ok} passed, {fail} failed")
    sys.exit(0 if fail == 0 else 1)


if __name__ == "__main__":
    main()

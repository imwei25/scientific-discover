"""LLM-as-judge 质量评测轨道(离线、按需运行, 不做硬门禁)。

参考调研: 用样例输入跑真实模块产出, 再用 LLM 作为评审按标准打分(1-5)。
这是质量趋势观测工具, 不是 CI 门禁(LLM 评分有主观性, 仅供参考)。

用法:
  python eval_suite.py mock   # 验证评测流程本身(不花额度)
  python eval_suite.py real   # 真实评测(消耗少量额度)
"""
from __future__ import annotations

import asyncio
import json
import sys

from app import config
from app.prompts import build_messages


async def _gen(messages: list[dict], max_tokens: int = 1200) -> str:
    from app.llm import stream_chat

    buf = ""
    async for piece in stream_chat(messages, max_tokens=max_tokens):
        buf += piece
    return buf


async def judge(task: str, output: str, criteria: str, reference: str = "") -> dict:
    from app.llm import stream_chat

    system = (
        "你是严格的科研内容评审。针对【任务】【模型输出】【评分标准】，给出 1-5 的整数评分"
        "（5=优秀，1=很差）并用一句话说明理由。若提供了【输入/参考事实】，请据此判断输出是否忠实、"
        "有无编造。只输出 JSON：{\"score\": 整数, \"rationale\": \"...\"}。"
    )
    ref_block = f"\n\n【输入/参考事实】\n{reference[:2000]}" if reference else ""
    user = f"【任务】\n{task}{ref_block}\n\n【评分标准】\n{criteria}\n\n【模型输出】\n{output[:4000]}"
    raw = ""
    async for piece in stream_chat(
        [{"role": "system", "content": system}, {"role": "user", "content": user}], max_tokens=300
    ):
        raw += piece
    s, e = raw.find("{"), raw.rfind("}")
    if s != -1 and e != -1:
        try:
            obj = json.loads(raw[s : e + 1])
            return {"score": int(obj.get("score", 0)), "rationale": str(obj.get("rationale", ""))}
        except Exception:  # noqa: BLE001
            pass
    return {"score": 0, "rationale": f"评审输出无法解析: {raw[:120]}"}


CASES = [
    {
        "name": "实验规划-糖尿病NAFLD",
        "task": "为'评估二甲双胍对2型糖尿病合并NAFLD患者肝纤维化的改善作用'制定研究方案",
        "messages": lambda: build_messages(
            "plan",
            {"idea": "评估二甲双胍对2型糖尿病合并NAFLD患者肝纤维化的改善作用", "field": "内分泌/肝病"},
        ),
        "criteria": "是否包含研究设计类型、入排标准、样本量/检验效能、统计分析计划、伦理合规；是否具体可行、贴合该临床课题。",
        "reference": "",
    },
    {
        "name": "数据写作-只用给定数字",
        "task": "根据已算好的统计事实撰写结果与讨论",
        "messages": lambda: build_messages(
            "write",
            {
                "facts": "- A组均值=7.5, n=40\n- B组均值=6.0, n=40\n- 两组Welch t检验 p=3.2e-10, Cohen d=1.35",
                "question": "A组与B组疗效是否不同",
            },
        ),
        "criteria": "是否只使用给定的数字、未编造任何新数据；是否区分相关与因果；是否同时给出结果与讨论且语言客观。",
        "reference": "- A组均值=7.5, n=40\n- B组均值=6.0, n=40\n- 两组Welch t检验 p=3.2e-10, Cohen d=1.35",
    },
    {
        "name": "期刊排版-GB7714结构",
        "task": "把稿件按中文核心期刊(GB/T 7714)结构重排",
        "messages": lambda: build_messages(
            "format",
            {
                "manuscript": "标题：某药疗效观察。我们纳入80例患者，随机分两组……结果显示治疗组有效率更高。参考文献：张三. 某研究. 中华医学杂志, 2020.",
                "journal_id": "general_cn",
            },
        ),
        "criteria": "是否按中文论文结构(摘要/关键词/引言/方法/结果/讨论/参考文献)重排；是否附【格式变更说明】；是否未编造原文不存在的内容。",
        "reference": "标题：某药疗效观察。我们纳入80例患者，随机分两组……结果显示治疗组有效率更高。参考文献：张三. 某研究. 中华医学杂志, 2020.",
    },
]


async def main(mode: str) -> None:
    config.settings.mock = mode == "mock"
    print(f"=== LLM-as-judge 评测 (mode={mode}, mock={config.settings.mock}) ===\n")
    scores = []
    for c in CASES:
        output = await _gen(c["messages"]())
        verdict = await judge(c["task"], output, c["criteria"], c.get("reference", ""))
        scores.append(verdict["score"])
        print(f"[{c['name']}] 评分: {verdict['score']}/5")
        print(f"  理由: {verdict['rationale']}")
        print(f"  产出长度: {len(output)} 字\n")
    valid = [s for s in scores if s > 0]
    if valid:
        print(f"平均分: {sum(valid) / len(valid):.2f}/5（{len(valid)}/{len(CASES)} 个用例成功评分）")


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1] if len(sys.argv) > 1 else "mock"))

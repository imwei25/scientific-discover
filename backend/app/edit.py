"""AI 精修: 对已生成的文档做【精准局部修改】, 而非重写全文。

两种用法:
  1) 选段精修: 用户在文档里选中一段原文(selection), 给出修改意见, 只重写这一段;
     返回 {find: 选中原文, replace: 改后文本}, 前端按代码执行替换、把改动处标黄、可撤回。
  2) 整体意见: 用户不选段、直接提修改意见; 让 LLM 给出若干处【最小化的 find/replace 补丁】,
     每处 find 必须逐字取自原文, 前端逐条替换并标黄。

护城河(沿用本项目理念):
  - 只做用户要求的改动, 不擅自扩写/重排全篇; 每个 find 必须能在原文里精确定位。
  - 涉及文献引用时, 只能用给定的【真实文献】链接, 严禁编造(复用支持句规则)。
返回结构统一为 {"edits": [{"find","replace","note"}], "mode": "selection|global", "note": "..."}。
"""
from __future__ import annotations

import json

from .llm import stream_chat
from .logutil import log_swallow
from .research import _QUOTE_RULE

# 单次精修最多返回的补丁数(整体意见模式), 防止一次改动面过大失控。
_MAX_EDITS = 12


async def _complete(messages: list[dict], max_tokens: int = 1500) -> str:
    buf = ""
    async for piece in stream_chat(messages, task="edit", max_tokens=max_tokens):
        buf += piece
    return buf


def _parse_json(raw: str, opener: str, closer: str):
    s, e = raw.find(opener), raw.rfind(closer)
    if s == -1 or e == -1:
        return None
    try:
        return json.loads(raw[s : e + 1])
    except Exception as exc:  # noqa: BLE001
        log_swallow("AI 精修: LLM 输出无法解析为 JSON", exc)
        return None


def _refs_block(refs: list[dict], cap: int = 24) -> str:
    """把文献池拼成带链接的编号上下文, 供精修时据实引用(需要动到引用时)。"""
    lines = []
    for i, r in enumerate(refs[:cap], 1):
        if not isinstance(r, dict):
            continue
        line = (
            f"[{i}] {r.get('first_author', '')} ({r.get('year', '')}). {r.get('title', '')} "
            f"{r.get('journal', '')}. URL: {r.get('url', '')}"
        )
        ab = (r.get("abstract") or "").strip()
        if ab:
            line += f"\n    摘要(节选): {ab[:300]}"
        lines.append(line)
    return "\n".join(lines)


async def _selection_edit(
    text: str, selection: str, instruction: str, refs_ctx: str
) -> dict:
    """选段精修: 只重写选中的这一段, find 固定为原选中文本。"""
    system = (
        "你是资深中文科研写作编辑, 正在对一份文档做【局部精修】。"
        "用户选中了文档中的一段文字, 并给出修改意见。请只输出【修改后的这一段文字】本身——"
        "不要复述其它部分、不要加解释、不要加引号或代码块包裹。\n"
        "要求:\n"
        "1) 严格按用户意见改写选中段落; 保持与上下文风格、语体、Markdown 格式一致(该是链接/表格/列表仍是);\n"
        "2) 若涉及文献引用, 只能引用下面【可引用的真实文献】中确有的文献, 严禁编造链接; " + _QUOTE_RULE + "\n"
        "3) 篇幅与原段相当(除非用户明确要求增删); 不要顺带改动用户没提到的内容。"
    )
    user = (
        f"【全文(仅供理解上下文, 不要整体重写)】\n{text[:6000]}\n\n"
        f"【选中的待修改段落(原文)】\n{selection}\n\n"
        f"【用户的修改意见】\n{instruction}\n\n"
        f"【可引用的真实文献】\n{refs_ctx or '（无, 如需引用请勿编造链接）'}"
    )
    replace = (await _complete([{"role": "system", "content": system}, {"role": "user", "content": user}])).strip()
    # 去掉模型可能误加的代码块围栏
    if replace.startswith("```"):
        replace = replace.strip("`")
        nl = replace.find("\n")
        if nl != -1:
            replace = replace[nl + 1 :]
        replace = replace.strip()
    if not replace or replace == selection:
        return {"edits": [], "mode": "selection", "note": "未产生有效改动。"}
    return {
        "edits": [{"find": selection, "replace": replace, "note": "按意见改写选中段落"}],
        "mode": "selection",
        "note": "",
    }


async def _global_edit(text: str, instruction: str, refs_ctx: str) -> dict:
    """整体意见精修: 让 LLM 给出若干处最小化 find/replace 补丁, find 逐字取自原文。"""
    system = (
        "你是资深中文科研写作编辑, 正在对一份文档做【精准局部修改】, 不重写全文。"
        "根据用户的修改意见, 找出文档里【需要改动的具体位置】, 给出最小化的替换补丁。\n"
        "只输出一个 JSON 对象: {\"edits\":[{\"find\":\"...\",\"replace\":\"...\",\"note\":\"一句话说明改了什么\"}]}，"
        "不要任何解释。规则:\n"
        "1) find 必须是从【原文】里【逐字复制】的一段连续文本(含标点/换行), 要足够长且唯一, 能在原文精确定位;"
        " 严禁改写 find, 否则无法替换;\n"
        "2) replace 是该处改后的文本; 只改真正需要动的地方, 不要把没提到的内容也改了;\n"
        f"3) 补丁数控制在 {_MAX_EDITS} 处以内, 优先改动最关键的位置;\n"
        "4) 若涉及文献引用, 只能用下面【可引用的真实文献】中确有的文献, 严禁编造链接; " + _QUOTE_RULE + "\n"
        "5) 若用户意见无需改动或无法定位, 返回 {\"edits\":[]}。"
    )
    user = (
        f"【原文】\n{text[:9000]}\n\n"
        f"【用户的修改意见】\n{instruction}\n\n"
        f"【可引用的真实文献】\n{refs_ctx or '（无, 如需引用请勿编造链接）'}"
    )
    obj = _parse_json(await _complete([{"role": "system", "content": system}, {"role": "user", "content": user}], max_tokens=2200), "{", "}")
    edits: list[dict] = []
    if isinstance(obj, dict):
        for it in obj.get("edits") or []:
            if not isinstance(it, dict):
                continue
            find = str(it.get("find") or "")
            replace = str(it.get("replace") or "")
            if find and replace != find:
                edits.append({"find": find, "replace": replace, "note": str(it.get("note") or "").strip()[:120]})
            if len(edits) >= _MAX_EDITS:
                break
    return {"edits": edits, "mode": "global", "note": ""}


def _validate(text: str, out: dict) -> dict:
    """服务端校验: find 必须真的能在原文里定位(逐字子串), 丢弃无法定位的补丁并计数。"""
    valid, invalid = [], 0
    for e in out.get("edits", []):
        if e.get("find") and e["find"] in text:
            valid.append(e)
        else:
            invalid += 1
    out["edits"] = valid
    if invalid:
        note = out.get("note") or ""
        out["note"] = (note + f" 有 {invalid} 处未能在原文精确定位, 已跳过。").strip()
    return out


async def surgical_edit(inputs: dict) -> dict:
    """AI 精修入口。inputs: {text, instruction, selection?, references?}。返回 {edits, mode, note}。"""
    text = str(inputs.get("text") or "")
    instruction = str(inputs.get("instruction") or "").strip()
    selection = str(inputs.get("selection") or "")
    refs = inputs.get("references") or inputs.get("refs") or []
    if not isinstance(refs, list):
        refs = []

    if not text.strip():
        return {"edits": [], "mode": "none", "note": "没有可修改的正文。"}
    if not instruction:
        return {"edits": [], "mode": "none", "note": "请填写修改意见。"}

    refs_ctx = _refs_block(refs)
    # 选段模式: selection 非空且确实在原文里, 才走局部重写; 否则退回整体意见。
    if selection.strip() and selection in text:
        out = await _selection_edit(text, selection, instruction, refs_ctx)
    else:
        out = await _global_edit(text, instruction, refs_ctx)
    return _validate(text, out)

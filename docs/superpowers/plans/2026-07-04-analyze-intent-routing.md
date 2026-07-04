# 数据分析:意图分流与结论净化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让"只画图"和"数据分析"走两条不同的后端流水线;分析路径把三大透明化区块从结论区剥出、默认折叠,结论区只留三段并去开场白。

**Architecture:** 端到端小改:后端加两条新流水线(`draw_chart` / `refine_draw`)、一个 stdout 切分工具、一个结论 delta 前置裁剪器,并在两条路由增加 `mode` 字段分发。前端加常驻单选按钮 + 4 个折叠 chip,`AnalyzeHandlers` 扩展一个 `onTransparency` 回调。设计文档:`docs/superpowers/specs/2026-07-04-analyze-intent-routing-design.md`。

**Tech Stack:** Python 3 / FastAPI / asyncio(后端);React + TypeScript / Vite(前端);pytest 风格但项目实际用**脚本式 unittest**(`python test_xxx.py`,monkey-patch `da._execute`、`da.stream_chat` 等)。

---

## File Structure

**Backend**
- Create `backend/test_split_transparency.py` — `_split_transparency()` 的鲁棒单元测试(格式变体覆盖)
- Create `backend/test_strip_conclusion_preamble.py` — 结论 delta 前置裁剪函数测试
- Create `backend/test_draw_chart.py` — draw 流水线事件契约测试(mock LLM/执行)
- Create `backend/test_refine_draw.py` — draw refine 流水线事件契约测试
- Create `backend/test_analyze_transparency_events.py` — analyze/refine 集成后是否正确切分并发出 4 个事件
- Modify `backend/app/dataanalysis.py`:
  - 新增 `_split_transparency()`、`_strip_conclusion_preamble_stream()`、`_gen_draw_messages()`、`_refine_draw_messages()`、`draw_chart()`、`refine_draw()`
  - 改写 `_conclusion_messages()` 系统提示
  - 改 `analyze_data()` 与 `refine_analysis()` 里 stdout 推送段 + 结论 delta 前置裁剪
- Modify `backend/app/routes/analysis_routes.py` — `/api/analyze` 和 `/api/analyze/refine` 加 `mode` 字段并按 mode 分发

**Frontend**
- Modify `frontend/src/lib/sse.ts` — `AnalyzeHandlers` 加 `onTransparency`;`streamAnalyze`/`streamAnalyzeRefine` 签名增 `mode`;事件分发加 3 个 transparency case
- Modify `frontend/src/modules/analyze/DataPane.tsx` — mode 单选、透明化 state、delta 前置裁剪、refine placeholder 按 mode 变
- Modify `frontend/src/modules/analyze/GeneralResults.tsx` — 顶部 4 个 chip 折叠条;`mode==="draw"` 时只渲染图表

**Build**
- `cd frontend && npm run build`(参见 `MEMORY.md`:后端托管 dist,不 build 用户看不到变化)

---

## Task 1: 后端 · `_split_transparency()` 鲁棒切分工具

**Files:**
- Create: `backend/test_split_transparency.py`
- Modify: `backend/app/dataanalysis.py`(在 `_clip_output` 之后、`_conclusion_messages` 之前加入函数)

- [ ] **Step 1: 写失败的单元测试**

创建 `backend/test_split_transparency.py`:

```python
"""_split_transparency() 鲁棒性回归。运行: .venv\\Scripts\\python.exe test_split_transparency.py"""
import sys
import app.dataanalysis as da


def _check(name, got, expected):
    ok = got == expected
    print(("PASS " if ok else "FAIL ") + name)
    if not ok:
        print("  expected:", expected)
        print("  got     :", got)
    return ok


def main():
    passed = 0
    failed = 0

    # 1. 标准三段(prompt 强制的分隔符)
    stdout = "『【方法选择】』\n用了 t 检验\n『【假设检查】』\nShapiro p=0.3\n『【数据质量】』\n无缺失\n主分析结果 p=0.02"
    r = da._split_transparency(stdout)
    if _check("标准三段/method", r["method"].strip(), "用了 t 检验"): passed += 1
    else: failed += 1
    if _check("标准三段/assumption", r["assumption"].strip(), "Shapiro p=0.3"): passed += 1
    else: failed += 1
    if _check("标准三段/quality", r["quality"].strip(), "无缺失"): passed += 1
    else: failed += 1
    if _check("标准三段/main", r["main"].strip(), "主分析结果 p=0.02"): passed += 1
    else: failed += 1

    # 2. 缺全角括号(『』)
    stdout = "【方法选择】\nA\n【假设检查】\nB\n【数据质量】\nC\nD"
    r = da._split_transparency(stdout)
    if _check("无 『』/method", r["method"].strip(), "A"): passed += 1
    else: failed += 1
    if _check("无 『』/main", r["main"].strip(), "D"): passed += 1
    else: failed += 1

    # 3. markdown 标题包裹
    stdout = "## 方法选择\nX\n## 假设检查\nY\n## 数据质量\nZ\n主结果"
    r = da._split_transparency(stdout)
    if _check("md 标题/method", r["method"].strip(), "X"): passed += 1
    else: failed += 1
    if _check("md 标题/quality", r["quality"].strip(), "Z"): passed += 1
    else: failed += 1

    # 4. 序号 + 缺括号
    stdout = "1. 方法选择:aa\n2. 假设检查:bb\n3. 数据质量:cc\n主 dd"
    r = da._split_transparency(stdout)
    if _check("序号/method", r["method"].strip(), "aa"): passed += 1
    else: failed += 1

    # 5. 顺序颠倒
    stdout = "『【数据质量】』\nQ1\n『【方法选择】』\nM1\n『【假设检查】』\nA1\nMAIN"
    r = da._split_transparency(stdout)
    if _check("乱序/method", r["method"].strip(), "M1"): passed += 1
    else: failed += 1
    if _check("乱序/quality", r["quality"].strip(), "Q1"): passed += 1
    else: failed += 1
    if _check("乱序/main", r["main"].strip(), "MAIN"): passed += 1
    else: failed += 1

    # 6. 只有 2 个 marker(方法选择缺失)
    stdout = "『【假设检查】』\nA\n『【数据质量】』\nQ\nM"
    r = da._split_transparency(stdout)
    if _check("缺 method/method 为空", r["method"], ""): passed += 1
    else: failed += 1
    if _check("缺 method/assumption 有", r["assumption"].strip(), "A"): passed += 1
    else: failed += 1
    if _check("缺 method/main 有", r["main"].strip(), "M"): passed += 1
    else: failed += 1

    # 7. 一个 marker 都没有 → 全落 main
    stdout = "just some raw output\nline 2"
    r = da._split_transparency(stdout)
    if _check("无 marker/method 空", r["method"], ""): passed += 1
    else: failed += 1
    if _check("无 marker/main 全部", r["main"].strip(), "just some raw output\nline 2"): passed += 1
    else: failed += 1

    # 8. 空串
    r = da._split_transparency("")
    if _check("空串/main 空", r["main"], ""): passed += 1
    else: failed += 1

    print(f"\nRESULT: {passed} passed, {failed} failed")
    sys.exit(0 if failed == 0 else 1)


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: 运行验证失败**

Run: `cd backend && .venv\Scripts\python.exe test_split_transparency.py`
Expected: `AttributeError: module 'app.dataanalysis' has no attribute '_split_transparency'`

- [ ] **Step 3: 实现 `_split_transparency()`**

在 `backend/app/dataanalysis.py` 里,`_clip_output()` 之后、`_conclusion_messages()` 之前加入:

```python
# 三个透明化标题的鲁棒匹配。允许:全/半角括号缺失、markdown 标题前缀、行首序号、
# 中英文冒号、前后 --- 或 === 装饰。每个 marker 单独匹配,按出现位置切分,允许乱序。
_TRANSPARENCY_MARKERS: dict[str, "re.Pattern[str]"] = {
    "method": re.compile(
        r"(?:^|\n)[\s>#\-=]*(?:[\d①-⑨][.、\s]+)?[『「]?\s*[【\[]?\s*方法选择\s*[】\]]?\s*[』」]?[\s::]*",
    ),
    "assumption": re.compile(
        r"(?:^|\n)[\s>#\-=]*(?:[\d①-⑨][.、\s]+)?[『「]?\s*[【\[]?\s*假设检查\s*[】\]]?\s*[』」]?[\s::]*",
    ),
    "quality": re.compile(
        r"(?:^|\n)[\s>#\-=]*(?:[\d①-⑨][.、\s]+)?[『「]?\s*[【\[]?\s*数据质量\s*[】\]]?\s*[』」]?[\s::]*",
    ),
}


def _split_transparency(stdout: str) -> dict[str, str]:
    """把三大透明化区块从 stdout 里剥出来。返回 {method, assumption, quality, main}。

    - 每个 marker 取首次匹配位置; 按位置排序; 相邻两 marker 之间是前者内容;
      最后一个 marker 之后是 main; 一个都没匹配到 → 全部落 main。
    - 优雅退化:LLM 输出格式漂移(缺括号 / md 标题 / 序号 / 乱序) 都尽量兜住。
    """
    if not stdout:
        return {"method": "", "assumption": "", "quality": "", "main": ""}

    hits: list[tuple[int, int, str]] = []  # (start, marker_end, name)
    for name, pat in _TRANSPARENCY_MARKERS.items():
        m = pat.search(stdout)
        if m:
            hits.append((m.start(), m.end(), name))
    if not hits:
        return {"method": "", "assumption": "", "quality": "", "main": stdout}

    hits.sort(key=lambda x: x[0])
    result = {"method": "", "assumption": "", "quality": "", "main": ""}
    for i, (_, end, name) in enumerate(hits):
        next_start = hits[i + 1][0] if i + 1 < len(hits) else len(stdout)
        result[name] = stdout[end:next_start].strip("\n")
    # 主分析结果 = 最后一个 marker 之后的内容(与 quality/assumption/method 最靠后者相同段)
    # 上面循环已经把最后一段赋给了对应的 name; 需要把它拿出来作为 main, 该 name 留"标题+空"
    # 但更朴素的语义:main = 最后一个 marker 之后的内容。已在上面赋给了最后 name;
    # 为符合"三个透明化 + 主结果分离"的语义,再单独抽:
    last_end = hits[-1][1]
    result["main"] = stdout[last_end:].strip("\n")
    # 把最后 name 的内容(它其实等于 main)清空,避免重复展示
    last_name = hits[-1][2]
    if result[last_name] == result["main"]:
        result[last_name] = ""
    return result
```

**注意**:如果 stdout 三段都有,最后一段(通常是 `数据质量`)本身就是主结果之前的最后透明化块——它和 main 会分开吗?看 prompt(dataanalysis.py:272-279):
> "『【数据质量】』:...print 每个分析变量的缺失数与处理策略... **之后再 print 主分析结果**"

也就是说三段都出现时,`数据质量` 后面接着就是主结果,没有第 4 个 marker 分割。上面实现里把"最后 marker 后的所有内容"都当 main,同时清空最后 name 的重复——但这样最后 name 就变空了,不符合"quality 区块应该有 quality 内容"。**问题**:切分不精确。

**修正实现**——引入约定:如果最后一段 `数据质量` 里出现 `主分析结果` 之类的分隔线(prompt 里没强制),我们回退。简化的正确做法是:**接受最后一段可能是 main 直接接在最后 marker 后**——三个透明化都短(通常 <500 字),主结果长且是数字/表格,视觉上容易区分。**保底策略**:把最后一个 marker 之后的所有内容既作为最后 name 的值、也作为 main 的值(双份),前端展示时二者各展示一次不会太重复(用户默认折叠 chip)。

**改成如下更简单的实现**(覆盖测试用例的期望):

```python
def _split_transparency(stdout: str) -> dict[str, str]:
    if not stdout:
        return {"method": "", "assumption": "", "quality": "", "main": ""}

    hits: list[tuple[int, int, str]] = []
    for name, pat in _TRANSPARENCY_MARKERS.items():
        m = pat.search(stdout)
        if m:
            hits.append((m.start(), m.end(), name))
    if not hits:
        return {"method": "", "assumption": "", "quality": "", "main": stdout}

    hits.sort(key=lambda x: x[0])
    result = {"method": "", "assumption": "", "quality": "", "main": ""}

    # 相邻两个 marker 之间是前者内容
    for i in range(len(hits) - 1):
        _, end, name = hits[i]
        next_start = hits[i + 1][0]
        result[name] = stdout[end:next_start].strip("\n")

    # 最后一个 marker 之后:尝试按空行分割成"最后区块内容"与"主结果"
    _, last_end, last_name = hits[-1]
    tail = stdout[last_end:].strip("\n")
    parts = re.split(r"\n\s*\n", tail, maxsplit=1)
    if len(parts) == 2:
        result[last_name] = parts[0].strip("\n")
        result["main"] = parts[1].strip("\n")
    else:
        # 只有一段:全当作最后区块内容, main 留空(把主结果和最后一块合并展示总比丢好)
        result[last_name] = tail
        result["main"] = ""

    return result
```

**同步更新测试用例期望** —— 第 1 个测试(标准三段)现在应该是 `quality="无缺失"`, `main="主分析结果 p=0.02"`,需要 stdout 里 quality 和 main 之间有空行。修改测试的 stdout 为:
```
"『【方法选择】』\n用了 t 检验\n\n『【假设检查】』\nShapiro p=0.3\n\n『【数据质量】』\n无缺失\n\n主分析结果 p=0.02"
```

其它 stdout 若原本贴合空行分割,也一并加空行。**回到 Step 1**,把测试里的每处 stdout 都在 marker 之间加 `\n\n`。

- [ ] **Step 4: 运行验证通过**

Run: `cd backend && .venv\Scripts\python.exe test_split_transparency.py`
Expected: `RESULT: N passed, 0 failed`

如失败,按打印的 expected / got 修 marker 正则或分割策略。**核心不变量**:0 marker 时全落 main;有 marker 时按位置切,最后一块用空行拆 main。

- [ ] **Step 5: Commit**

```bash
cd C:\Users\Administrator\Desktop\scientific-discover
git add backend/test_split_transparency.py backend/app/dataanalysis.py
git commit -m "$(cat <<'EOF'
feat(analyze): 新增 _split_transparency 鲁棒切分透明化区块

支持标准分隔符、md 标题、序号前缀、乱序、部分缺失、空串等格式变体。
覆盖单元测试。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: 后端 · 结论 delta 前置裁剪函数

**目标:** 让流式 delta 只在首次 `##` 出现之后开始转发;LLM 全程未出 `##` 时,收尾把缓冲整体送出兜底。

**Files:**
- Create: `backend/test_strip_conclusion_preamble.py`
- Modify: `backend/app/dataanalysis.py`(紧接 `_split_transparency` 之后加入)

- [ ] **Step 1: 写失败测试**

创建 `backend/test_strip_conclusion_preamble.py`:

```python
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
```

- [ ] **Step 2: 运行验证失败**

Run: `cd backend && .venv\Scripts\python.exe test_strip_conclusion_preamble.py`
Expected: `AttributeError: module 'app.dataanalysis' has no attribute '_strip_conclusion_preamble_stream'`

- [ ] **Step 3: 实现流式裁剪**

在 `backend/app/dataanalysis.py` 里,`_split_transparency` 之后加入:

```python
from typing import AsyncIterator as _AsyncIterator  # 若文件顶部已导入 AsyncIterator, 复用即可

async def _strip_conclusion_preamble_stream(pieces: _AsyncIterator[str]) -> _AsyncIterator[str]:
    """吃掉结论 LLM 首个 `##` 之前的所有寒暄/开场白 chunk。

    - 见到 `##` 从其位置起原样转发;
    - 全程未见 `##` 时,收尾把缓冲整体送出兜底(总比空白好)。
    - 支持 `##` 跨 chunk 拆开(比如上一 chunk 只有 `#`,下一 chunk 是 `#`)。
    """
    buf = ""
    seen = False
    async for piece in pieces:
        if seen:
            yield piece
            continue
        buf += piece
        idx = buf.find("##")
        if idx >= 0:
            yield buf[idx:]
            seen = True
    if not seen and buf.strip():
        yield buf
```

- [ ] **Step 4: 运行验证通过**

Run: `cd backend && .venv\Scripts\python.exe test_strip_conclusion_preamble.py`
Expected: `RESULT: 5 passed, 0 failed`

- [ ] **Step 5: Commit**

```bash
cd C:\Users\Administrator\Desktop\scientific-discover
git add backend/test_strip_conclusion_preamble.py backend/app/dataanalysis.py
git commit -m "$(cat <<'EOF'
feat(analyze): 新增 _strip_conclusion_preamble_stream 裁掉结论开场白

流式吃掉首个 ## 之前的所有 chunk;LLM 未产 ## 时兜底整体送出。
覆盖跨 chunk / 首块即 ## / 空流等边界。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: 后端 · 改写 `_conclusion_messages()` 为 3 段硬约束 prompt

**Files:**
- Modify: `backend/app/dataanalysis.py:440-456`

- [ ] **Step 1: 就地替换 `_conclusion_messages()` 函数体**

打开 `backend/app/dataanalysis.py`,找到 `_conclusion_messages()`(现在 440-456 行),替换为:

```python
def _conclusion_messages(question: str, code: str, output: str, warnings: list[str] | None = None) -> list[dict]:
    system = (
        "你是医学/药学/生物医学论文写作助手。基于以下【真实输出】撰写结论,严禁编造或改动其中的数字;"
        "若某结论缺乏数据支撑请说明。\n"
        "\n"
        "【输出格式硬约束】\n"
        "- 严格 Markdown,**直接从『## 核心发现』开始**;\n"
        "- **绝对禁止**任何开场白、寒暄、\"我为您总结如下\"之类前言;\n"
        "- **绝对禁止**复述【方法选择】/【假设检查】/【数据质量】——这些已在其他区块单独展示,重复即为噪声;\n"
        "- 只输出以下三个二级标题及其内容,不多不少:\n"
        "\n"
        "## 核心发现\n"
        "引用输出中的具体数值/统计量/p 值(精确值,如 p=0.003),区分相关与因果。\n"
        "\n"
        "## 结果解读与意义\n"
        "临床/研究含义。审慎措辞:统计显著(如 p<0.05)不等于临床意义或因果,不要夸大;观察性数据只能谈关联。\n"
        "\n"
        "## 主要局限\n"
        "样本量、缺失/异常值处理、偏倚、混杂、假设是否满足等。\n"
    )
    parts = [f"【研究用途】\n{question}", f"【分析代码】\n```python\n{code}\n```", f"【代码真实输出】\n{_clip_output(output)}"]
    if warnings:
        parts.append(
            "【自动核对提示(系统对输出的确定性检查,请在结论中据实说明或据此修正,勿忽略)】\n"
            + "\n".join(f"- {w}" for w in warnings)
        )
    return [{"role": "system", "content": system}, {"role": "user", "content": "\n\n".join(parts)}]
```

- [ ] **Step 2: 快速冒烟(不跑网络,只确认函数不崩)**

Run:
```bash
cd backend && .venv\Scripts\python.exe -c "import app.dataanalysis as da; msgs = da._conclusion_messages('测试', 'print(1)', 'p=0.01'); print(msgs[0]['content'][:80]); assert '## 核心发现' in msgs[0]['content']; print('OK')"
```
Expected: 打印前 80 字 + `OK`

- [ ] **Step 3: Commit**

```bash
cd C:\Users\Administrator\Desktop\scientific-discover
git add backend/app/dataanalysis.py
git commit -m "$(cat <<'EOF'
refactor(analyze): 结论 prompt 改 3 段并硬禁开场白/复述

去掉①方法与前提(与独立展示的透明化区块重复),
只保留核心发现/结果解读/主要局限三段;
强制直接从『## 核心发现』开始。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: 后端 · 新增 `_gen_draw_messages()` prompt

**Files:**
- Modify: `backend/app/dataanalysis.py`(在 `_gen_code_messages` 之后、`_extract_spec_messages` 之前加入)

- [ ] **Step 1: 加入函数**

在 `backend/app/dataanalysis.py` 里 `_gen_code_messages()`(约 267-321 行)之后加入:

```python
def _gen_draw_messages(profile: str, question: str) -> list[dict]:
    """只画图路径的代码生成 prompt。故意省掉所有统计推断/三大透明化区块要求,
    让 LLM 只输出画图代码——用户明确选了"只画图"模式,不该塞任何统计话术进来。"""
    system = (
        "你是数据可视化专家。用户明确只想**看图**,不做任何统计检验、不写文字结论。"
        "请根据【数据画像】和【绘图请求】写一段 Python 代码,只画图。\n"
        + _LIBS_NOTE + "\n"
        "严格要求:\n"
        "① 只使用已加载的 df,列名务必来自【数据画像】中真实存在的列,严禁臆造;\n"
        "② **只画图**——不做 t 检验/方差分析/相关/回归/生存分析等任何统计推断;\n"
        "③ **绝对不要** print 『【方法选择】』/『【假设检查】』/『【数据质量】』等透明化区块;\n"
        "④ 不要 print 结论性文字;必要时可 print 一两句极简说明(如 \"已生成条形图\")便于日志;\n"
        "⑤ 图要出版级质量:信息明确的标题、带单位的轴标签、必要时图例;matplotlib 默认样式,"
        "不用需要 LaTeX 的样式,不调用 plt.show();\n"
        "⑥ 若数据涉及分组,直接呈现即可,无需组间显著性标注(除非用户在【绘图请求】中显式要求);\n"
        "⑦ 柱状图/条形图的数值轴必须从 0 开始;折线/散点/箱线可按需收紧范围;\n"
        "⑧ 配色已由运行环境统一设置,无需手动指定颜色(除非用户特别要求)。\n"
        "只输出一个 Python 代码块,不要额外解释。"
    )
    user = f"【数据画像】\n{profile}\n\n【绘图请求】\n{question or '(用户未填写,请你根据数据挑一张最能揭示分布/关系的图)'}"
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]
```

- [ ] **Step 2: 冒烟**

Run:
```bash
cd backend && .venv\Scripts\python.exe -c "import app.dataanalysis as da; m = da._gen_draw_messages('cols: age,group', '画年龄柱状图'); assert '只画图' in m[0]['content']; assert '透明化区块' in m[0]['content']; print('OK')"
```
Expected: `OK`

- [ ] **Step 3: Commit**

```bash
cd C:\Users\Administrator\Desktop\scientific-discover
git add backend/app/dataanalysis.py
git commit -m "feat(analyze): 新增 _gen_draw_messages 只画图 prompt

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: 后端 · 新增 `_refine_draw_messages()` prompt

**Files:**
- Modify: `backend/app/dataanalysis.py`(在 `_refine_code_messages` 之后加入)

- [ ] **Step 1: 加入函数**

```python
def _refine_draw_messages(
    profile: str, question: str, current_code: str, requirement: str,
) -> list[dict]:
    """只画图路径的 refine prompt。基于 _refine_code_messages 精简:
    去掉三大透明化区块保留要求、统计规范要求;只强调"在现有画图代码上按新需求最小改动"。"""
    system = (
        "你是数据可视化专家。用户已有一份**能正常运行**的画图代码,现在提出新的修改需求。"
        "请在原逻辑基础上做**最小必要修改**——新需求可能是换图型、改配色、加标注、"
        "换要画的变量或分组等。不要推倒重来,除非新需求确实要求全新的图。\n"
        + _LIBS_NOTE + "\n"
        "作图规范:每张图有信息明确的标题、带单位的轴标签、必要时图例;"
        "matplotlib 默认样式;柱状图/条形图的数值轴从 0 开始;"
        "只使用已加载的 df,列名用【数据画像】中真实存在的列名,不要臆造。\n"
        "**只画图**,不做任何统计检验;**绝对不要** print 『【方法选择】』等透明化区块。\n"
        "**必须输出一个完整、可独立运行的 Python 代码块**(把改动整合进完整脚本,"
        "不要只给 diff 片段、不要额外解释)。"
    )
    parts = [
        f"【数据画像】\n{profile}",
        f"【原始绘图请求】\n{question or '(未填写)'}",
        f"【当前画图代码(已跑通,请在此基础上改)】\n```python\n{current_code}\n```",
        f"【本轮新需求】\n{requirement}",
    ]
    return [{"role": "system", "content": system}, {"role": "user", "content": "\n\n".join(parts)}]
```

- [ ] **Step 2: 冒烟**

Run:
```bash
cd backend && .venv\Scripts\python.exe -c "import app.dataanalysis as da; m = da._refine_draw_messages('cols', 'q', 'print(1)', '换箱线图'); assert '最小必要修改' in m[0]['content']; assert '透明化区块' in m[0]['content']; print('OK')"
```
Expected: `OK`

- [ ] **Step 3: Commit**

```bash
cd C:\Users\Administrator\Desktop\scientific-discover
git add backend/app/dataanalysis.py
git commit -m "feat(analyze): 新增 _refine_draw_messages draw 模式 refine prompt

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: 后端 · `draw_chart()` 异步生成器

**Files:**
- Create: `backend/test_draw_chart.py`
- Modify: `backend/app/dataanalysis.py`(在 `analyze_data()` 之后加入)

- [ ] **Step 1: 写失败测试**

创建 `backend/test_draw_chart.py`:

```python
"""draw 流水线事件契约。运行: .venv\\Scripts\\python.exe test_draw_chart.py"""
import asyncio, sys
import pandas as pd
import app.dataanalysis as da

da.settings.mock = False

_CSV = pd.DataFrame({"g": ["A", "B"], "v": [1, 2]}).to_csv(index=False).encode("utf-8")


async def _collect():
    calls = {"n": 0}

    def fake_execute(code, df, chart_format="png", palette="default"):
        calls["n"] += 1
        return {"ok": True, "error": None, "stdout": "", "charts": [{"png": "b64", "data": "b64", "ext": "png"}]}

    async def fake_stream(messages, **kw):
        yield "```python\nprint('draw')\n```"

    async def fake_complete(messages, **kw):
        return "```python\nprint('draw')\n```"

    da._execute = fake_execute
    da.stream_chat = fake_stream
    da._complete = fake_complete

    events = []
    async for ev, data in da.draw_chart("t.csv", _CSV, "画个柱状图", "png", "default"):
        events.append((ev, data))
    return events, calls["n"]


def main():
    events, n_exec = asyncio.run(_collect())
    names = [e[0] for e in events]
    print("events:", names)
    fail = 0

    # draw 模式必发 code + charts + done, 绝不发 delta / transparency_* / plan
    for must in ("code", "charts", "done"):
        if must not in names:
            print("FAIL 缺事件", must); fail += 1
        else:
            print("PASS 有事件", must)
    for forbid in ("delta", "transparency_method", "transparency_assumption", "transparency_quality", "plan"):
        if forbid in names:
            print("FAIL 禁事件却发了", forbid); fail += 1
        else:
            print("PASS 未发禁事件", forbid)

    print(f"\nRESULT: {'PASS' if fail == 0 else 'FAIL'}")
    sys.exit(0 if fail == 0 else 1)


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: 运行验证失败**

Run: `cd backend && .venv\Scripts\python.exe test_draw_chart.py`
Expected: `AttributeError: module 'app.dataanalysis' has no attribute 'draw_chart'`

- [ ] **Step 3: 实现 `draw_chart()`**

在 `backend/app/dataanalysis.py` 里,`analyze_data()` 之后加入:

```python
async def draw_chart(
    filename: str, content: bytes, question: str, chart_format: str = "png", palette: str = "default",
) -> AsyncIterator[tuple[str, dict]]:
    """只画图模式:profile → 单发画图代码 → 执行 → 出图。不做探索、不做统计规格抽取、不写结论。"""
    if settings.mock:
        # 复用现有 mock 生成器的画图片段即可; 为兼容简单化, 直接吐一张 mock 图
        yield ("status", {"message": "[MOCK] 生成图…"})
        yield ("code", {"code": "# mock draw\nimport matplotlib.pyplot as plt\nplt.bar([1,2],[3,4])"})
        yield ("charts", {"items": [{"png": "", "data": "", "ext": "png"}]})
        yield ("done", {})
        return

    try:
        yield ("status", {"message": "正在读取数据…"})
        try:
            df = _load(filename, content)
        except Exception as e:  # noqa: BLE001
            yield ("error", {"message": f"无法读取数据文件:{e}"})
            return
        if df.empty:
            yield ("error", {"message": "数据为空。"})
            return
        profile = profile_data(df)

        yield ("status", {"message": "正在生成画图代码…"})
        code = _extract_code(await _complete(
            _gen_draw_messages(profile, question), max_tokens=4096,
        ))
        yield ("code", {"code": code})
        yield ("status", {"message": "正在本地执行画图…"})
        run = await asyncio.to_thread(_execute, code, df, chart_format, palette)

        # 自动修错:复用 _fix_code_messages,最多 3 次。draw 场景一般更简单,3 次足够。
        seen_sigs: list[str] = []
        for attempt in range(3):
            if run.get("ok"):
                break
            sig = _err_sig(run.get("error", ""))
            fresh = bool(sig) and sig in seen_sigs
            seen_sigs.append(sig)
            hint = "(换一种思路重写)" if fresh else ""
            yield ("status", {"message": f"执行出错,正在自动修正代码(第 {attempt + 1} 次){hint}…"})
            code = _extract_code(await _complete(
                _fix_code_messages(profile, question, code, run.get("error", ""), fresh=fresh),
                max_tokens=4096,
            ))
            yield ("code", {"code": code})
            yield ("status", {"message": "正在重新执行…"})
            run = await asyncio.to_thread(_execute, code, df, chart_format, palette)

        if run.get("charts"):
            yield ("charts", {"items": run["charts"]})
        # 注意:draw 模式不发 output 事件——用户明确只想看图, 系统日志级别的 print 不入前端
        if not run.get("ok"):
            yield ("error", {"message": "画图代码执行失败:\n" + (run.get("error") or "未知错误")})
            return
        yield ("done", {})
    except Exception as e:  # noqa: BLE001
        yield ("error", {"message": f"画图过程出错:{e}"})
```

- [ ] **Step 4: 运行验证通过**

Run: `cd backend && .venv\Scripts\python.exe test_draw_chart.py`
Expected: `RESULT: PASS`

- [ ] **Step 5: Commit**

```bash
cd C:\Users\Administrator\Desktop\scientific-discover
git add backend/test_draw_chart.py backend/app/dataanalysis.py
git commit -m "$(cat <<'EOF'
feat(analyze): 新增 draw_chart 只画图流水线

绕过探索/spec 抽取/结论生成三步,单发画图代码 + 3 次自动修错。
只发 status/code/charts/error/done, 不发 delta/transparency_*/output/plan。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: 后端 · `refine_draw()` 异步生成器

**Files:**
- Create: `backend/test_refine_draw.py`
- Modify: `backend/app/dataanalysis.py`(在 `refine_analysis()` 之后加入)

- [ ] **Step 1: 写失败测试**

创建 `backend/test_refine_draw.py`:

```python
"""refine_draw 事件契约。运行: .venv\\Scripts\\python.exe test_refine_draw.py"""
import asyncio, sys
import pandas as pd
import app.dataanalysis as da

da.settings.mock = False

_CSV = pd.DataFrame({"g": ["A", "B"], "v": [1, 2]}).to_csv(index=False).encode("utf-8")


async def _collect():
    def fake_execute(code, df, chart_format="png", palette="default"):
        return {"ok": True, "error": None, "stdout": "", "charts": [{"png": "b64", "data": "b64", "ext": "png"}]}

    async def fake_complete(messages, **kw):
        return "```python\nprint('draw2')\n```"

    da._execute = fake_execute
    da._complete = fake_complete

    events = []
    async for ev, data in da.refine_draw(
        "t.csv", _CSV, "print('draw')", "换成箱线图", "画柱状图", "png", "default",
    ):
        events.append((ev, data))
    return events


def main():
    events = asyncio.run(_collect())
    names = [e[0] for e in events]
    print("events:", names)
    fail = 0
    for must in ("code", "charts", "done"):
        if must not in names: print("FAIL 缺", must); fail += 1
        else: print("PASS 有", must)
    for forbid in ("delta", "transparency_method", "transparency_assumption", "transparency_quality"):
        if forbid in names: print("FAIL 禁事件却发了", forbid); fail += 1
        else: print("PASS 未发", forbid)
    print("RESULT:", "PASS" if fail == 0 else "FAIL")
    sys.exit(0 if fail == 0 else 1)


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: 运行验证失败**

Run: `cd backend && .venv\Scripts\python.exe test_refine_draw.py`
Expected: `AttributeError: module 'app.dataanalysis' has no attribute 'refine_draw'`

- [ ] **Step 3: 实现 `refine_draw()`**

在 `backend/app/dataanalysis.py` 里,`refine_analysis()` 之后加入:

```python
async def refine_draw(
    filename: str, content: bytes, current_code: str, requirement: str,
    question: str = "", chart_format: str = "png", palette: str = "default",
) -> AsyncIterator[tuple[str, dict]]:
    """只画图模式的续跑:在现有画图代码上按新需求做最小改动重跑。"""
    if settings.mock:
        yield ("status", {"message": "[MOCK] 按新需求改图…"})
        yield ("code", {"code": f"# mock refine draw: {requirement}"})
        yield ("charts", {"items": [{"png": "", "data": "", "ext": "png"}]})
        yield ("done", {})
        return

    try:
        yield ("status", {"message": "正在读取数据…"})
        try:
            df = _load(filename, content)
        except Exception as e:  # noqa: BLE001
            yield ("error", {"message": f"无法读取数据文件:{e}"})
            return
        if df.empty:
            yield ("error", {"message": "数据为空。"})
            return
        if not (current_code or "").strip():
            yield ("error", {"message": "缺少可修改的现有画图代码,请先完成一次画图。"})
            return
        profile = profile_data(df)

        yield ("status", {"message": "正在按新需求修改画图代码…"})
        code = _extract_code(await _complete(
            _refine_draw_messages(profile, question, current_code, requirement), max_tokens=4096,
        ))
        yield ("code", {"code": code})
        yield ("status", {"message": "正在本地执行画图…"})
        run = await asyncio.to_thread(_execute, code, df, chart_format, palette)

        seen_sigs: list[str] = []
        for attempt in range(3):
            if run.get("ok"):
                break
            sig = _err_sig(run.get("error", ""))
            fresh = bool(sig) and sig in seen_sigs
            seen_sigs.append(sig)
            hint = "(换一种思路重写)" if fresh else ""
            yield ("status", {"message": f"执行出错,正在自动修正代码(第 {attempt + 1} 次){hint}…"})
            code = _extract_code(await _complete(
                _fix_code_messages(profile, requirement, code, run.get("error", ""), fresh=fresh),
                max_tokens=4096,
            ))
            yield ("code", {"code": code})
            yield ("status", {"message": "正在重新执行…"})
            run = await asyncio.to_thread(_execute, code, df, chart_format, palette)

        if run.get("charts"):
            yield ("charts", {"items": run["charts"]})
        if not run.get("ok"):
            yield ("error", {"message": "画图代码执行失败:\n" + (run.get("error") or "未知错误")})
            return
        yield ("done", {})
    except Exception as e:  # noqa: BLE001
        yield ("error", {"message": f"续跑过程出错:{e}"})
```

- [ ] **Step 4: 运行验证通过**

Run: `cd backend && .venv\Scripts\python.exe test_refine_draw.py`
Expected: `RESULT: PASS`

- [ ] **Step 5: Commit**

```bash
cd C:\Users\Administrator\Desktop\scientific-discover
git add backend/test_refine_draw.py backend/app/dataanalysis.py
git commit -m "feat(analyze): 新增 refine_draw draw 模式续跑

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: 后端 · 把切分与前置裁剪接进 `analyze_data()`

**Files:**
- Create: `backend/test_analyze_transparency_events.py`
- Modify: `backend/app/dataanalysis.py:786-800`(analyze_data 的 stdout 推送 + 结论流)

- [ ] **Step 1: 写失败测试**

创建 `backend/test_analyze_transparency_events.py`:

```python
"""analyze/refine 集成:透明化切分与结论前置裁剪。
运行: .venv\\Scripts\\python.exe test_analyze_transparency_events.py"""
import asyncio, sys
import pandas as pd
import app.dataanalysis as da

da.settings.mock = False

_CSV = pd.DataFrame({"g": ["A", "B"], "v": [1, 2]}).to_csv(index=False).encode("utf-8")


async def _collect():
    stdout = (
        "『【方法选择】』\nt 检验\n\n"
        "『【假设检查】』\nShapiro p=0.3\n\n"
        "『【数据质量】』\n无缺失\n\n"
        "p=0.02"
    )
    call_seq = ["explore_out", "```json\n{\"analyses\":[]}\n```", "```python\nprint('a')\n```"]
    ci = {"n": 0}

    async def fake_complete(messages, **kw):
        v = call_seq[ci["n"]] if ci["n"] < len(call_seq) else "```python\nprint('x')\n```"
        ci["n"] += 1
        return v

    async def fake_stream(messages, task=None):
        # 前面故意加寒暄,验证裁剪
        for p in ["好的,我为您总结如下。\n", "## 核心发现\n", "p=0.02"]:
            yield p

    def fake_execute(code, df, chart_format="png", palette="default"):
        # 探索轮返回空; 分析轮返回三段 stdout
        if not fake_execute.first_done:
            fake_execute.first_done = True
            return {"ok": True, "error": None, "stdout": "explore ok", "charts": []}
        return {"ok": True, "error": None, "stdout": stdout, "charts": []}

    fake_execute.first_done = False

    da._execute = fake_execute
    da._complete = fake_complete
    da.stream_chat = fake_stream

    events = []
    async for ev, data in da.analyze_data("t.csv", _CSV, "跑 t 检验", "png", "default"):
        events.append((ev, data))
    return events


def main():
    events = asyncio.run(_collect())
    names = [e[0] for e in events]
    print("events:", names)
    fail = 0

    for e in ("transparency_method", "transparency_assumption", "transparency_quality", "output", "delta", "done"):
        if e not in names: print("FAIL 缺", e); fail += 1
        else: print("PASS 有", e)

    # 校验 transparency 内容
    trm = next((d["text"] for n, d in events if n == "transparency_method"), "")
    if "t 检验" in trm: print("PASS method 内容")
    else: print("FAIL method 内容:", trm); fail += 1

    tqu = next((d["text"] for n, d in events if n == "transparency_quality"), "")
    if "无缺失" in tqu: print("PASS quality 内容")
    else: print("FAIL quality 内容:", tqu); fail += 1

    out = next((d["text"] for n, d in events if n == "output"), "")
    if out.strip() == "p=0.02": print("PASS output = 主结果")
    else: print("FAIL output:", repr(out)); fail += 1

    # 校验 delta 拼起来后不含"好的,我为您"这类寒暄
    conclusion = "".join(d["text"] for n, d in events if n == "delta")
    if conclusion.startswith("## 核心发现"): print("PASS delta 起始 = ##")
    else: print("FAIL delta 未裁剪:", repr(conclusion[:40])); fail += 1
    if "我为您总结" in conclusion: print("FAIL delta 有开场白"); fail += 1
    else: print("PASS delta 无开场白")

    print("RESULT:", "PASS" if fail == 0 else "FAIL")
    sys.exit(0 if fail == 0 else 1)


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: 运行验证失败**

Run: `cd backend && .venv\Scripts\python.exe test_analyze_transparency_events.py`
Expected: 至少 3-4 个 FAIL(还没接入切分)

- [ ] **Step 3: 修改 `analyze_data()` stdout 推送段**

打开 `backend/app/dataanalysis.py`,找到 `analyze_data()` 里这段(约 786-800 行):

```python
        if run.get("charts"):
            yield ("charts", {"items": run["charts"]})
        if run.get("stdout"):
            yield ("output", {"text": run["stdout"]})
        ...
        yield ("status", {"message": "正在总结结论…"})
        async for piece in stream_chat(_conclusion_messages(question, code, run.get("stdout", ""), warnings), task="analysis"):
            yield ("delta", {"text": piece})
        yield ("done", {})
```

改为:

```python
        if run.get("charts"):
            yield ("charts", {"items": run["charts"]})
        stdout_full = run.get("stdout", "") or ""
        if stdout_full:
            parts = _split_transparency(stdout_full)
            if parts["method"]:
                yield ("transparency_method", {"text": parts["method"]})
            if parts["assumption"]:
                yield ("transparency_assumption", {"text": parts["assumption"]})
            if parts["quality"]:
                yield ("transparency_quality", {"text": parts["quality"]})
            if parts["main"]:
                yield ("output", {"text": parts["main"]})

        if not run.get("ok"):
            yield ("error", {"message": "分析代码执行失败:\n" + (run.get("error") or "未知错误")})
            return

        warnings = _sanity_checks(stdout_full)

        yield ("status", {"message": "正在总结结论…"})
        async for piece in _strip_conclusion_preamble_stream(
            stream_chat(_conclusion_messages(question, code, stdout_full, warnings), task="analysis")
        ):
            yield ("delta", {"text": piece})
        yield ("done", {})
```

**注意:** 中间 `if not run.get("ok"):` 与 `warnings = _sanity_checks(...)` 保持原位;`_sanity_checks` 用 `stdout_full`(未切分),不是切分后的 `main`——完整 stdout 才有全部数字。

- [ ] **Step 4: 运行验证通过**

Run: `cd backend && .venv\Scripts\python.exe test_analyze_transparency_events.py`
Expected: `RESULT: PASS`

- [ ] **Step 5: 顺便回归旧测试**

Run: `cd backend && .venv\Scripts\python.exe test_analyze_retry.py`
Expected: 原有断言仍通过(输出 `PASS` / `RESULT` 等,依原测试格式)

如失败,请对照 diff 检查 `_sanity_checks` 参数、`run.get("stdout")` 引用是否遗漏改到 `stdout_full`。

- [ ] **Step 6: Commit**

```bash
cd C:\Users\Administrator\Desktop\scientific-discover
git add backend/test_analyze_transparency_events.py backend/app/dataanalysis.py
git commit -m "$(cat <<'EOF'
feat(analyze): analyze_data 拆分透明化事件+结论前置裁剪

stdout 拆成 method/assumption/quality/main 分别推送;
结论流经 _strip_conclusion_preamble_stream 吃掉开场白。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: 后端 · 同样接入 `refine_analysis()`

**Files:**
- Modify: `backend/app/dataanalysis.py`(`refine_analysis()`,即当前约 875-890 行同款段)

- [ ] **Step 1: 修改 refine_analysis 的 stdout 推送段**

打开 `backend/app/dataanalysis.py`,找到 `refine_analysis()` 里(约 875-890 行):

```python
        if run.get("charts"):
            yield ("charts", {"items": run["charts"]})
        if run.get("stdout"):
            yield ("output", {"text": run["stdout"]})
        ...
        warnings = _sanity_checks(run.get("stdout", ""))
        yield ("status", {"message": "正在总结结论…"})
        conc_q = (question + "\n【本轮新需求】" + requirement) if question else requirement
        async for piece in stream_chat(_conclusion_messages(conc_q, code, run.get("stdout", ""), warnings), task="analysis"):
            yield ("delta", {"text": piece})
        yield ("done", {})
```

改为(与 Task 8 同款处理):

```python
        if run.get("charts"):
            yield ("charts", {"items": run["charts"]})
        stdout_full = run.get("stdout", "") or ""
        if stdout_full:
            parts = _split_transparency(stdout_full)
            if parts["method"]:
                yield ("transparency_method", {"text": parts["method"]})
            if parts["assumption"]:
                yield ("transparency_assumption", {"text": parts["assumption"]})
            if parts["quality"]:
                yield ("transparency_quality", {"text": parts["quality"]})
            if parts["main"]:
                yield ("output", {"text": parts["main"]})

        if not run.get("ok"):
            yield ("error", {"message": "分析代码执行失败:\n" + (run.get("error") or "未知错误")})
            return

        warnings = _sanity_checks(stdout_full)
        yield ("status", {"message": "正在总结结论…"})
        conc_q = (question + "\n【本轮新需求】" + requirement) if question else requirement
        async for piece in _strip_conclusion_preamble_stream(
            stream_chat(_conclusion_messages(conc_q, code, stdout_full, warnings), task="analysis")
        ):
            yield ("delta", {"text": piece})
        yield ("done", {})
```

- [ ] **Step 2: 冒烟(重跑 Task 8 的测试;它只测首轮,但确保 refine 改动不破坏 import)**

Run: `cd backend && .venv\Scripts\python.exe -c "import app.dataanalysis; print('import OK')"`
Expected: `import OK`

Run: `cd backend && .venv\Scripts\python.exe test_analyze_transparency_events.py`
Expected: `RESULT: PASS`

- [ ] **Step 3: Commit**

```bash
cd C:\Users\Administrator\Desktop\scientific-discover
git add backend/app/dataanalysis.py
git commit -m "feat(analyze): refine_analysis 同样拆事件+裁剪

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: 后端 · 路由 `/api/analyze` 加 `mode` 分发

**Files:**
- Modify: `backend/app/routes/analysis_routes.py:37-59`

- [ ] **Step 1: 打开路由文件,替换 `/api/analyze` 处理函数**

打开 `backend/app/routes/analysis_routes.py`,把第 37-59 行的 `analyze()` 换成:

```python
@router.post("/api/analyze")
async def analyze(
    file: UploadFile = File(...),
    question: str = Form(""),
    chart_format: str = Form("png"),
    palette: str = Form("default"),
    mode: str = Form("analyze"),  # "analyze" | "draw" —— 前端显式选;默认沿用旧行为
) -> StreamingResponse:
    """AI 看懂数据 → 写分析代码 → 本地执行 → 流式输出结论(SSE)。
    mode="draw" 时走精简画图流水线,不产生结论/透明化事件。"""
    from ..dataanalysis import analyze_data, draw_chart

    content = await _read_capped(file)
    filename = file.filename or "data.csv"
    gen_fn = draw_chart if mode == "draw" else analyze_data

    async def gen():
        async for event, data in gen_fn(filename, content, question, chart_format, palette):
            yield _sse(event, data)

    return StreamingResponse(gen(), media_type="text/event-stream", headers=SSE_HEADERS)
```

- [ ] **Step 2: 冒烟**

Run:
```bash
cd backend && .venv\Scripts\python.exe -c "from app.routes.analysis_routes import router; print([r.path for r in router.routes if 'analyze' in r.path])"
```
Expected: 打印出的路径列表包含 `/api/analyze`,不报错。

- [ ] **Step 3: Commit**

```bash
cd C:\Users\Administrator\Desktop\scientific-discover
git add backend/app/routes/analysis_routes.py
git commit -m "feat(analyze): /api/analyze 加 mode 字段并按 mode 分发

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: 后端 · 路由 `/api/analyze/refine` 加 `mode` 分发

**Files:**
- Modify: `backend/app/routes/analysis_routes.py:62-95`

- [ ] **Step 1: 打开路由文件,替换 refine 处理函数**

打开 `backend/app/routes/analysis_routes.py`,把第 62-95 行的 `analyze_refine()` 换成:

```python
@router.post("/api/analyze/refine")
async def analyze_refine(
    file: UploadFile = File(...),
    current_code: str = Form(...),
    requirement: str = Form(...),
    prev_summary: str = Form(""),
    question: str = Form(""),
    chart_format: str = Form("png"),
    palette: str = Form("default"),
    mode: str = Form("analyze"),
) -> StreamingResponse:
    """对话式续跑。mode 由前端传入,与首轮一致(前端保证)。
    数据仍由本次上传的文件提供(执行代码所需)。事件与 /api/analyze 完全一致。"""
    from ..dataanalysis import refine_analysis, refine_draw

    content = await _read_capped(file)
    filename = file.filename or "data.csv"

    async def gen():
        if mode == "draw":
            async for event, data in refine_draw(
                filename, content, current_code, requirement, question, chart_format, palette,
            ):
                yield _sse(event, data)
        else:
            async for event, data in refine_analysis(
                filename, content, current_code, requirement, prev_summary,
                question, chart_format, palette,
            ):
                yield _sse(event, data)

    return StreamingResponse(gen(), media_type="text/event-stream", headers=SSE_HEADERS)
```

- [ ] **Step 2: 冒烟**

Run:
```bash
cd backend && .venv\Scripts\python.exe -c "from app.routes.analysis_routes import router; print('routes:', sum(1 for r in router.routes if '/api/analyze' in r.path))"
```
Expected: 至少 2 条(analyze 首轮 + refine)。

- [ ] **Step 3: Commit**

```bash
cd C:\Users\Administrator\Desktop\scientific-discover
git add backend/app/routes/analysis_routes.py
git commit -m "feat(analyze): /api/analyze/refine 加 mode 分发

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 12: 前端 · `sse.ts` 扩展 `AnalyzeHandlers` 与两条流函数

**Files:**
- Modify: `frontend/src/lib/sse.ts:997-1132`(AnalyzeHandlers 接口 + streamAnalyze + streamAnalyzeRefine)

- [ ] **Step 1: 扩展接口(第 997 行附近)**

打开 `frontend/src/lib/sse.ts`,把 `AnalyzeHandlers` 改为:

```typescript
export type AnalyzeMode = "analyze" | "draw";
export type TransparencyKind = "method" | "assumption" | "quality";

export interface AnalyzeHandlers {
  onStatus?: (message: string) => void;
  onPlan?: (cards: PlanCard[]) => void;
  onCode?: (code: string) => void;
  onCharts?: (items: ChartItem[]) => void;
  onOutput?: (text: string) => void;
  onTransparency?: (kind: TransparencyKind, text: string) => void;
  onDelta: (text: string) => void;
  onDone?: () => void;
  onError?: (message: string) => void;
  signal?: AbortSignal;
}
```

- [ ] **Step 2: `streamAnalyze` 增 `mode` 形参并加事件分发**

找到 `streamAnalyze(...)`(第 1017 行起),签名改为:

```typescript
export async function streamAnalyze(
  file: File,
  question: string,
  chartFormat: string,
  palette: string,
  mode: AnalyzeMode,
  h: AnalyzeHandlers,
): Promise<void> {
```

在 `fd.append(...)` 追加:

```typescript
fd.append("mode", mode);
```

在事件分发处(现有的 `if (ev.event === "status") ...` 一串 else if 里)插入(放在 `output` 之后、`delta` 之前):

```typescript
        else if (ev.event === "transparency_method")     h.onTransparency?.("method",     data.text ?? "");
        else if (ev.event === "transparency_assumption") h.onTransparency?.("assumption", data.text ?? "");
        else if (ev.event === "transparency_quality")    h.onTransparency?.("quality",    data.text ?? "");
```

- [ ] **Step 3: `streamAnalyzeRefine` 同样处理**

找到 `streamAnalyzeRefine(...)`(第 1076 行起),签名改为:

```typescript
export async function streamAnalyzeRefine(
  file: File,
  currentCode: string,
  requirement: string,
  prevSummary: string,
  question: string,
  chartFormat: string,
  palette: string,
  mode: AnalyzeMode,
  h: AnalyzeHandlers,
): Promise<void> {
```

追加 `fd.append("mode", mode);`,事件分发处同样插入三个 transparency case。

- [ ] **Step 4: TypeScript 类型冒烟**

Run: `cd frontend && npx tsc --noEmit -p tsconfig.json`
Expected: 报错**只**出现在 `DataPane.tsx`(因为它还没升级 `streamAnalyze` 调用参数);其它文件无新错。

如果 sse.ts 内部报错,回头对齐 else if 分支缩进。

- [ ] **Step 5: Commit**

```bash
cd C:\Users\Administrator\Desktop\scientific-discover
git add frontend/src/lib/sse.ts
git commit -m "feat(analyze): sse.ts 加 mode 与 onTransparency

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 13: 前端 · `DataPane.tsx` mode 单选 + 状态

**Files:**
- Modify: `frontend/src/modules/analyze/DataPane.tsx`

- [ ] **Step 1: 引入 AnalyzeMode 类型 + 加 state**

在 `DataPane.tsx` 顶部 import 里追加(第 2 行 `import { streamAnalyze, ... }` 那行):

```typescript
import { streamAnalyze, streamAnalyzeRefine, ChartItem, PlanCard, AnalyzeMode, TransparencyKind } from "../../lib/sse";
```

在 state 声明区(第 42 行 `const [step, ...] = usePersistentState(...)` 附近)追加:

```typescript
const [mode, setMode] = usePersistentState<AnalyzeMode>("analyze:mode", "analyze");
const [transparency, setTransparency] = usePersistentState<{method: string; assumption: string; quality: string}>(
  "analyze:transparency",
  { method: "", assumption: "", quality: "" },
);
```

- [ ] **Step 2: 在"数据与方案"面板顶部加单选按钮组**

找到第一阶段(step === 1)渲染文件上传/question 输入的区块,在最上方(在 file 输入之前)加:

```tsx
<div className="mode-radio" style={{ display: "flex", gap: 16, marginBottom: 12 }}>
  <label style={{ cursor: "pointer" }}>
    <input
      type="radio"
      name="analyze-mode"
      checked={mode === "analyze"}
      onChange={() => { setMode("analyze"); setConclusion(""); setTransparency({ method: "", assumption: "", quality: "" }); }}
    /> 📊 数据分析<span style={{ color: "#888", marginLeft: 4 }}>跑统计+透明化+结论</span>
  </label>
  <label style={{ cursor: "pointer" }}>
    <input
      type="radio"
      name="analyze-mode"
      checked={mode === "draw"}
      onChange={() => { setMode("draw"); setConclusion(""); setTransparency({ method: "", assumption: "", quality: "" }); }}
    /> 🎨 只画图<span style={{ color: "#888", marginLeft: 4 }}>只画图,不做统计不写结论</span>
  </label>
</div>
```

**位置指引**:找到第一处 `<input type="file"` 所在的父容器,把上面这段放在它之前(同一父容器内)。

- [ ] **Step 3: 修改 `streamAnalyze` 调用,传 mode + onTransparency**

找到第 187 行附近 `await streamAnalyze(file, question, chartFormat, palette, { ... })`,改成:

```typescript
await streamAnalyze(file, question, chartFormat, palette, mode, {
  onStatus: (m) => setStatus(m),
  onPlan: (c) => setPlan(c),
  onCode: (c) => setCode(c),
  onCharts: (c) => setCharts(c),
  onOutput: (t) => setOutput(t),
  onTransparency: (kind, text) => setTransparency((p) => ({ ...p, [kind]: text })),
  onDelta: (t) => setConclusion((p) => p + t),
  onDone: () => setRunning(false),
  onError: (e) => { setError(e); setRunning(false); },
  signal: ctrl.current?.signal,
});
```

**保留原有其它回调结构**——上面这段只列关键改动,请在原回调对象里就地增加 `onTransparency` 一行、把 `streamAnalyze` 的第 5 个参数从直接传 handler 对象改成先传 `mode` 再传 handler。

- [ ] **Step 4: 修改 refine 调用**

找到第 228 行附近 `await streamAnalyzeRefine(file, baseCode, req, baseSummary, question, chartFormat, palette, { ... })`,改成:

```typescript
await streamAnalyzeRefine(file, baseCode, req, baseSummary, question, chartFormat, palette, mode, {
  onStatus: (m) => setStatus(m),
  onCode: (c) => setCode(c),
  onCharts: (c) => setCharts(c),
  onOutput: (t) => setOutput(t),
  onTransparency: (kind, text) => setTransparency((p) => ({ ...p, [kind]: text })),
  onDelta: (t) => setConclusion((p) => p + t),
  onDone: () => setRunning(false),
  onError: (e) => { setError(e); setRunning(false); },
  signal: ctrl.current?.signal,
});
```

- [ ] **Step 5: refine 输入框 placeholder 按 mode 变**

找到 `data-testid="refine-input"` 的 `<textarea>`(约 553 行),给它加动态 placeholder:

```tsx
<textarea
  data-testid="refine-input"
  value={refineInput}
  onChange={(e) => setRefineInput(e.target.value)}
  placeholder={mode === "draw" ? "换成箱线图 / 加标题 / 换配色…" : "换图型 / 加显著性 / 换分析…"}
  {/* 保留原有其它属性 */}
/>
```

- [ ] **Step 6: 把 mode 与 transparency 传给 `GeneralResults`**

找到 step === 2 阶段渲染 `<GeneralResults ... />` 处,追加两个 props:

```tsx
<GeneralResults
  mode={mode}
  transparency={transparency}
  {/* 保留其它 props */}
/>
```

- [ ] **Step 7: 类型冒烟**

Run: `cd frontend && npx tsc --noEmit -p tsconfig.json`
Expected: DataPane 无 TS 错误;`GeneralResults` 会因 props 新字段暂时报错——留给 Task 14 修。

- [ ] **Step 8: Commit**

```bash
cd C:\Users\Administrator\Desktop\scientific-discover
git add frontend/src/modules/analyze/DataPane.tsx
git commit -m "feat(analyze): DataPane 加 mode 单选 + transparency 状态

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 14: 前端 · `GeneralResults.tsx` 新增 3 个透明化 popup + draw-mode 简化

**背景澄清**:阅读 `GeneralResults.tsx` 后发现,现有 `plan / code / output` 已经是 popup 按钮模式(第 88-101 行 `analyze-popbar`,配合第 12-24 行的 `Popup` 组件),不是明文平铺。因此新增的 3 个透明化区块也走同一 popup 模式(风格一致、无需引入新的折叠组件)——用户约的"默认折叠"这一点已经自然满足(popup 默认不弹)。

**Files:**
- Modify: `frontend/src/modules/analyze/GeneralResults.tsx`

- [ ] **Step 1: 扩展 props 类型**

在 `GeneralResultsProps` interface(第 27-42 行)追加两个字段:

```typescript
interface GeneralResultsProps {
  chartType: ChartType;
  goto: Goto;
  status: string;
  error: string | null;
  plan: PlanCard[];
  code: string;
  charts: ChartItem[];
  captions: string[];
  setCaptions: (c: string[]) => void;
  output: string;
  conclusion: string;
  setConclusion: (v: string) => void;
  running: boolean;
  question: string;
  mode?: "analyze" | "draw";
  transparency?: { method: string; assumption: string; quality: string };
}
```

函数签名同步解构(第 43-46 行):

```typescript
export default function GeneralResults({
  chartType, goto, status, error, plan, code, charts, captions, setCaptions,
  output, conclusion, setConclusion, running, question,
  mode = "analyze",
  transparency = { method: "", assumption: "", quality: "" },
}: GeneralResultsProps) {
```

- [ ] **Step 2: 扩展 popup 状态枚举**

第 49 行现有:

```typescript
const [popup, setPopup] = useState<null | "plan" | "code" | "output">(null);
```

改为:

```typescript
const [popup, setPopup] = useState<null | "plan" | "code" | "output" | "method" | "assumption" | "quality">(null);
```

- [ ] **Step 3: `analyze-popbar` 追加 3 个新按钮**

第 88-101 行现有:

```tsx
{(plan.length > 0 || code || output) && (
  <div className="analyze-popbar" data-testid="analyze-popbar">
    {plan.length > 0 && (
      <button className="btn-ghost btn-sm" data-testid="show-plan-btn" onClick={() => setPopup("plan")}>📐 分析方案</button>
    )}
    {code && (
      <button className="btn-ghost btn-sm" data-testid="show-code-btn" onClick={() => setPopup("code")}>💻 分析代码</button>
    )}
    {output && (
      <button className="btn-ghost btn-sm" data-testid="show-output-btn" onClick={() => setPopup("output")}>📄 原始输出</button>
    )}
  </div>
)}
```

改为(加 3 个新按钮 + 拓宽外层的条件):

```tsx
{(plan.length > 0 || code || output || transparency.method || transparency.assumption || transparency.quality) && (
  <div className="analyze-popbar" data-testid="analyze-popbar">
    {transparency.method && (
      <button className="btn-ghost btn-sm" data-testid="show-method-btn" onClick={() => setPopup("method")}>📊 方法选择</button>
    )}
    {transparency.assumption && (
      <button className="btn-ghost btn-sm" data-testid="show-assumption-btn" onClick={() => setPopup("assumption")}>✅ 假设检查</button>
    )}
    {transparency.quality && (
      <button className="btn-ghost btn-sm" data-testid="show-quality-btn" onClick={() => setPopup("quality")}>🧪 数据质量</button>
    )}
    {plan.length > 0 && (
      <button className="btn-ghost btn-sm" data-testid="show-plan-btn" onClick={() => setPopup("plan")}>📐 分析方案</button>
    )}
    {code && (
      <button className="btn-ghost btn-sm" data-testid="show-code-btn" onClick={() => setPopup("code")}>💻 分析代码</button>
    )}
    {output && (
      <button className="btn-ghost btn-sm" data-testid="show-output-btn" onClick={() => setPopup("output")}>📄 原始输出</button>
    )}
  </div>
)}
```

- [ ] **Step 4: 底部追加 3 个新 popup 渲染**

在第 210-214 行的 `{popup === "output" && ...}` **之后**加:

```tsx
{popup === "method" && transparency.method && (
  <Popup title="📊 方法选择(AI 为什么选这套统计方法)" onClose={() => setPopup(null)}>
    <pre className="stats-pre" data-testid="method-block">{transparency.method}</pre>
  </Popup>
)}
{popup === "assumption" && transparency.assumption && (
  <Popup title="✅ 假设检查(正态性/方差齐性等前提是否满足)" onClose={() => setPopup(null)}>
    <pre className="stats-pre" data-testid="assumption-block">{transparency.assumption}</pre>
  </Popup>
)}
{popup === "quality" && transparency.quality && (
  <Popup title="🧪 数据质量(缺失/异常处理策略)" onClose={() => setPopup(null)}>
    <pre className="stats-pre" data-testid="quality-block">{transparency.quality}</pre>
  </Popup>
)}
```

- [ ] **Step 5: draw 模式简化——只渲染图**

在 `return (` 之前(第 79 行之前)插入 draw 短路分支:

```tsx
if (mode === "draw" && chartType === "general") {
  return (
    <>
      {status && (
        <div className="status-line" data-testid="status-line"><span className="spinner" /> {status}</div>
      )}
      {error && <div className="result-error" data-testid="analyze-error">{error}</div>}
      {charts.length > 0 && (
        <div className="analysis-block" data-testid="analysis-block-draw">
          {!running && (
            <div className="charts-toolbar">
              <button className="btn-ghost btn-sm" onClick={downloadAllCharts} data-testid="download-all-charts-btn">⬇ 下载全部图片</button>
            </div>
          )}
          <div className="charts">
            {charts.map((c, i) => (
              <figure key={i} className="chart">
                <img src={`data:image/png;base64,${c.png}`} alt={`图 ${i + 1}`} data-testid={`chart-${i}`} />
                <figcaption>
                  <button
                    className="btn-ghost btn-sm"
                    data-testid={`chart-download-${i}`}
                    onClick={() => downloadBase64(tsName(`图${i + 1}`, c.ext), c.data, chartMime(c.ext))}
                  >
                    下载 {c.ext.toUpperCase()}
                  </button>
                </figcaption>
              </figure>
            ))}
          </div>
        </div>
      )}
      {!charts.length && !running && !error && (
        <div className="analyze-noimg" data-testid="analyze-noimg-draw">尚未生成图表</div>
      )}
    </>
  );
}
```

**注意**:draw 模式不渲染 popbar / disclaimer / 结论区 / 生成图注按钮(用户在 draw 模式下不需要论文级图注,只要图)。若后续用户反馈需要图注,可放开。

- [ ] **Step 6: 类型冒烟**

Run: `cd frontend && npx tsc --noEmit -p tsconfig.json`
Expected: 无错。

- [ ] **Step 7: Commit**

```bash
cd C:\Users\Administrator\Desktop\scientific-discover
git add frontend/src/modules/analyze/GeneralResults.tsx
git commit -m "$(cat <<'EOF'
feat(analyze): GeneralResults 加 3 个透明化 popup + draw 模式简化

沿用现有 popbar/Popup 模式加 方法选择/假设检查/数据质量 三个按钮;
draw 模式短路,只渲染图表下载,不显 popbar / 结论 / disclaimer。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 15: 前端 · build 并手工冒烟

**Files:** 无源码修改(纯打包 + 人工验证)

- [ ] **Step 1: build 前端 dist(见 MEMORY 中"改前端后 push 前必须 build")**

Run: `cd frontend && npm run build`
Expected: 无错误,`frontend/dist/` 更新。

- [ ] **Step 2: 启动后端 + 前端手工冒烟**

按项目现有启动方式(如 `启动科研助手.bat` 或后端 `.venv\Scripts\python.exe -m app.main`),打开数据分析页面。

**Case A · draw 模式:**
1. 选 `🎨 只画图`
2. 上传一个 CSV(建议 `survival_data.csv` 或类似)
3. 输入"画个柱状图"
4. 点开始
5. **验证**:结果区**只有图**,没有结论、没有 chip、没有大段文字

**Case B · analyze 模式:**
1. 切回 `📊 数据分析`
2. 上传同一 CSV
3. 输入"跑一下两组的 t 检验"
4. 点开始
5. **验证**:
   - 上方出现 4 个 chip:`方法选择 / 假设检查 / 数据质量 / 原始输出`(默认全折叠)
   - 结论区**直接**从 `## 核心发现` 起,没有开场白
   - 三段:核心发现 / 结果解读 / 主要局限,**没有**"方法与前提"段

**Case C · refine 继承 mode:**
1. 在 Case A 结束后,在 refine 框输入"换成箱线图",提交
2. 验证仍是 draw 表现(只出图);placeholder 是 draw 版本
3. 手动切换 mode 后再 refine(应该被视为新一轮 analyze,或 UI 层阻止 refine)

- [ ] **Step 3: 提交打包产物(可选,视仓库习惯)**

如果 `frontend/dist/` 也纳入 git(依 git status 判断):

```bash
cd C:\Users\Administrator\Desktop\scientific-discover
git add frontend/dist
git commit -m "chore(build): rebuild dist for analyze intent routing

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

否则跳过此步。

---

## Task 16: 收尾 · 更新 spec 里"落地文件清单"的实际路径(若有出入)

**Files:**
- Modify(可能):`docs/superpowers/specs/2026-07-04-analyze-intent-routing-design.md` §11

- [ ] **Step 1: 检查是否与实施一致**

对照本 plan 落地的实际文件,若 spec §11 里列的路径/文件名有任何差异(比如把 `_strip_conclusion_preamble` 实际命名成了 `_strip_conclusion_preamble_stream`),就地修 spec。

- [ ] **Step 2: 若有改动,commit**

```bash
cd C:\Users\Administrator\Desktop\scientific-discover
git add docs/superpowers/specs/2026-07-04-analyze-intent-routing-design.md
git commit -m "docs(analyze): 同步 spec 落地清单

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## 验收清单(实施完成后自检)

- [ ] 后端所有 4 个新测试脚本 `.venv\Scripts\python.exe test_XXX.py` 全部 PASS
- [ ] 旧的 `test_analyze_retry.py` 仍 PASS(无回归)
- [ ] `npx tsc --noEmit` 无新错
- [ ] `npm run build` 无警告级以上错误
- [ ] 手工冒烟 Case A / B / C 通过
- [ ] draw 模式:UI 只有图,没有 chip / 结论
- [ ] analyze 模式:结论区**直接**从 `## 核心发现` 起,4 个 chip 默认折叠
- [ ] `git log --oneline -20` 可看到每个 Task 一个 commit(共 12-14 个 commit)

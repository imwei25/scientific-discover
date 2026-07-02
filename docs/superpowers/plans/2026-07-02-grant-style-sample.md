# 写标书·文风样例模仿 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让「写标书」支持上传 Word/PDF 文风样例 → 提炼一份可编辑的中文「文风档案」→ 撰写与逐节重写时注入该档案模仿风格，并接到已有但休眠的「去 AI 味」style 参数上。

**Architecture:** 后端新增 `extract_style_profile`（非流式，把样例压成风格描述，严禁复述内容）+ 端点 `/api/grant/style`；`_section_messages`/`_revise_messages` 新增可选 `style_profile` 注入 system；`write_grant`/`revise_section` 从 inputs 透传。前端 `GrantModule` 加上传区+提炼按钮+可编辑档案框+开关，请求带 `style_profile`，并把同一档案经 `EditableMarkdown` 透传给 `DeaiPanel`（现固定传空串）。

**Tech Stack:** FastAPI + pydantic（后端）、DeepSeek/OpenAI 兼容 LLM、React + TypeScript + Vite、Playwright（e2e）、pytest（后端单测）。

**通用约定：**
- 后端 Python 一律用项目 venv：`backend/.venv/Scripts/python.exe`。
- 提交信息以 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` 结尾。
- 编辑时按**内容锚点**定位（文件近期在变，勿依赖行号）。
- 参考规范：`docs/superpowers/specs/2026-07-02-grant-style-sample-design.md`。

---

### Task 1: 后端 — 文风提炼函数 `extract_style_profile` + 环节注册

**Files:**
- Modify: `backend/app/grant.py`（新增函数，放在 `_grant_type` 附近/文件靠后处）
- Modify: `backend/app/llm.py`（`STAGES` 字典加 `grant_style`）
- Test: `backend/test_grant_style.py`（新建）

- [ ] **Step 1: 写失败测试**

新建 `backend/test_grant_style.py`：

```python
import asyncio

from app.grant import extract_style_profile


def test_extract_style_empty_returns_empty():
    # 空/纯空白样例: 不调 LLM, 直接返回空档案(降级)
    assert asyncio.run(extract_style_profile("   \n  ")) == ""
```

- [ ] **Step 2: 跑测试确认失败**

Run: `backend/.venv/Scripts/python.exe -m pytest test_grant_style.py -v`（在 `backend/` 目录下）
Expected: FAIL —— `ImportError: cannot import name 'extract_style_profile'`

- [ ] **Step 3: 实现函数**

在 `backend/app/grant.py` 里 `_grant_type` 函数之后新增（`settings`、`_complete` 已在本文件可用）：

```python
async def extract_style_profile(sample_text: str) -> str:
    """从文风样例提炼一份简短中文『文风档案』(只描述语言风格, 不复述样例内容)。

    失败/空样例返回 ""(降级=撰写时不模仿, 不阻断)。
    """
    text = (sample_text or "").strip()
    if not text:
        return ""
    if settings.mock:
        return "[MOCK] 文风档案: 句式长短交错; 用词平实、术语克制; 先总后分; 少用套话。"
    system = (
        "你是资深中文科研写作分析师。下面给你一段作者的写作样例。"
        "请只【分析并总结它的语言风格】, 产出一份 150-250 字的中文『文风档案』, 用分点或短句描述:"
        "句子长短与节奏、用词倾向(书面/平实/术语密度)、语气(克制/热情/主观)、"
        "常用的连接与过渡方式、段落展开习惯(先总后分/先例后论等)、人称与时态偏好、"
        "是否爱用排比/设问/比喻等。\n"
        "铁律: 只描述『怎么写』, 严禁复述、引用或提及样例里的任何具体研究对象、数据、结论、"
        "专有名词或原句; 不要评价好坏; 只输出文风档案本身, 不要前后缀。"
    )
    try:
        profile = await _complete(
            [{"role": "system", "content": system}, {"role": "user", "content": text[:6000]}],
            max_tokens=500, task="grant_style",
        )
    except Exception:  # noqa: BLE001
        return ""
    return profile.strip()
```

在 `backend/app/llm.py` 的 `STAGES` 字典里（`grant_revise` 那一行之后）加一行：

```python
    "grant_style": "写标书·文风提炼",
```

- [ ] **Step 4: 跑测试确认通过**

Run: `backend/.venv/Scripts/python.exe -m pytest test_grant_style.py -v`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add backend/app/grant.py backend/app/llm.py backend/test_grant_style.py
git commit -m "写标书: 新增文风提炼 extract_style_profile 与 grant_style 环节

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: 后端 — `_section_messages`/`_revise_messages` 注入文风档案 + 撰写链路透传

**Files:**
- Modify: `backend/app/grant.py`（两个消息构造器加参数与注入；`write_grant`/`revise_section` 读取并透传）
- Test: `backend/test_grant_style.py`（追加）

- [ ] **Step 1: 追加失败测试**

在 `backend/test_grant_style.py` 追加：

```python
from app.grant import _section_messages, _revise_messages

_PROFILE = "句式长短交错; 用词平实; 先总后分; 少用套话"


def test_section_messages_injects_style_when_present():
    msgs = _section_messages(
        "一、立项依据", "要点", "约500字", "面上", "侧重",
        "题名", "骨架", "报告", "文献ctx", "背景",
        style_profile=_PROFILE,
    )
    sys = msgs[0]["content"]
    assert "文风指引" in sys and "句式长短交错" in sys


def test_section_messages_no_style_by_default():
    msgs = _section_messages(
        "一、立项依据", "要点", "约500字", "面上", "侧重",
        "题名", "骨架", "报告", "文献ctx", "背景",
    )
    assert "文风指引" not in msgs[0]["content"]


def test_revise_messages_injects_style_when_present():
    msgs = _revise_messages(
        "一、立项依据", "要点", "约500字", "面上", "侧重",
        "题名", "骨架", "报告", "文献ctx", "背景", "现有正文", "改这里",
        style_profile=_PROFILE,
    )
    assert "文风指引" in msgs[0]["content"] and "先总后分" in msgs[0]["content"]
```

- [ ] **Step 2: 跑测试确认失败**

Run: `backend/.venv/Scripts/python.exe -m pytest test_grant_style.py -v`
Expected: FAIL —— `TypeError: _section_messages() got an unexpected keyword argument 'style_profile'`

- [ ] **Step 3: 实现注入**

在 `backend/app/grant.py`：

(a) `_section_messages` 签名末尾加参数（找到 `background: str,\n) -> list[dict]:` 这一处签名结尾）：

```python
def _section_messages(
    sec_title: str, guide: str, budget: str, gt_name: str, gt_hint: str,
    title: str, scheme_brief: str, report: str, refs_ctx: str, background: str,
    style_profile: str = "",
) -> list[dict]:
```

在该函数内构造好 `system` 之后、`user` 之前，插入注入（找到 `4) 用规范、严谨的中文基金申请书语体...` 结尾的那个 `)` 之后、`user = (` 之前）：

```python
    if style_profile.strip():
        system += (
            "\n\n【文风指引：在不违反上述铁律与基金申请书规范的前提下，模仿以下语言风格来遣词造句与安排节奏。"
            "它只影响“怎么写”，不提供任何事实、不改变研究内容、不新增或删改引用与数据。】\n"
            + style_profile.strip()
        )
```

(b) `_revise_messages` 签名末尾加参数（找到 `current: str, note: str,\n) -> list[dict]:`）：

```python
def _revise_messages(
    sec_title: str, guide: str, budget: str, gt_name: str, gt_hint: str,
    title: str, scheme_brief: str, report: str, refs_ctx: str, background: str,
    current: str, note: str,
    style_profile: str = "",
) -> list[dict]:
```

在其 `system` 构造之后、`user = (` 之前插入相同的注入块：

```python
    if style_profile.strip():
        system += (
            "\n\n【文风指引：在不违反上述铁律与基金申请书规范的前提下，模仿以下语言风格来遣词造句与安排节奏。"
            "它只影响“怎么写”，不提供任何事实、不改变研究内容、不新增或删改引用与数据。】\n"
            + style_profile.strip()
        )
```

(c) `write_grant` 里读取并透传。找到 `sections = _resolve_sections(inputs.get("sections"))` 附近，添加读取：

```python
    style_profile = (inputs.get("style_profile") or "").strip()
```

找到分节撰写的调用处：

```python
            msgs = _section_messages(
                s["title"], s["guide"], s["budget"], gt_name, gt_hint,
                final_title, scheme_brief, report, refs_ctx, background,
            )
```

改为在末尾传入 `style_profile`：

```python
            msgs = _section_messages(
                s["title"], s["guide"], s["budget"], gt_name, gt_hint,
                final_title, scheme_brief, report, refs_ctx, background,
                style_profile,
            )
```

(d) `revise_section` 里读取并透传。找到该函数开头读取 inputs 的区块（`scheme = inputs.get("scheme") ...` 附近），添加：

```python
    style_profile = (inputs.get("style_profile") or "").strip()
```

找到 `_revise_messages(` 调用：

```python
        msgs = _revise_messages(
            resolved["title"], resolved["guide"], resolved["budget"], gt_name, gt_hint,
            title, scheme_brief, report, refs_ctx, background, current, note,
        )
```

改为末尾传入 `style_profile`：

```python
        msgs = _revise_messages(
            resolved["title"], resolved["guide"], resolved["budget"], gt_name, gt_hint,
            title, scheme_brief, report, refs_ctx, background, current, note,
            style_profile,
        )
```

- [ ] **Step 4: 跑测试确认通过**

Run: `backend/.venv/Scripts/python.exe -m pytest test_grant_style.py -v`
Expected: PASS（4 个测试全过）

回归：`backend/.venv/Scripts/python.exe -m pytest test_review_fixes.py test_deai.py -q`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add backend/app/grant.py backend/test_grant_style.py
git commit -m "写标书: 撰写/逐节重写注入文风档案(style_profile)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: 后端 — 端点 `/api/grant/style`

**Files:**
- Modify: `backend/app/routes/text_gen.py`（新增请求模型与路由）

- [ ] **Step 1: 实现端点**

在 `backend/app/routes/text_gen.py` 里，`DeaiRewriteRequest` 类附近加一个请求模型：

```python
class GrantStyleRequest(BaseModel):
    sample: str
```

在 `grant_plan_ep`（`/api/grant/plan`）路由之后加：

```python
@router.post("/api/grant/style")
async def grant_style_ep(req: GrantStyleRequest) -> JSONResponse:
    """从上传的文风样例提炼一份『文风档案』(非流式)。失败/空样例返回空档案, 不阻断撰写。"""
    try:
        from ..grant import extract_style_profile
        return JSONResponse({"profile": await extract_style_profile(req.sample)})
    except Exception as e:  # noqa: BLE001
        log_swallow("写标书/提炼文风: 失败, 返回空档案", e)
        return JSONResponse({"profile": ""})
```

（`JSONResponse`、`log_swallow`、`BaseModel` 均已在本文件导入。）

- [ ] **Step 2: 冒烟验证端点可用（mock 模式，不花额度）**

Run（在 `backend/`）：

```bash
MOCK_LLM=1 ./.venv/Scripts/python.exe -c "
import asyncio, json
from fastapi.testclient import TestClient
from app.main import app
c = TestClient(app)
r = c.post('/api/grant/style', json={'sample':'这是一段样例文字，长短句交错。'})
print(r.status_code, r.json())
assert r.status_code == 200 and 'profile' in r.json()
r2 = c.post('/api/grant/style', json={'sample':'   '})
print(r2.json()); assert r2.json()['profile'] == ''
print('OK')
"
```

Expected: 打印 `200 {'profile': '[MOCK] 文风档案...'}`、空样例 `{'profile': ''}`、末尾 `OK`。
（若 `app.main` 的 app 变量名不同，先 `grep -n "app = FastAPI" backend/app/main.py` 确认导入路径；TestClient 仅本地内存调用，不联网。）

- [ ] **Step 3: 提交**

```bash
git add backend/app/routes/text_gen.py
git commit -m "写标书: 新增 /api/grant/style 提炼文风端点

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: 前端 — `grantStyle` API 封装

**Files:**
- Modify: `frontend/src/lib/sse.ts`（新增 `grantStyle`，放在 `planGrant` 之后）

- [ ] **Step 1: 实现封装**

在 `frontend/src/lib/sse.ts` 的 `planGrant` 函数之后新增（`apiUrl` 已在本文件导入）：

```ts
// 从文风样例提炼『文风档案』(非流式)。失败/空返回空档案, 不阻断撰写。
export async function grantStyle(sample: string, signal?: AbortSignal): Promise<{ profile: string }> {
  try {
    const resp = await fetch(apiUrl("/api/grant/style"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sample }),
      signal,
    });
    if (!resp.ok) return { profile: "" };
    const data = await resp.json();
    return { profile: typeof data.profile === "string" ? data.profile : "" };
  } catch {
    return { profile: "" };
  }
}
```

- [ ] **Step 2: 类型检查**

Run（在 `frontend/`）：`npx tsc -b`
Expected: 无错误（若首次慢属正常）。

- [ ] **Step 3: 提交**

```bash
git add frontend/src/lib/sse.ts
git commit -m "前端: 新增 grantStyle API 封装

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: 前端 — `DeaiPanel` 接收 style + `EditableMarkdown` 透传

**Files:**
- Modify: `frontend/src/components/DeaiPanel.tsx`
- Modify: `frontend/src/components/EditableMarkdown.tsx`

- [ ] **Step 1: DeaiPanel 加 `styleProfile` prop 并传给 streamDeai**

在 `frontend/src/components/DeaiPanel.tsx`：

`Props` 接口加一个可选字段：

```tsx
interface Props {
  value: string;               // 当前 Canvas 正文(Markdown)
  onApply: (md: string) => void; // 写回正文(采纳与撤回共用)
  disabled?: boolean;          // 生成中: 禁用入口, 并让上一次的撤回失效
  styleProfile?: string;       // 可选: 文风档案, 改写时让 AI 向该风格靠拢
}
```

组件签名解构加上 `styleProfile`：

```tsx
export default function DeaiPanel({ value, onApply, disabled, styleProfile }: Props) {
```

把 `startRewrite` 里的 `streamDeai(value, scan.flagged_blocks, "", {` 改为：

```tsx
    streamDeai(value, scan.flagged_blocks, styleProfile ?? "", {
```

- [ ] **Step 2: EditableMarkdown 加 `deaiStyle` prop 并下传**

在 `frontend/src/components/EditableMarkdown.tsx` 的 `Props` 接口加：

```tsx
  deaiStyle?: string;                   // 文风档案, 透传给 DeaiPanel 让"去AI味"也向样例靠拢
```

组件解构加 `deaiStyle`：

```tsx
export default function EditableMarkdown({ value, onSave, running, placeholder, testId, refInfo, deaiStyle }: Props) {
```

把 `<DeaiPanel value={value} onApply={onSave!} disabled={running} />` 改为：

```tsx
          <DeaiPanel value={value} onApply={onSave!} disabled={running} styleProfile={deaiStyle} />
```

- [ ] **Step 3: 类型检查**

Run（`frontend/`）：`npx tsc -b`
Expected: 无错误。

- [ ] **Step 4: 提交**

```bash
git add frontend/src/components/DeaiPanel.tsx frontend/src/components/EditableMarkdown.tsx
git commit -m "前端: 去AI味支持文风档案(DeaiPanel/EditableMarkdown 透传)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: 前端 — GrantModule 文风样例 UI + 请求透传

**Files:**
- Modify: `frontend/src/modules/GrantModule.tsx`

- [ ] **Step 1: 引入 grantStyle 到 import**

在 GrantModule 顶部从 `../lib/sse` 的具名导入里加上 `grantStyle`（该 import 语句已存在，把 `grantStyle` 加进去即可）。

- [ ] **Step 2: 新增状态（放在 `preResearch` 状态附近）**

```tsx
  // 文风样例: 上传样例原文 → 提炼文风档案(可编辑) → 撰写/去AI味时按开关注入。
  const [styleSample, setStyleSample] = usePersistentState("grant:styleSample", "");
  const [styleProfile, setStyleProfile] = usePersistentState("grant:styleProfile", "");
  const [styleOn, setStyleOn] = usePersistentState<boolean>("grant:styleOn", true);
  const [styleBusy, setStyleBusy] = useState(false);
  const [styleErr, setStyleErr] = useState("");
```

- [ ] **Step 3: 提炼处理函数（放在 `genPlan` 之前或附近）**

```tsx
  // 生效的文风档案: 关掉开关或没档案时为空串(=不模仿, 维持现状)。
  const effStyle = styleOn ? styleProfile : "";

  const extractStyle = async () => {
    if (!styleSample.trim() || styleBusy) return;
    setStyleErr("");
    setStyleBusy(true);
    try {
      const { profile } = await grantStyle(styleSample);
      if (profile) setStyleProfile(profile);
      else setStyleErr("未能提炼出文风档案，请换一份更完整的样例或重试。");
    } catch {
      setStyleErr("提炼文风失败（网络或服务错误），请重试。");
    } finally {
      setStyleBusy(false);
    }
  };
```

- [ ] **Step 4: 撰写/重写请求带上 style_profile**

在 `startWrite` 的 `payload` 对象（`const payload: Record<string, unknown> = { title, idea, report, background, grant_type: grantType, references: refs, research: preResearch, };`）里加一项：

```tsx
      style_profile: effStyle,
```

在 `reviseSectionWith` 里 `streamGrantRevise(` 的第一个参数对象（含 `title, report, background, grant_type: grantType, references: refs, scheme, ...`）里加一项：

```tsx
        style_profile: effStyle,
```

- [ ] **Step 5: 正文 EditableMarkdown 透传 deaiStyle**

找到写正文的 `<EditableMarkdown value={text} onSave={applyDeai} running={running} ... testId="grant-result" />`，加一个 prop：

```tsx
            deaiStyle={effStyle}
```

- [ ] **Step 6: 表单区加上传+提炼 UI（放在“研究基础/工作条件”的 Dropzone 之后、`{refs.length > 0 && ...}` 之前）**

```tsx
        <div className="field" data-testid="grant-style">
          <span className="field-label">文风样例（可选）</span>
          <p className="field-hint">
            上传一份你满意的 Word / PDF / txt（如你以往的标书或论文），AI 会<strong>提炼它的语言风格</strong>并在撰写时模仿，
            兼起去 AI 味的作用。<strong>只学“怎么写”，不会把样例里的内容或事实写进你的标书。</strong>
          </p>
          <Dropzone
            testId="grant-style-upload"
            accept=".docx,.pdf,.txt,.md"
            label="拖入文风样例"
            hint="支持 Word / PDF / txt；仅用于学习语言风格"
            mode="text"
            onText={(t) => setStyleSample(t)}
          />
          {styleSample && (
            <div className="grant-style-body">
              <div className="form-actions">
                <button
                  className="btn-secondary btn-sm"
                  data-testid="grant-style-extract-btn"
                  onClick={extractStyle}
                  disabled={styleBusy}
                >
                  {styleBusy ? "提炼中…" : styleProfile ? "重新提炼文风" : "提炼文风"}
                </button>
                <label className="type-chip" title="撰写与去 AI 味时是否模仿此文风">
                  <input
                    type="checkbox"
                    data-testid="grant-style-toggle"
                    checked={styleOn}
                    onChange={(e) => setStyleOn(e.target.checked)}
                  />
                  撰写时模仿此文风
                </label>
              </div>
              {styleErr && <div className="result-error" data-testid="grant-style-error">{styleErr}</div>}
              {styleProfile && (
                <label className="field">
                  <span className="field-label">文风档案（可编辑）</span>
                  <textarea
                    data-testid="grant-style-profile"
                    value={styleProfile}
                    rows={5}
                    onChange={(e) => setStyleProfile(e.target.value)}
                  />
                </label>
              )}
            </div>
          )}
        </div>
```

- [ ] **Step 7: reset() 清空文风状态**

在 `reset` 函数里，跟随其它 `setXxx("")` 之后加：

```tsx
    setStyleSample(""); setStyleProfile(""); setStyleOn(true); setStyleErr("");
```

- [ ] **Step 8: 类型检查 + 构建**

Run（`frontend/`）：`npm run build`
Expected: `tsc -b` 无类型错误，`vite build` 成功。

- [ ] **Step 9: 提交**

```bash
git add frontend/src/modules/GrantModule.tsx
git commit -m "前端: 写标书表单新增文风样例上传/提炼/开关, 请求带 style_profile

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: 前端 e2e —— 文风样例流程

**Files:**
- Modify: `frontend/tests/e2e.spec.ts`（新增一个 test）

**参考：** 现有 `写标书: 撰写前默认重检索文献, 且产出可编辑`（约 377 行）展示了如何 mock `/api/grant`、断言请求体（`grantBody.inputs.xxx`）。`mockBase(page)` 提供基础 mock。

**关键：** `extractFile` 会 POST 到后端 `/api/extract` 解析文件（即便是 txt），返回 `{ok, text}`。所以测试**必须 mock `/api/extract`**，其返回的 `text` 就是 `styleSample`（`setInputFiles` 的 buffer 内容此时无关紧要）。

- [ ] **Step 1: 写 e2e 测试**

在 `frontend/tests/e2e.spec.ts` 末尾（或其它 grant 测试附近）新增：

```ts
test("写标书: 上传文风样例→提炼→撰写请求带 style_profile", async ({ page }) => {
  await mockBase(page);
  // 文件解析端点: 返回样例文本(即 styleSample)
  await page.route("**/api/extract", (r) =>
    r.fulfill({ json: { ok: true, text: "这是一段作者样例文字，长短句交错，用词平实。" } }),
  );
  // 提炼端点: 返回一份固定文风档案
  await page.route("**/api/grant/style", (r) =>
    r.fulfill({ json: { profile: "句式长短交错; 用词平实; 先总后分; 少用套话" } }),
  );
  let grantBody: any = null;
  await page.route("**/api/grant", (r) => {
    grantBody = JSON.parse(r.request().postData() || "{}");
    r.fulfill({ contentType: "text/event-stream", body: sse(
      { event: "outline", data: { items: [{ key: "rationale", title: "立项依据", budget: "" }] } },
      { event: "section", data: { key: "rationale", title: "立项依据" } },
      { event: "delta", data: { text: "立项依据正文。" } },
      { event: "done", data: {} },
    ) });
  });
  await page.goto("/");
  await page.getByTestId("nav-grant").click();
  // 直接填题名即可开始(无需从选题带入)
  await page.getByTestId("grant-title").fill("测试项目");
  // 上传一份 txt 文风样例
  await page.getByTestId("grant-style-upload").setInputFiles({
    name: "sample.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("这是一段作者样例文字，长短句交错，用词平实。", "utf-8"),
  });
  // 提炼 → 出现可编辑档案框
  await page.getByTestId("grant-style-extract-btn").click();
  await expect(page.getByTestId("grant-style-profile")).toHaveValue(/先总后分/);
  // 一步到位撰写
  await page.getByTestId("grant-oneshot-btn").click();
  await expect(page.getByTestId("grant-result")).toContainText("立项依据正文");
  // 请求体带上了 style_profile
  expect(grantBody.inputs.style_profile).toContain("先总后分");
});
```

若 `nav-grant` 的 testId 名称不同，先在测试文件里 `grep` 现有导航点击方式（如 `getByTestId("nav-...")`）对齐；`sse`、`mockBase`、`Buffer` 的用法参照本文件既有测试。

- [ ] **Step 2: 跑该测试**

Run（`frontend/`）：`npx playwright test -g "上传文风样例" --reporter=line`
Expected: 1 passed。（若因导航/选择器命名不符而失败，按实际 testId 调整后重跑。）

- [ ] **Step 3: 回归其它 grant e2e**

Run：`npx playwright test -g "写标书" --reporter=line`
Expected: 全部 passed。

- [ ] **Step 4: 提交**

```bash
git add frontend/tests/e2e.spec.ts
git commit -m "e2e: 写标书文风样例上传→提炼→撰写带 style_profile

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: 真实 API 冒烟 + 构建 + CHANGELOG + 推送

**Files:**
- Modify: `CHANGELOG.md`（「未发布 / 写标书」区加一条用户可感知变化）
- 临时脚本放 scratchpad，不进仓库。

- [ ] **Step 1: 真实 API 冒烟（防串 + 风格靠拢）**

在 scratchpad 写脚本，用真实 `extract_style_profile` + 真实 `_section_messages` 跑一节，验证：(a) 档案非空且不含样例植入的专有名词；(b) 有/无档案两版都能正常产出、引用/支持句核验照常。示例（写到 UTF-8 文件再读，避免 GBK 乱码）：

```python
# 放 scratchpad; sys.path.insert 到 backend
import asyncio, sys
sys.path.insert(0, r"C:\Users\wei gu\Desktop\科研助手\backend")
from app.grant import extract_style_profile, _section_messages, _GRANT_TYPES, _SECTION_MAP
from app.llm import stream_chat

SAMPLE = ("本课题拟围绕线粒体自噬调控机制展开。前期我们在小鼠模型中观察到，"
          "PINK1 缺失显著加重心肌缺血损伤（这是样例里的独有事实，不该出现在档案里）。"
          "行文上，我偏好短句，先摆结论再展开，少用套话与排比。")

async def run(msgs, task):
    buf=""
    async for p in stream_chat(msgs, task=task, max_tokens=900): buf+=p
    return buf

async def main():
    prof = await extract_style_profile(SAMPLE)
    leaked = any(w in prof for w in ["PINK1","心肌缺血","小鼠"])
    gt = _GRANT_TYPES["general"]
    msgs = _section_messages("一、立项依据与研究意义", _SECTION_MAP["rationale"][1], "约500字",
        gt[0], gt[1], "某机制研究", "关键科学问题: X", "（见报告）", "（无可引用文献）", "",
        style_profile=prof)
    body = await run(msgs, "grant_write")
    open("style_smoke.txt","w",encoding="utf-8").write(
        f"档案:\n{prof}\n\n泄漏专有名词: {leaked}\n\n正文:\n{body}\n")

asyncio.run(main())
```

Run: `cd scratchpad && "…/backend/.venv/Scripts/python.exe" style_smoke.py`，然后读 `style_smoke.txt`。
Expected: 档案非空、`泄漏专有名词: False`；正文正常成文（若含引用则链接完整）。若泄漏为 True，收紧 `extract_style_profile` 的铁律措辞后重跑。

- [ ] **Step 2: 前端最终构建**

Run（`frontend/`）：`npm run build`
Expected: 成功。

- [ ] **Step 3: CHANGELOG 记一条**

在 `CHANGELOG.md` 的 `## 未发布` → `### 写标书`（或 `### 找选题 / 写标书`）区加：

```markdown
- **新增：上传"文风样例"，让 AI 照你的文风写标书（兼去 AI 味）**：在写标书表单里可上传
  一份你满意的 Word/PDF/txt（如以往的标书或论文），点「提炼文风」后 AI 会总结出一份可编辑的
  「文风档案」（句式节奏、用词、语气、段落习惯等）；撰写与逐节重写时按此风格下笔，「去 AI 味」
  也会向它靠拢。只学“怎么写”，不会把样例里的内容或事实写进你的标书；不上传或关掉开关即维持原样。
```

- [ ] **Step 4: 提交并推送**

```bash
git add CHANGELOG.md
git commit -m "docs: CHANGELOG 记录写标书文风样例模仿

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
git push origin main
```

- [ ] **Step 5: 收尾自检**

- 不上传样例时，`/api/grant` 请求 `style_profile` 为空串，行为与之前一致（人工点一次确认）。
- `dist/` 已随构建更新并提交（本项目 dist 纳入版本管理）。

---

## 附：涉及文件总览

- 后端：`backend/app/grant.py`（提炼函数 + 两处注入 + 两处透传）、`backend/app/llm.py`（STAGES）、`backend/app/routes/text_gen.py`（端点）、`backend/test_grant_style.py`（单测）。
- 前端：`frontend/src/lib/sse.ts`（grantStyle）、`frontend/src/components/DeaiPanel.tsx`、`frontend/src/components/EditableMarkdown.tsx`、`frontend/src/modules/GrantModule.tsx`、`frontend/tests/e2e.spec.ts`。
- 文档：`CHANGELOG.md`。

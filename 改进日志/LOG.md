# 改进日志 (LOG)

> 每完成一个改进方向追加一条。最新在最上。

<!-- 模板：
## YYYY-MM-DD HH:MM — <子任务> / <方向标题>
- **现状/动机**：为什么要改
- **改动**：具体做了什么（文件、关键逻辑）
- **测试**：像真实用户那样验证的步骤与结果
- **commit**：<short-hash>
-->

## 2026-06-27 — 子任务D 前端体验 / D6 流式出错不再误存历史
- **现状/动机**：四个模块（idea/plan/analyze/format）的“完成后存历史” effect 守卫都是 `!running && text && savedRef!==text`，**没判 error**。当流式过程中先产出了部分内容再报错时，`running` 翻 false、`text/conclusion` 是残缺内容 → 被当成功结果存进历史，用户在历史里看到断章且不知其失败。
- **改动**：四个模块的 effect 守卫统一加 `!error`，并把 `error` 加入依赖数组：`AnalyzeModule`、`PlanModule`、`IdeaModule`、`FormatModule`。
- **测试**（Playwright）：① `tsc --noEmit` 通过；② 新增 e2e：mock `/api/run` 先发 delta 残缺内容再发 error，跑实验规划后断言显示错误、且历史里**不出现**该标题（修复前会出现）；③ **全量 23 个 e2e 全过**。
- **部署**：已 `npm run build` 重建 dist。
- **commit**：见下次提交

## 2026-06-27 — 子任务C 稳定性 / C3-c 后端上传大小上限(防直连绕过)
- **现状/动机**：前端已挡 30MB（C3-b），但 LAN/直连 API 会绕过前端。`/api/analyze`、`/api/extract` 用 `await file.read()` 一次性读全部，超大文件可拖垮内存/磁盘。需后端再设一道。
- **改动**：`backend/app/main.py` 新增 `MAX_UPLOAD_BYTES=30MB` 与 `_read_capped()`（按 1MB 分块读，累计超限立即停并返回 None，不把超大文件整体读入）。两个上传端点改用之：超限时 analyze 返回 SSE error 事件、extract 返回 `{ok:False,error}`，都给“文件过大”友好提示。limit 改为调用时读模块全局，便于测试覆盖。
- **测试**（.venv 离线）：① 新增 `test_upload_limit.py`：`_read_capped` 单元（小文件完整/超限 None/恰好等于/空文件）+ **TestClient 端到端** `/api/extract`（临时把上限调 1KB，超限返 ok=False+“过大”、正常小文件 ok=True）；② 全部 7 个后端测试 + `import app.main` 通过。
- **commit**：见下次提交

## 2026-06-27 — 子任务C 稳定性 / C3-b 上传文件大小校验
- **现状/动机**：`Dropzone` 对选中的文件不做任何大小校验。用户拖入超大文件（如几百 MB 的 CSV/PDF）会被整个读入内存（前端抽取或后端 `file.read()`），导致页面卡死/上传巨慢/后端 OOM，且全程无提示。四个模块都用 Dropzone，缺口一致。
- **改动**：`frontend/src/components/Dropzone.tsx` 加 `MAX_UPLOAD_BYTES=30MB`；`handle()` 先查大小，超限即 `setErr("文件过大（X MB），请上传小于 30MB 的文件。")` 并 return，不进入 onFile/onText（不交给上层与后端）。
- **测试**（Playwright）：① `tsc --noEmit` 通过；② 新增 e2e：向数据分析的 input-file `setInputFiles` 一个 31MB 文件，断言显示 `input-file-error` 含“文件过大”、且无 `input-file-info`（未进入“已选择”）——无此守卫该用例会失败；③ **全量 22 个 e2e 全过**。
- **部署**：已 `npm run build` 重建 dist。
- **遗留**：后端 `/api/analyze`、`/api/extract` 也应加大小上限防直连绕过（记入 BACKLOG C3-c）。
- **commit**：见下次提交

## 2026-06-27 — 子任务E 检索与引用 / E3-a PubMed 检索 NCBI 限速节流
- **现状/动机**：`literature.py` 的 docstring 自己写了“限速 3 次/秒”，但代码没有任何节流。深度调研流程会连发 4-5 个 facet 的 esearch + gap 查询 + efetch，紧挨着发出，轻松超过 3 次/秒。NCBI 超限返回 429（甚至临时封 IP），而调用处 `except: continue` 会**静默吞掉**——表现为“未检索到文献”时有时无，损害旗舰“找选题”功能可靠性。
- **改动**：`backend/app/literature.py` 新增全局异步节流 `_throttle()`（`asyncio.Lock` + `time.monotonic`，间隔 `_NCBI_MIN_INTERVAL=0.34s`），在每次 esearch/efetch 的 GET 前 `await _throttle()`。并发与顺序都被串行拉开。
- **测试**（.venv 本地计时，零成本）：① 新增 `test_ncbi_throttle.py`：顺序 6 次耗时≥5×0.34s、相邻瞬时速率≤3/秒、并发 4 次也被串行拉开≥3 间隔，全 PASS；② 既有 5 个后端测试全过、`import app.main` 通过，无回归。
- **commit**：见下次提交

## 2026-06-27 — 子任务D 前端体验 / D5 文件下载健壮性 + 首个真实下载测试
- **现状/动机**：`downloadText` 创建对象 URL、`a.click()` 后**同步立即** `URL.revokeObjectURL`，且锚点未挂到 DOM。这是已知陷阱：部分浏览器要求锚点在 DOM 中才触发下载；大文件（数据分析报告内嵌多张 base64 图，可达数 MB）在 click 后被立即 revoke 会中断下载。导出按钮此前只有“可见”断言，真实下载路径零覆盖。
- **改动**：`frontend/src/lib/download.ts` 的 `downloadText`：锚点 `appendChild` 到 body、`display:none`，click 后用 `setTimeout(…,1000)` 延迟 `revokeObjectURL` 并移除锚点。
- **测试**（Playwright，mock 后端）：① `tsc --noEmit` 通过；② 新增 e2e：实验规划出结果后点“导出 Markdown”，用 `page.waitForEvent('download')` 捕获下载，断言文件名匹配 `实验计划-YYYYMMDD-HHMM.md` 且读取文件内容含正文——真正走通 downloadText；③ **全量 21 个 e2e 全过**。
- **部署**：已 `npm run build` 重建 dist。
- **commit**：见下次提交

## 2026-06-27 — 子任务D 前端体验 / D4 历史记录配额不足时静默丢失修复
- **现状/动机**：`history.addHistory` 写 localStorage 失败时 `catch{}` 直接忽略——新记录被静默丢弃。30 条历史每条都存整段结果文本（idea/plan/analyze 结论可达数十 KB），叠加各模块自身的结果持久化键，localStorage 容易撑满，此后历史**默默停止记录**，用户却以为存上了。（注：复盘发现历史 data 实际不含 base64 图，仅含文本；早先描述有误，特此更正——修复本身不受影响。）
- **改动**：`frontend/src/lib/history.ts` 的 `addHistory` 改为：写失败时逐步把列表减半（`Math.ceil(len/2)`，保留含最新的较新一半）后重试，直到写入成功或只剩 1 条仍放不下才放弃。最新记录因始终在 index 0 而总能存下（只要它本身不超额）。
- **测试**（Playwright，mock 后端零成本）：① `tsc --noEmit` 通过；② 新增 e2e 用例：预置 8 条较大旧历史并 override `Storage.setItem` 对 `ra:history` 施加 1200 字节上限触发淘汰，跑一次实验规划后断言历史第一条是“最新研究课题”（证明没被丢）且总条数 <9（证明发生淘汰）——旧实现此用例会失败；③ **全量 20 个 e2e 全过**，无回归。
- **部署**：已 `npm run build` 重建 `frontend/dist`。
- **commit**：见下次提交

## 2026-06-27 — 子任务F 部署易用性 / F-a PORT 配置健壮性（修复启动崩溃）
- **现状/动机**：`config.py` 用 `int(os.getenv("PORT","8756"))`，在**模块导入期**执行。若用户在 `.env` 把 PORT 写空（`PORT=`）或写成非数字，`int("")` 抛 ValueError，`from .config import settings` 直接崩，服务器起不来、只在 server.log 留个天书 traceback。项目有大量端口相关脚本，用户改 .env 改坏 PORT 是真实场景。
- **改动**：`backend/app/config.py` 新增 `_int(name, default, lo, hi)`：空/纯空格/非法/越界都回退默认；`port` 改为 `_int("PORT", 8756, lo=1, hi=65535)`，顺带限定合法端口范围。
- **测试**（.venv 离线）：① `test_config.py` 9 例全过（空/空格/非数字/越界/合法/带空格/未设置）；② 复现场景：`PORT=""` 时 import app.config 不再崩、port 回退 8756；③ 既有 4 个后端测试（fallback/network_retry/textio/danger_guard）全过；④ `import app.main` 通过。
- **commit**：见下次提交

## 2026-06-27 — 子任务C 稳定性 / C3-a 数据分析安全护栏误杀修复
- **现状/动机**：`dataanalysis._DANGER` 用 `\b(...|eval\s*\(|open\s*\()` 判危险。`\b` 是零宽词边界，`df.eval("a+b")`（合法 pandas）里 `.` 与 `eval` 间也算边界，于是被当成危险调用**误杀**，正常分析被拒并弹“包含不被允许的操作”。同时内置 `exec(` 当时未拦（注入面）。
- **改动**：`backend/app/dataanalysis.py` 重写 `_DANGER`：模块/名称类仍用 `\b`；`eval/exec/open` 改为 `(?<![\w.])(?:eval|exec|open)\s*\(`——仅匹配“前面不是 . 或字母”的内置函数形式。这样挡住注入/读文件，又放行 `df.eval()`、`df.query()`、`re.compile()`、含 open 的列名。
- **测试**（.venv 离线）：① `test_danger_guard.py` 12 例全过（合法 5 放行 / 危险 7 拦截，含新增 exec）；② **端到端** `_execute`：`df.eval` 代码 ok=True 输出 sum_c=21（修复前会被拒），`subprocess` 仍被拦并给友好中文；③ `import app.main` 通过。
- **commit**：见下次提交

## 2026-06-27 — 子任务E 检索与引用 / E2 文档提取编码健壮性
- **现状/动机**：`extract.py` 抽取上传文档文本。两处编码缺陷：① `.csv` 用 `pd.read_csv` 默认 utf-8，GBK 文件崩溃；② `.txt/.md` 用 `content.decode("utf-8","ignore")`，GBK 文件里每个中文都是非法 utf-8 被 ignore **静默丢弃**——实测 14 个中文字只剩 1 个、正文变乱码，比报错更危险（用户拿到空/garbage 稿件却不知情）。
- **改动**：新增共享模块 `backend/app/textio.py`，提供 `decode_text()` 与 `read_csv_bytes()`，统一编码回退链 `utf-8-sig→utf-8→gb18030→latin-1`。`extract.py` 的 csv/txt 改用之；`dataanalysis.py` 删除自己的重复实现、改 import 共享工具（DRY）。
- **测试**（.venv 离线）：① 新增 `test_textio.py`：txt 的 GBK/带BOM/utf-8 均保留全文、GBK csv 正确提取、`_load` GBK 回归、decode 任意字节不抛错，全 PASS；② `test_fallback.py`/`test_network_retry.py` 全过（确认 dataanalysis 重构无回归）；③ `import app.main` 通过。
- **commit**：见下次提交

## 2026-06-27 — 子任务D 前端体验 / D2 复制按钮在局域网 http 下失效修复
- **现状/动机**：`navigator.clipboard` 仅在安全上下文（https/localhost）可用。本应用主推**局域网 http 访问**（仓库带 `允许局域网访问.bat`/`诊断局域网.bat`），此时 `navigator.clipboard` 为 undefined，复制按钮直接抛错、静默失效。两处中招：`ResultPanel.tsx`（四大模块共用的复制）与 `FormatModule.tsx` 的“复制全部”。
- **改动**：新增 `frontend/src/lib/clipboard.ts` 的 `copyToClipboard()`：安全上下文用现代异步 API，否则/失败时回退到临时 textarea + `execCommand('copy')`，返回布尔成功值。两处调用改用它；`ResultPanel` 复制状态从布尔改为 `ok|fail|null`，失败显示“复制失败”。
- **测试**（前端 Playwright，mock 后端零成本）：① `tsc --noEmit` 通过；② 新增 e2e 用例：`addInitScript` 把 `window.isSecureContext=false` 且 `navigator.clipboard=undefined` 模拟局域网 http，点击复制后断言按钮显示“已复制”（证明 execCommand 兜底生效、不抛错）；③ **全量 19 个 e2e 全过**，无回归。
- **部署**：仓库版本管理 `frontend/dist`，已 `npm run build` 重建 dist，确保 `git pull` 即获修复界面。
- **commit**：见下次提交

## 2026-06-27 — 子任务C 稳定性 / C1 网络错误友好化 + 重试 + 降级
- **现状/动机**：`llm._stream_openai/_anthropic` 用 httpx，网络超时/连不上会抛**原始 httpx 异常**，绕过 `LLMError`，在 `/api/run` 落到 `except Exception` → 用户看到 “内部错误: ConnectTimeout(...)” 之类天书；且无任何重试，弱网下一闪断就整次失败；也不会切备用。
- **调研**：读 `main.py` 确认三个端点的错误路径；读 `test_fallback.py` 确认改动需保持其 4 个断言（401 非配额不降级、mid-stream 不重复降级等）不破。
- **改动**：`backend/app/llm.py`：① `LLMError` 增 `retryable` 标志；② `_stream_with` 捕获 `httpx.TimeoutException/ConnectError/RequestError`，包装成友好中文且 `retryable=True` 的 `LLMError`；③ `stream_chat` 改为带重试循环：未产出内容时对瞬时错误退避重试 `_MAX_RETRIES=2` 次，重试耗尽后“配额错误 **或** 网络持续不可达”都尝试备用供应商；已产出内容则直接抛出不重试（防重复）。
- **测试**（.venv 离线零成本）：① `test_fallback.py` 4 项全过，无回归；② 新增 `backend/test_network_retry.py` 4 项全过：httpx 错误→友好可重试 LLMError、持续超时→重试2次再降级、第二次成功不降级、mid-stream 断网不重试不重复；③ `import app.main` 通过。
- **commit**：见下次提交

## 2026-06-27 — 遗留 P1 / 参考文献页码区间渲染修复
- **现状/动机**：Vancouver CSL 用 `page-range-format="minimal"`，citeproc-py 的 minimal 实现对“尾页位数多于首页”的区间出错：`1-10`→`1–0`、`99-100`→`99–0`，给用户错误页码。
- **调研**：读 Vancouver CSL 确认是 minimal 缩写规则；逐一测试不同页码，定位仅“尾页位数 > 首页”这一类出错，其余（1234-1245→1234–45 等 ICMJE 缩写）本是正确行为。验证 `style.root.set('page-range-format', …)` 可在样式对象上覆盖。
- **改动**：`backend/app/citations._resolve_style` 检测到 `minimal` 时强制改为 `expanded`，输出完整页码区间——永不产生错误，用户粘贴的本就多是完整区间。
- **测试**：① 渲染 6 组页码全 PASS（1-10→1–10、99-100→99–100、100-110→100–110、e123 不变等）；② **真实 LLM 端到端** `format_references`：3 条（含 URL-DOI vs 裸DOI 重复）→ 去重 1 条 + note 提示 + 页码 1–10/100–110 正确。
- **commit**：见下次提交

## 2026-06-26 — 子任务E 检索与引用 / E1 引用去重 + DOI 归一化
- **现状/动机**：`format_references` 把 LLM 解析出的 CSL-JSON 直接渲染。真实用户常粘贴重复条目（同一篇 DOI 一次写成 `https://doi.org/…` 一次写成裸 DOI），结果会重复列出；DOI 前缀也不统一。
- **调研/测试发现**：离线用 citeproc 复现，确认重复条目原样输出、无任何归一化。顺带发现页码 `1-10` 被渲染成 `1–0`（见遗留 P1）。
- **改动**：`backend/app/citations.py` 新增 `_normalize_doi`（去 `https://doi.org/`、`doi:` 等前缀）、`_dedup_key`（优先 DOI，否则 标题+年份+第一作者；无可识别信息则不参与去重，避免误删）、`_normalize_and_dedup`（规整+去重+重排连续 id）。`format_references` 在渲染前调用，并在去重时返回 `note` 提示去掉了几条。
- **测试**（.venv 离线）：① DOI 三种写法归一化 PASS；② URL-DOI 与裸 DOI 判同、无 DOI 靠元数据判同、独特条目保留、无信息条目不误删，全 PASS；③ 真实链路 `_parse_json_array→_normalize_and_dedup→render`：3 条→去重 2 条，Vancouver 渲染正常；④ `import app.main` 通过。
- **遗留**：P1 页码范围渲染（1-10→1–0）记入 BACKLOG 待后续修。
- **commit**：见下次提交

## 2026-06-26 — 子任务B 数据分析 / B4 CSV 编码健壮性
- **现状/动机**：`dataanalysis._load` 用 `pd.read_csv` 默认 utf-8 读取。中文用户从 Excel“另存为 CSV”得到的多是 GBK/ANSI 或带 BOM 的 utf-8-sig，上传后直接 `UnicodeDecodeError` 崩溃，对非 IT 用户是致命体验问题。子进程沙箱里的 `_load` 同样有此缺陷。
- **调研**：确认 Python 标准编码名是 `gb18030`（gbk/gb2312 超集），不是 gb18031；latin-1 解码任意字节、作兜底。复现脚本证实默认读取对 GBK 字节抛 0xd7 错误。
- **改动**：`backend/app/dataanalysis.py` 新增 `_CSV_ENCODINGS=(utf-8-sig, utf-8, gb18030, latin-1)` 与 `_read_csv_bytes()`，`_load` 改走它；子进程 `_RUNNER._load` 同步加同样的编码回退链。Excel 路径不变。
- **测试**（.venv，离线零成本）：① `_load` 对 GBK / utf-8-sig / utf-8 三种 CSV + .xlsx 全部 PASS，列名/行数正确；② `_execute` 子进程沙箱用 GBK 文件跑 groupby(中文列名) ok=True 输出正确；③ `import app.main` 通过；④ `test_fallback.py` 全过，无回归。
- **commit**：见下次提交

- **动机**：建立自动改进循环的状态与日志基础设施。
- **改动**：新增 `改进日志/`（LOOP改进指令.md、BACKLOG.md、LOG.md）；把"持续改进科研助手"拆成 6 个子任务（生成质量/数据分析/稳定性/前端/检索引用/部署），每个列 3 个初始改进方向。
- **测试**：本轮为拆解，无功能改动；确认 git 仓库可 commit/push。
- **commit**：见下次提交

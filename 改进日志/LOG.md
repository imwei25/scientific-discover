# 改进日志 (LOG)

> 每完成一个改进方向追加一条。最新在最上。

<!-- 模板：
## YYYY-MM-DD HH:MM — <子任务> / <方向标题>
- **现状/动机**：为什么要改
- **改动**：具体做了什么（文件、关键逻辑）
- **测试**：像真实用户那样验证的步骤与结果
- **commit**：<short-hash>
-->

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

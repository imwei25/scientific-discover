# 改进日志 (LOG)

> 每完成一个改进方向追加一条。最新在最上。

<!-- 模板：
## YYYY-MM-DD HH:MM — <子任务> / <方向标题>
- **现状/动机**：为什么要改
- **改动**：具体做了什么（文件、关键逻辑）
- **测试**：像真实用户那样验证的步骤与结果
- **commit**：<short-hash>
-->

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

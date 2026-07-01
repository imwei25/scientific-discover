# 入口改进循环 · Entry Improvement Loop

自动化循环：每一轮针对一个「入口」派 agent 批判 → 制定改进计划 → 执行 → 记录起因与效果。
每约 30–45 分钟触发一轮（cron，仅当会话空闲时触发，不会打断进行中的轮次）。

## 入口轮换顺序

按下列顺序轮换，一轮处理一个入口；走完一圈从头再来，寻找新的问题。

| # | 入口 | 说明 | 文档 |
|---|------|------|------|
| 1 | home | 首页 / hero + 卡片总览 | [home.md](home.md) |
| 2 | idea | 找选题 | [idea.md](idea.md) |
| 3 | grant | 写标书 | [grant.md](grant.md) |
| 4 | plan | 实验规划 | [plan.md](plan.md) |
| 5 | ethics | 伦理材料 | [ethics.md](ethics.md) |
| 6 | analyze | 数据分析与写作 | [analyze.md](analyze.md) |
| 7 | imrad | 论文初稿 | [imrad.md](imrad.md) |
| 8 | journal | 智能选刊 | [journal.md](journal.md) |
| 9 | format | 期刊排版 | [format.md](format.md) |
| 10 | rebuttal | 回复审稿 | [rebuttal.md](rebuttal.md) |

## 轮换指针

- **下一轮处理**：`imrad`（第 1 圈 · 第 7 轮）
- **已完成轮次**：
  - 第 1 圈 · home（2026-07-02）— 概览 eyebrow 澄清「工具可单独用」+ 清理首页死/冲突 CSS。详见 [home.md](home.md)。
  - 第 1 圈 · idea（2026-07-02）— 新增「复制报告」按钮 + 结果工具栏换行防溢出 + 状态文字 CJK 排版修正。详见 [idea.md](idea.md)。
  - 第 1 圈 · grant（2026-07-02）— 输入门槛提示（禁用按钮自解释）+ 修「必填」自相矛盾 + 「收起」改「返回修改（内容不丢）」。详见 [grant.md](grant.md)。
  - 第 1 圈 · plan（2026-07-02）— 修真实 bug：样本量真正带入 AI 方案/SAP + 门槛提示 + 按钮行换行。详见 [plan.md](plan.md)。
  - 第 1 圈 · ethics（2026-07-02）— 必填校验（红星标记 + 缺项禁用下载并列出）+ 修「从实验规划导入」静默失败。详见 [ethics.md](ethics.md)。
  - 第 1 圈 · analyze（2026-07-02）— 修 xlsx+KM/ROC 死路（可手动输入列名）+ 结论工具栏编组 + 复制结论按钮。详见 [analyze.md](analyze.md)。

## 每轮记录格式（写入对应入口的 md）

```
## 第 N 圈 · YYYY-MM-DD HH:MM

### 起因（批判要点）
- ...

### 改动
- 文件:行 — 做了什么

### 预期效果
- ...
```

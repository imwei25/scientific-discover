> 来源：search-lit/SKILL.md 原「一个会话里做多轮检索：第 2 次起必须带 --tag」节原样搬出（渐进披露）。同一会话要跑第 2 轮及以后的检索、或看到 stderr 报 .bak 改名告警时读。

## 一个会话里做多轮检索：第 2 次起必须带 `--tag`（否则前一次的证据表就没了）

`enhanced_search.py` 与 `literature-review/search.py` 默认都写**固定名**
`evidence_table.csv` / `evidence.md`。同一会话里分概念、分主题、分轮次检索时，**不带 `--tag`
的第二次运行不会覆盖第一次**——脚本先把同名旧产物改名成 `evidence_table.csv.bak`
（已有 `.bak` 就 `.bak2`、`.bak3`……）让位，并在 stderr 报出改名了哪些文件，数据不会丢。
但下游（`idea-forge`、`grant-proposal`、`zotero push`、写综述时读表）按固定名取表，
只会读到**最后一次**检索的结果，前几轮都躺在 `.bak` 里没人看。所以多轮检索仍要带 `--tag`。

- **每一轮检索都给一个短标签**：`--tag drug` → `evidence_table__drug.csv` /
  `evidence__drug.md`；也可以 `--out my_pool.csv` 显式指定（`.md` 用同一 stem）。
- 只有本会话**第一次也是唯一一次**检索时才可以不带 `--tag`（保持默认名，下游省事）。
- 不带 `--tag` 而目标文件已存在，脚本会把旧表改名成 `.bak` / `.bak2` / `.bak3`… 并在 stderr
  **响亮告警**——看到就说明你刚把上一轮挤到备份里了：要么改带 `--tag` 重跑，要么在汇报时
  明确告诉用户上一轮的表现在叫什么名字。`.bak` 只是兜底，不是正常工作方式。
- 想把多个概念**合成一张表**，不要分次跑：把多个检索式作为**多个位置参数**传给同一次调用
  （`search.py` 默认 AND 交集、`--union` 并集；`enhanced_search.py` 跨式跨源去重合并）。
- 汇报与交给下游时，**明确说清用的是哪张表**（带标签的文件名），别笼统说"证据表"。

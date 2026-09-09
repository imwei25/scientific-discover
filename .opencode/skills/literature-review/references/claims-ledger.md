# 论断台账：受控词表、contradiction.py 用法与冲突裁定判据（阶段 3）

> 本文件从 SKILL.md「阶段 3 — 论断台账 + 跨文献矛盾扫描」搬出，由 SKILL.md 在建台账前定受控词表、跑 `contradiction.py`、以及逐个裁定冲突组时引用。完整参数以 `python contradiction.py --help` 为准。

## 建账前先定受控词表（本流程头号陷阱）
   - ⚠️ **建账前先定一张受控词表**（canon_i/canon_o 的归一是矛盾扫描成败关键，**必须先定、边建边对**，否则同义标签写岔 → 真矛盾被拆进多个"一致"组、脚本只标出零星几个、你误以为"没什么争议"就发出低估争议的综述——这是本流程头号陷阱）。做法：先浏览一遍命中文献，把**同一干预/暴露、同一结局的各种写法收敛到一个标签**，落一张小表再逐条套用。医学常见归一示例：

     | 各种写法 | 统一 canon |
     |---|---|
     | vitamin D / vitamin D supplementation / vitamin D status / serum 25(OH)D | `vitamin_d` |
     | death / mortality / all-cause mortality / survival | `all_cause_mortality` |
     | CV death / cardiovascular mortality / CVD mortality | `cv_mortality` |
     | MACE / major adverse cardiovascular events / CV events | `mace` |

     **注意"暴露 vs 干预"别混**：血清 25(OH)D 水平（观察性暴露）与补充维生素D（RCT 干预）机制上是两回事——若你要比的是"补充是否有效"，把二者归到同一 canon 才能让观察性↑风险 vs RCT 无效**正面撞上**；若要分开讨论就用不同 canon，但要清楚自己在比什么。

## 扫矛盾：contradiction.py 用法
```
"${REPO_ROOT:-/app}/.venv/bin/python" "${REPO_ROOT:-/app}/.opencode/skills/literature-review/contradiction.py" --input claims_ledger.csv
```

## 逐个裁定的四档判据（脚本只标候选、不下判决；这步是主代理的活）
对每个 ⚠️ 冲突组判四选一，写 `outputs/contradiction_matrix.md`——
   - **TRUE 真矛盾**：P/剂量/时点/定义可比 **且** 证据强度相当，方向仍相反 → 综述里明写争议。
   - **RECONCILABLE 可调和**：差在人群/剂量/时点/结局定义/校正 → 记下**是哪根轴**。
   - **WEIGHT 证据分级可解**：一方 meta/大 RCT 低偏倚、另一方小观察/个案 → 按等级取强弱、注明层级。
   - **SPURIOUS 伪冲突**：抽取错/其实是不同结局被误配 → 丢弃并说明。
   - **默认偏向 RECONCILABLE**；判 TRUE 前对涉事文献用 `fulltext-retrieval` 读全文再定；**绝不静默删掉冲突一方**。

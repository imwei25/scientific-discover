# 完整走一遍：草酸钙 → 内质网应激 → 铁死亡

这是**一个示例**，不是模板铁律。它来自原始规范里被写成"每张图都必须包含"的那条通路
（`GRP78/CHOP/ATF4/PERK/IRE1` + `CHAC1/GSH/GPX4` + `CaOx`）——那样写是错的：
把一条具体通路当成通用要求，等于给每张图都塞进一套与本研究无关的分子名。
在这里它的身份是**参考案例**：看一个真实机制怎么落成 spec，以及各字段的粒度该多细。

## 用户给的东西（假设）

> 我们做的是高草酸尿导致的肾结石。发现草酸钙晶体刺激 HK-2 细胞后，GRP78、PERK、IRE1 通路被
> 激活，ATF4 和 CHOP 上调；CHOP 进核后诱导 CHAC1，CHAC1 降解谷胱甘肽（GSH），GPX4 活性下降，
> 细胞出现铁死亡，同时有一部分凋亡；最终肾小管上皮破损、草酸钙晶体沉积。

## 第 ① 步：填 spec

见 `templates/spec.example.json`（就是这个案例，可直接跑）。填的时候做的判断：

- **4 栏**，因为这个机制真的是四步：刺激 → 内质网应激 → 氧化还原崩溃 → 组织结局。
  **不是因为"规范说 4 栏"**。如果用户只说到"应激→铁死亡"，就填 2 栏。
- 标签**只放材料里出现的**：`Hyperoxaluria`、`CaOx`、`GRP78 ↑`、`PERK`、`IRE1`、`ATF4 ↑`、
  `CHOP ↑`、`Nucleus`、`CHAC1 ↑`、`GSH`、`GPX4 ↓`、`Ferroptosis`、`Apoptosis`、
  `CaOx crystal deposition`。材料没提 `SLC7A11`、`ACSL4`、`Nrf2` 这些同领域常见分子，
  **一个都不加**——哪怕加上去"更完整"。
- `↑ / ↓` 只加在材料明确说了方向的分子上（`GRP78 ↑` 说了上调，`PERK` 只说"被激活"就不加箭头）。
- 关系描述（`GSH degradation`）放 `arrows[].label`，不放 `panels[].labels`：它是过程，不是实体。

## 第 ② 步：编译过闸

```bash
"${REPO_ROOT:-/app}/.venv/bin/python" \
  "${REPO_ROOT:-/app}/.opencode/skills/mechanism-figure/scripts/build_prompt.py" \
  --spec fig1.spec.json --source ms.txt --json fig1.built.json
```

用上面那段中文当 `ms.txt`，实际输出：

```
[warn] 箭头上的关系描述在材料里找不到原词（多半是中文材料的英文表述，正常）：GSH degradation。
       请确认它描述的关系确实是材料支持的。
[ok] 已写 fig1.built.json
[ok] 已写 fig1.prompt.txt（3028 字符，15 个标签）
```

——实体标签 14 个全部核对通过（中文材料里 `GSH`、`GPX4`、`CHOP` 等本来就是以英文缩写出现的）；
唯一的 warn 是箭头上的英文过程描述，属正常。

**如果材料里写的是"草酸钙"而不是 `CaOx`**，闸会拦下来，这时用：

```bash
"${REPO_ROOT:-/app}/.venv/bin/python" \
  "${REPO_ROOT:-/app}/.opencode/skills/mechanism-figure/scripts/build_prompt.py" \
  --spec fig1.spec.json --source ms.txt --allow 'CaOx,CaOx crystal deposition'
```

被 `--allow` 放行的标签会记进 `fig1.built.json` 的 `translated_labels` 并回显，
**报给用户时要一并说明**："图上用的是国际缩写 CaOx，对应你材料里的草酸钙"。

## 第 ③ 步：出图

```bash
"${REPO_ROOT:-/app}/.venv/bin/python" \
  "${REPO_ROOT:-/app}/.opencode/skills/mechanism-figure/scripts/render_figure.py" \
  --built fig1.built.json --name fig1 --outdir figures --n 2
```

得到 `figures/fig1_v1.png`、`figures/fig1_v2.png`、`figures/fig1.meta.json`，
外加 15 项必核清单。

## 第 ④ 步：交付时怎么说

好的交付话术（照这个结构说）：

> 出了两张候选：`figures/fig1_v1.png`、`fig1_v2.png`。
> **核对了 15 个标签**：v1 里 `GPX4 ↓` 被画成了 `GPX4`（箭头丢了）、`Hyperoxaluria` 拼成了
> `Hyperoxaluira`，其余 13 个正确；v2 全部正确但第 3 栏的线粒体和 Pacman 酶挨得太近。
> 建议用 v2。
> **两点要提前知道**：① 这是 AI 生成的位图，Nature 系期刊基本不接受在稿件里用 AI 生成图，
> Cell Press 要求披露——你要投哪本刊告诉我，我去核一下它的稿约；② 正式投稿建议按
> `fig1.built.json` 里的规格在 BioRender 里重绘成矢量图，我可以把重绘规格逐条写给你。

差的交付话术（别这么说）：
> ✗ "已生成发表级 SCI 机制图，可直接用于 Nature 投稿。"
> —— 三处不实：不是发表级（位图）、没核标签、Nature 不接受。

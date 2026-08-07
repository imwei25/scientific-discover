# 三大学术画风：怎么选、词库长什么样

三种画风的"风格与质量"尾段已经写进 `scripts/build_prompt.py` 的 `STYLES` 表，**不用手抄**。
这份文档说的是**怎么选**，以及每种画风下 spec 该怎么填才不浪费它的长处。

## 选哪个

| `style` | 中文 | 适合 | 典型刊物观感 | 栏数 |
|---|---|---|---|---|
| `flat` | 极简扁平 2D 矢量 | 多步骤信号级联、机制总览、图形摘要 | *Nature Reviews* / *Trends* | 2–6 栏 |
| `realistic` | 高拟真 3D | 膜蛋白结合、分子对接、药物阻断、单个重磅结论 | *Cell* / *Nature* 封面 | 1 栏（单场景） |
| `structure` | 专业分子与结构生物学 | 跨膜蛋白拓扑、囊泡/外泌体载货、结构域 | *Nature Reviews MCB* | 1–2 栏 |

判据：
- 要讲**"先 A 再 B 再 C"** → `flat`。它的全部价值就在多栏排版。
- 要讲**"这两个分子怎么贴在一起 / 这个药怎么把它挡住"** → `realistic`。别用多栏，一个场景讲一件事。
- 要讲**"这个蛋白长什么样、插在膜的哪一层"** → `structure`。

## `flat`：多栏全景通路图

骨架由脚本锁死（栏色块 + 顶部数字圆圈 + 横向磷脂膜 + 负面词），spec 里只填内容。

`elements` 好用的写法（照抄改词即可，都是实测能画出来的图元）：

- `Tubular ER membrane network` — 内质网管网
- `colored rounded pill badges arranged along the ER tubules` — 药丸形色标（放蛋白名最清楚，比裸文字稳）
- `an 'X' bubble at the bottom emitting three divergent curved arrows upward` — 底部气泡发散箭头（表示"这个状态引发了下面几件事"）
- `a blue dashed arc at the very bottom representing the nucleus` — 底部核轮廓
- `a pink 3D mitochondrion icon with calcium flux arrows` — 线粒体
- `a blue Pacman-shaped enzyme icon consuming its substrate` — 吃底物的酶（Pacman 形状模型认得很准）
- `a spiky ferroptotic cell icon` / `a shrunken apoptotic cell icon with blebs` — 两种死亡形态，形状差别够大，不会互相串
- `3D geometric gray crystal aggregates` — 晶体沉积
- `ball-and-stick chemical structure icons` — 小分子
- `a Y-shaped antibody icon` — 抗体

**别写**：形容词堆（`beautiful`, `highly detailed`, `award winning`）——对科研图零收益，还会挤掉真正的构图约束；也别写具体颜色以外的美术指令，画风尾段已经统一处理了。

## `realistic`：高拟真单场景

- `panels` 只放 1 个，`membrane` 设 `none`（3D 场景里膜由 `elements` 描述）。
- `elements` 侧重**空间关系与材质**：`translucent cell membrane`、`receptor embedded in the bilayer`、`Y-shaped antibody docking onto the receptor`。
- 阻断关系用 `arrows` 的 `block`（红叉正压在相互作用上），比写在 `elements` 里可靠。
- 标签在 3D 场景里更容易糊 → 上限压到 **6 个以内**。

## `structure`：结构生物学

- `elements` 用结构生物学词汇：`3D ribbon crystal structure`、`detailed lipid bilayer showing individual phospholipid hydrophilic heads and hydrophobic tails`、`zoomed-in callout circle cross-section`。
- 载货类图（外泌体/囊泡）把内容物写成 `internal cargo badges`，标签放 `labels`（如 `DNA`、`mRNA`、`miRNA`）。
- 这类图最忌 3D 渲染味，画风尾段已经把 `neon glow` / `photorealistic` 排掉了，不用自己加。

## 提示词的四条格式规则（脚本已强制，此处备查）

1. **每个标签裹单引号** `'GPX4 ↓'` — 这是让模型"照抄这几个字"最有效的信号，也是三种画风共用的核心技巧。
2. **拒绝通用泛化词** — `kinase cascade`、`RAF/MEK/ERK`、`downstream effector` 这类，除非用户材料里真有。脚本会拦。
3. **彻底剥离 Markdown** — `**`、`#`、代码块、列表符号一律不能进 prompt，生图 API 会把它们当字面量画进图里。脚本会剥。
4. **负面词必带** — 见 SKILL.md 铁律 4。

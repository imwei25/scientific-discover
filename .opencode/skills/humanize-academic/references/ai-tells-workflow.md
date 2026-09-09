> 本文件从 SKILL.md「改写三步：先体检定靶 → 改 → 复跑当闸」节搬出，由 SKILL.md 在改写前定靶、改写后复跑 `ai_tells.py` 当闸时引用。参数以 `python scripts/ai_tells.py --help` 为准。

# 改写三步：`ai_tells.py` 的来历与完整命令

## 为什么终检改成跑脚本

旧版写的是"第二遍对照清单逐条终检"，实际执行时终检永远退化成"读一遍觉得还行"——
**模型评自己刚写的东西，看不出同构**。2026-08 一份成稿被外部检测器逐条拆穿，
点名的四类特征（段末句式雷同 ×8、句长均匀、第一…第五枚举、西里尔字母混入）
全是**能数出来**的，当时却一个都没被自查发现。所以终检改成跑脚本。

## 完整命令

```bash
V="${REPO_ROOT:-/app}/.venv/bin/python"
S="${REPO_ROOT:-/app}/.opencode/skills/humanize-academic/scripts"

# ① 改写前定靶——报告会点名"哪几段的哪个特征异常"，改写就照着这份清单下手
$V $S/ai_tells.py manuscript_src.md --terms "UroVysion,EpiCheck,cfDNA"
#   A 路（docx）：直接喂 docx_extract.py 的段落清单，报告用 [[pNNNN]] 定位
$V $S/ai_tells.py manuscript_para.md
#   PDF 抽出来的硬换行文本要加 --reflow

# ② 按报告 + 清单改写

# ③ 改写后复跑，**当闸用**：任何一项比改写前差就退 3，不许交付
$V $S/ai_tells.py --before manuscript_src.md --after manuscript_humanized.md
```

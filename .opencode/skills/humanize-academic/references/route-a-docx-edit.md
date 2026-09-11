> 本文件从 SKILL.md「A 路：就地改写」与「机械校验」两节搬出，由 SKILL.md 在用户给 `.docx` 要润色 / 改写、走 A 路就地改写时引用。参数以 `python scripts/<脚本>.py --help` 为准。

# A 路：就地改写（`.docx` 默认走这条）——完整命令与细则

## 为什么不走 B 路重建

B 路（docx → markdown → 改写 → **重新生成** docx）的问题不是"格式没调好"，而是**重新生成**：
原文件里 markdown 表达不了的东西会全部消失，且一路无声——
EndNote / Zotero 引文域变成死文本（用户再也没法更新文献表）、合并单元格表头被拍平
（pipe 表语法上就没有 rowspan/colspan）、页眉页脚 / 分节 / 页码 / 交叉引用 / 题注自动编号 /
批注 / 他人修订痕迹一并丢失。A 路不生成新文件，这些问题**从根上不存在**。

## 完整命令序列

```bash
V="${REPO_ROOT:-/app}/.venv/bin/python"
S="${REPO_ROOT:-/app}/.opencode/skills/humanize-academic/scripts"

# ① 抽出带编号的段落清单（正文 + 页眉页脚 + 脚注尾注一并覆盖）
$V $S/docx_extract.py manuscript.docx
# → manuscript_para.md：每行 `[[p0007]] 正文…`

# ② 改写：整行替换 [[id]] 后面的正文，写成 manuscript_edited.md
#    行首 [[id]] 一个字符都不要动；别增删行、别合并或拆分段落；
#    ⟦…⟧ 里是域/公式/图内文字（引文、交叉引用、页码），可整体挪位置，里面一个字都不许改。

# ③ 写回原文件，落成 Word 原生修订
$V $S/docx_apply.py manuscript.docx manuscript_edited.md \
     -o manuscript_humanized.docx --track-changes --author "AI 润色"

# ④ 校验（四道闸，必跑）
$V $S/docx_verify.py manuscript.docx manuscript_humanized.docx --auto-terms
```

## `docx_apply.py` 会自己拒绝的事（拒绝即退出码 3，别忽略）

- ⟦⟧ 里的域内文字被改、被删或换了顺序 → 整段拒绝并指出是哪一处；
- 段落编号在原稿里不存在 → 忽略并告警；
- 改动**跨越可见格式边界**（颜色 / 高亮 / 粗斜 / 上下标 / 字号）→ 默认告警，因为被合并进来的
  那截文字会被迫改成前一段的格式（用户会看到"某个词莫名变了颜色"）。**告警必须转告用户**，
  或加 `--strict-format` 直接拒绝那些段。

## 机械校验：A 路跑 `docx_verify.py`

**A 路（docx 就地改写）跑 `docx_verify.py`**（四道闸见 SKILL.md 第零步）：
```bash
"${REPO_ROOT:-/app}/.venv/bin/python" \
  "${REPO_ROOT:-/app}/.opencode/skills/humanize-academic/scripts/docx_verify.py" \
  manuscript.docx manuscript_humanized.docx --auto-terms
```
它比 B 路的校验强在**闸 C**：修订模式下"拒绝全部修订"必须逐字还原成原文——
只要有一个字被改却没留下修订标记（用户在 Word 里看不见、也没法拒绝），立刻 FAIL。

### `--mode edit`：用户要求改**内容**时用这一档

默认的 polish 档前提是"只动措辞"，所以数字、引用、DOI 一变就判 FAIL，篇幅超 ±15% 也告警。
而用户点名要改内容时（"把置信区间补上"、"这段数据删掉"、"结论写实一点"），数字变化**正是他要的结果**：

```bash
python docx_verify.py 原稿.docx 改后.docx --mode edit
```

edit 档保留 A / B / C 三道硬闸（zip 逐字节、结构、修订完整性一个都不放），
只把「数字 / 引用 / 篇幅」从 FAIL 降成 WARN，并**照常逐条列出**是哪几个数字变了。
**WARN 必须原样转告用户请他核对**，不是过场——降级的是拦截，不是核对责任。

什么时候仍然用 polish 档：纯润色、译后回校、以及用户明确说过"一个数字都不许动"的场合。

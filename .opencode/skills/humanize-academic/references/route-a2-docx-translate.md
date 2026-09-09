> 本文件从 SKILL.md「A2 路：整篇翻译」节搬出，由 SKILL.md 在用户要把 `.docx` 整篇翻译且排版不动、走 A2 路时引用。参数以 `python scripts/<脚本>.py --help` 为准。

# A2 路：整篇翻译（同一套就地机制，但写回策略不同）——完整命令与细则

## 完整命令序列

```bash
$V $S/docx_extract.py manuscript.docx            # 同 A 路
# 逐行翻译 → manuscript_trans.md（行首 [[id]] 不动、⟦…⟧ 内不译）
$V $S/docx_translate.py manuscript.docx manuscript_trans.md \
     -o manuscript_translated.docx --set-lang en-US --latin-font "Times New Roman"
$V $S/docx_verify.py manuscript.docx manuscript_translated.docx \
     --mode translate --expect-lang en
```

（`$V` / `$S` 的定义见 `route-a-docx-edit.md`。）

## 为什么不能用 `docx_apply.py` 翻译

**为什么不能用 `docx_apply.py` 翻译**（这是实测出来的，别图省事）：A 路保住段内格式靠的是
"没改到的字符留在原 run 里"，而翻译每个字都变，这个前提没了。中译英时原文与译文没有公共
子串，字符级 diff 退化成一个 replace，**整段译文被塞进最后一个 run**、继承它的格式；实测
样例那段 324 字 / 22 run / 3 种格式里，末尾 run 的格式恰恰不是主导格式。若原文与译文有偶然
公共字符（数字、SGLT2、括号、%），译文还会被切成几截塞进不同格式的 run。

`docx_translate.py` 改走**主导格式整段落笔**：取该片里占字数最多的 rPr 承载整段译文，其余
可改 run 删掉。段落级的一切（样式、缩进、对齐、编号、所在单元格）分毫不动；**段内的局部
格式会被统一**——译文里那个词落在哪儿机器判断不了，这一条无法回避，脚本会逐段报出来，
**必须转告用户**。

## `--set-lang` / `--latin-font` 不是可选项

**`--set-lang` / `--latin-font` 不是可选项**：不设语言标记，Word 拿原语言的词典校对译文，
全篇红波浪线；不设西文字体，英文会用中文字体渲染（实测两份真稿：一份 429 个 run 的
`rFonts@ascii` 是宋体，另一份 119 个是 SimSun）。译成中文时用 `--set-lang zh-CN --cjk-font 宋体`。

## 翻译档的校验闸（`--mode translate`）

**翻译档的校验闸与润色档不同**（`--mode translate`）：去掉"拒绝全部修订须还原成原文"与
±15% 篇幅两条（翻译没有修订、且中译英涨 40–60% 是正常的），换成
**逐段点名漏译**（判据：译文与原文一字不差 **且** 原文含源语言字符——只看可改文字，
⟦⟧ 里的域文字本来就该保持原样，不算半译）与**残留源语言**告警；作者-年引用改为**只比条数**
（「（中泰证券，2025）」译成「(Zhongtai Securities, 2025)」是对的，不是丢引用）。
数字、`[n]`、DOI/PMID 仍严格守恒。

## 交付时必须报四件事

**交付时必须报四件事**：译了多少段 + 四道闸结果；**图表的账**（校验的结构层会打印
「图 N → N、表 M → M」，照抄给用户——图和表根本没离开过原文件，媒体是逐字节搬的，
但用户看不到这句话就无从判断）；多少段段内格式被统一；篇幅涨缩百分比（原表格列宽固定，
窄列里的长句会把行撑高、页数会变）。

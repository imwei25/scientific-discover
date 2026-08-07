#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""机制示意图：把结构化 spec(JSON) 编译成生图模型吃得下的一整段英文 prompt + 负面词。

【为什么要有这一层，而不是让 agent 直接写 prompt】
生图模型对"排版"极其不听话：同一段描述，十次里有几次会画成"左侧一个巨大的竖向细胞"
或"一坨居中的单细胞"，多步骤通路就此报废。可靠的做法是把构图约束（栏数、色块、
顶部序号圆圈、横向细胞膜、箭头语义、负面词）编译成固定骨架，只让内容部分变化。
骨架写在代码里 → 每次都一样；agent 只负责把用户的机制填进 spec。

【本脚本最要紧的职责其实是"不许编"】
科研图里多一个不属于这项研究的分子名，就是一张会被审稿人抓住的假图。所以：
  · prompt 里出现的每一个分子/基因/结局标签，只能来自 spec；
  · 给了 --source（稿件/摘要原文）时，spec 里的标签必须能在原文中找到，找不到就【中止】
    并列出来 —— 这是本技能唯一的反编造闸，别绕过它；
  · 通用教科书泛化词（kinase cascade、RAF/MEK/ERK…）除非原文真有，一律拒收。

用法：
  python build_prompt.py --spec fig1.spec.json --source manuscript.md
  python build_prompt.py --spec fig1.spec.json --out fig1.prompt.txt --json fig1.built.json
"""
import argparse
import json
import os
import re
import sys
import unicodedata
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


# ---- 产物目录解析（与套件内其它脚本同一口径；见 AGENTS.md §五）----
# 只保留本脚本真正需要的那一半：拦住"cwd 已是会话产物目录还再拼 outputs/ 前缀"的写法。
# 那会写成 outputs/<会话id>/outputs/xxx，而界面"产出"侧栏只递归一层 —— 产物用户看不见，
# 却又不报错，最难排查。宁可响亮中止。
def resolve_out_file(explicit, default_name):
    cwd = Path.cwd()
    in_session = cwd.parent.name == "outputs"
    if not explicit:
        return cwd / default_name
    p = Path(explicit)
    if in_session and not p.is_absolute() and p.parts and p.parts[0] == "outputs":
        sys.exit("\n".join([
            "!! 产物路径写法有误，已中止。",
            "   你传的是： " + str(explicit),
            "   当前工作目录已经【就是】本会话的产物目录： " + str(cwd),
            "   再拼 outputs/ 前缀会写成 " + str(cwd / p) + "，界面的“产出”侧栏只递归一层，看不见它。",
            "   正确写法：直接用裸文件名（如 --out fig1.prompt.txt），或干脆不传。",
        ]))
    return p


# ---- 画风词库 ----------------------------------------------------------------
# 三大画风的"风格与质量"尾段。内容（画什么）由 spec 决定，这里只管"怎么画"。
# 取自源规范的 style lexicon，但去掉了里面写死的那条具体通路（见 references/worked-example.md）。
STYLES = {
    "flat": {
        "zh": "极简扁平 2D 矢量（多栏全景通路图）",
        "opener": ("A precise {n}-stage vertical column scientific pathway diagram in BioRender style "
                   "for a medical journal publication, {ratio} ratio."),
        "tail": ("Style and quality: minimalist flat 2D vector graphics, clean uniform line art, "
                 "crisp black directional arrows, soft pastel palette, pristine white background, "
                 "evenly distributed elements with generous whitespace, no element overlapping any label, "
                 "publication quality for Nature Reviews."),
        "negative": ("3D render, shiny glossy 3D spheres, 3D plastic buttons, photorealistic, "
                     "dramatic cinematic lighting, heavy gradients, drop shadows"),
        "fits": "多步骤信号级联、大信息量机制总览（Nature Reviews / Trends 风）",
    },
    "realistic": {
        "zh": "高拟真 3D 结构（封面 / Key Figure）",
        "opener": ("An enhanced realistic 3D biomedical illustration depicting molecular interaction "
                   "and mechanism, Cell journal cover graphic style, {ratio} ratio."),
        "tail": ("Style and lighting: 3D structural realism, translucent cell membranes, volumetric lighting, "
                 "soft ambient occlusion, subtle glowing halo on active signaling nodes, shallow depth of field, "
                 "labels rendered as flat crisp typography on top of the 3D scene, publication quality."),
        "negative": "flat 2D clipart, childish cartoon, thick outline stickers, flat single-color fills",
        "fits": "膜蛋白结合、分子对接、药物作用机制、重磅结论单图（Cell / Nature 封面风）",
    },
    "structure": {
        "zh": "专业分子与结构生物学",
        "opener": ("A professional structural biology scientific diagram in BioRender style "
                   "for Nature Reviews Molecular Cell Biology, {ratio} ratio."),
        "tail": ("Style and quality: precision vector line art, 3D ribbon representations for protein folds, "
                 "detailed lipid bilayer with individual phospholipid heads and tails, "
                 "soft muted pastel palette, clean white background, publication-quality typography."),
        "negative": "cartoon, neon glow, sci-fi hologram, photorealistic cell photography",
        "fits": "跨膜蛋白拓扑、囊泡/外泌体载货、结构域示意（Nature Reviews MCB 风）",
    },
}

# 默认柔色背景色板（栏数不到 6 就取前 n 个）。源规范只给了 4 个，这里补到 6，
# 因为真实机制常常不是 4 步 —— 强行凑 4 栏就得靠编内容填满，那是最坏的结果。
PANEL_COLORS = ["light yellow", "light blue", "light pink", "salmon pink", "light mint green", "light lavender"]

ARROW_PHRASE = {
    "activate": "a solid black curved arrow labeled '{label}' pointing from '{a}' to '{b}'",
    "inhibit": "a red dashed T-bar inhibition line labeled '{label}' from '{a}' to '{b}'",
    "translocate": "a long curved arrow labeled '{label}' showing translocation of '{a}' into '{b}'",
    "convert": "a straight arrow labeled '{label}' showing conversion of '{a}' into '{b}'",
    "block": "a red X cross symbol labeled '{label}' placed exactly on the '{a}'-'{b}' interaction",
}
ARROW_PHRASE_NOLABEL = {
    "activate": "a solid black curved arrow pointing from '{a}' to '{b}'",
    "inhibit": "a red dashed T-bar inhibition line from '{a}' to '{b}'",
    "translocate": "a long curved arrow showing translocation of '{a}' into '{b}'",
    "convert": "a straight arrow showing conversion of '{a}' into '{b}'",
    "block": "a red X cross symbol placed exactly on the '{a}'-'{b}' interaction",
}

# 排版负面词：全部针对实拍过的翻车形态（源规范铁律 4 的原词 + 补充）。
NEG_LAYOUT = ("giant vertical cell on left, left brush border, vertical cell membrane profile, "
              "single giant cell on left, single centered cell, blob cell shape, isolated cell, "
              "central circular nucleus, panels merged into one scene, uneven panel widths")
# 文字质量负面词：标签糊/串/重是这类图最高频的报废原因。
NEG_TEXT = ("messy overlapping labels, blurry labels, text noise, garbled text, gibberish letters, "
            "duplicated labels, label outside its panel, watermark, signature, caption block")
NEG_SCI = ("simple textbook illustration, generic kinase cascade, decorative DNA double helix, "
           "unrelated organelles, random floating molecules, low quality, lowres")

# 通用泛化词黑名单：出现在标签里就是"没读用户材料、拿教科书套话凑数"的信号。
GENERIC_BLACKLIST = [
    "kinase cascade", "signaling cascade", "raf/mek/erk", "mapk cascade",
    "downstream effector", "various cytokines", "inflammatory factors",
    "some proteins", "target gene", "etc",
]

# 每栏 / 全图标签上限。不是审美问题：实测标签越多，模型越容易把字画糊、画串、画重。
# 超了就该拆成两张图（或改走矢量重绘），而不是硬塞。
MAX_LABELS_PER_PANEL = 8
MAX_LABELS_TOTAL = 24
MAX_PANELS = 6
MIN_PANELS = 1


def norm_for_match(s):
    """标签 → 可比对形态：去掉 ↑↓ 等修饰、全角转半角、折叠空白、casefold。

    casefold 而不是 lower：跨语言大小写折叠更彻底（德语 ß→ss 这类 lower 折不回来）。
    """
    s = unicodedata.normalize("NFKC", str(s or ""))
    s = re.sub(r"[↑↓⇅→←⇒±*]+", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s.casefold()


def strip_markdown(text):
    """剥掉 Markdown：生图 API 只吃纯文本，`**`/`#`/代码块会被当字面量画进图里。"""
    t = re.sub(r"```[a-zA-Z]*", " ", str(text or ""))
    t = t.replace("**", "").replace("`", "")
    t = re.sub(r"^\s*#{1,6}\s*", "", t, flags=re.M)
    t = re.sub(r"^\s*[-*•]\s+", " ", t, flags=re.M)
    t = re.sub(r"\s+", " ", t)
    return t.strip()


def q(label):
    """标签统一裹单引号 —— 这是让生图模型"照抄这几个字"最有效的信号（源规范核心经验）。"""
    s = strip_markdown(label).strip().strip("'\"")
    return "'" + s + "'"


def _collect(spec, kinds):
    """spec 里的标签（按出现顺序去重，不改大小写）。kinds 选 'entity' / 'relation'。

    【为什么必须分两类】entity 是实体名（分子/基因/细胞归宿/结构），凭空多一个就是造假，
    必须逐字核对；relation 是箭头上的关系描述（'GSH degradation'、'GPX4 inactivation'），
    它是对机制的英文表述，中文稿件里【本来就不会有这几个英文词】—— 拿它去逐字核对，
    结果是每份中文材料都被拦，用户学到的只有"这个闸要绕过去"，反编造就彻底失效了。
    所以 relation 只提醒、不拦截。
    """
    out, seen = [], set()

    def add(x):
        s = strip_markdown(x).strip().strip("'\"")
        if not s:
            return
        k = norm_for_match(s)
        if k in seen:
            return
        seen.add(k)
        out.append(s)

    if "entity" in kinds:
        for p in spec.get("panels") or []:
            for x in p.get("labels") or []:
                add(x)
        for a in spec.get("arrows") or []:
            for k in ("from", "to"):
                if a.get(k):
                    add(a[k])
    if "relation" in kinds:
        for a in spec.get("arrows") or []:
            if a.get("label"):
                add(a["label"])
    return out


def collect_labels(spec):
    """图上会出现的全部文字标签（实体 + 关系），用于"必核清单"。"""
    ents = _collect(spec, {"entity"})
    seen = {norm_for_match(x) for x in ents}
    return ents + [x for x in _collect(spec, {"relation"}) if norm_for_match(x) not in seen]


def validate(spec, source_text=None, allow=()):
    """返回 (errors, warnings)。errors 非空 → 调用方必须中止，绝不能带着编造的标签去出图。

    allow：显式豁免的实体标签（材料里是中文/全称、图上按国际通用缩写写，如 草酸钙→CaOx）。
    豁免会被记进 built.json 的 translated_labels 并回显，让用户看得见我们替他做了哪些对应，
    而不是悄悄放过去。
    """
    errs, warns = [], []
    allow_n = {norm_for_match(a) for a in (allow or ()) if str(a).strip()}

    style = str(spec.get("style") or "flat").strip().lower()
    if style not in STYLES:
        errs.append(f"style 只能是 {sorted(STYLES)} 之一，收到 {style!r}")

    panels = spec.get("panels") or []
    if not isinstance(panels, list) or not (MIN_PANELS <= len(panels) <= MAX_PANELS):
        errs.append(f"panels 需要 {MIN_PANELS}–{MAX_PANELS} 个（收到 {len(panels) if isinstance(panels, list) else '非列表'}）。"
                    f"机制真有 7 步以上就拆成两张图，别把栏压扁到看不清。")
    for i, p in enumerate(panels, 1):
        if not isinstance(p, dict):
            errs.append(f"panels[{i}] 不是对象")
            continue
        if not (p.get("name") or "").strip():
            errs.append(f"panels[{i}] 缺 name（这一步叫什么，如 Trigger / ER stress）")
        labs = p.get("labels") or []
        if len(labs) > MAX_LABELS_PER_PANEL:
            errs.append(f"panels[{i}]（{p.get('name')}）有 {len(labs)} 个标签，超过每栏上限 "
                        f"{MAX_LABELS_PER_PANEL}：标签一多模型必画糊/画串，请拆图或合并次要分子")
        if not labs and not (p.get("elements") or []):
            warns.append(f"panels[{i}]（{p.get('name')}）既没有 labels 也没有 elements，这一栏会被画成空白色块")

    labels = collect_labels(spec)
    if len(labels) > MAX_LABELS_TOTAL:
        errs.append(f"全图共 {len(labels)} 个标签，超过上限 {MAX_LABELS_TOTAL}（实测超了必有字画糊/画串）")

    for a in spec.get("arrows") or []:
        t = str(a.get("type") or "activate").lower()
        if t not in ARROW_PHRASE:
            errs.append(f"arrows 里的 type={t!r} 不认识，只能是 {sorted(ARROW_PHRASE)}")
        if not (a.get("from") and a.get("to")):
            errs.append(f"arrows 每一条都要有 from 与 to：{a!r}")

    for lb in labels:
        if "'" in lb:
            errs.append(f"标签里不能含单引号（会把引号包裹结构撑坏）：{lb!r}")
        n = norm_for_match(lb)
        for bad in GENERIC_BLACKLIST:
            if bad in n and not (source_text and bad in norm_for_match(source_text)):
                errs.append(f"标签 {lb!r} 是通用教科书泛化词，且用户材料里并没有它 —— "
                            f"请换成这项研究真正测的靶点名（源规范规则 2）")

    # ★ 反编造闸：给了原文就逐个核对【实体标签】。这是本脚本存在的首要理由。
    if source_text:
        src = norm_for_match(source_text)
        ents = _collect(spec, {"entity"})
        missing, exempt = [], []
        for lb in ents:
            if norm_for_match(lb) in src:
                continue
            (exempt if norm_for_match(lb) in allow_n else missing).append(lb)
        if missing:
            errs.append("以下实体标签在 --source 给的材料里找不到，不许画进图（编一个分子进机制图＝造假）：\n    "
                        + "\n    ".join(repr(m) for m in missing)
                        + "\n  材料里确实有、只是写法不同（中文全称 vs 国际缩写、大小写）→ 改成材料里的写法，"
                        + "\n    或用 --allow '标签1,标签2' 显式声明这几个是同一实体的通用写法（会记入复现记录并回显）；"
                        + "\n  是本研究没测的分子 → 从 spec 删掉。")
        if exempt:
            warns.append("这些标签按 --allow 放行了（材料里是别的写法）：" + "、".join(exempt)
                         + "。请自己再确认一遍它们确实指同一个实体。")
        # 关系描述只提醒不拦（见 _collect 的说明）
        rels = [lb for lb in _collect(spec, {"relation"}) if norm_for_match(lb) not in src]
        if rels:
            warns.append("箭头上的关系描述在材料里找不到原词（多半是中文材料的英文表述，正常）："
                         + "、".join(rels) + "。请确认它描述的关系确实是材料支持的。")
    else:
        warns.append("没传 --source：无法核对标签是否真出自用户材料。正式出图前请补上稿件/摘要原文。")

    return errs, warns


def build(spec):
    """spec → (prompt, negative_prompt)。prompt 是【一整段纯文本】，不含任何 Markdown。"""
    style = str(spec.get("style") or "flat").strip().lower()
    sty = STYLES[style]
    panels = spec.get("panels") or []
    n = len(panels)
    ratio = str(spec.get("aspect_ratio") or "1:1")

    parts = [sty["opener"].format(n=n, ratio=ratio)]

    # ---- 构图骨架（多栏风格才需要；单图风格跳过分栏）----
    if style == "flat" and n > 1:
        colors = [(p.get("bg") or PANEL_COLORS[i % len(PANEL_COLORS)]) for i, p in enumerate(panels)]
        circles = ", ".join(f"({i})" for i in range(1, n + 1))
        panel_desc = "; ".join(f"Panel {i} ({c})" for i, c in enumerate(colors, 1))
        parts.append(
            f"Composition and layout: divided into {n} distinct vertical pastel background colour panels of "
            f"equal width: {panel_desc}. A top header row contains numbered circles {circles} aligned "
            f"horizontally, one directly above each panel."
        )
        if (spec.get("membrane") or "horizontal-top") == "horizontal-top":
            parts.append(
                f"A continuous double-layer phospholipid cell membrane runs HORIZONTALLY across the upper "
                f"section from panel 1 through panel {n}. There is no vertical cell wall and no giant brush "
                f"border on the left side."
            )

    # ---- 各栏内容 ----
    for i, p in enumerate(panels, 1):
        seg = []
        where = f"Panel {i}" if n > 1 else "Scene"
        bg = p.get("bg") or (PANEL_COLORS[(i - 1) % len(PANEL_COLORS)] if style == "flat" else None)
        head = f"{where} ({bg} background), titled {q(p['name'])}:" if bg else f"{where}, titled {q(p['name'])}:"
        seg.append(head)
        if p.get("scene"):
            seg.append(strip_markdown(p["scene"]).rstrip(".") + ".")
        for el in p.get("elements") or []:
            seg.append(strip_markdown(el).rstrip(".") + ".")
        labs = p.get("labels") or []
        if labs:
            seg.append("Text labels drawn inside this panel, each rendered exactly as written in single "
                       "quotes: " + ", ".join(q(x) for x in labs) + ".")
        parts.append(" ".join(seg))

    # ---- 箭头与关系（语义→固定画法，别让模型自己发挥）----
    arrows = spec.get("arrows") or []
    if arrows:
        items = []
        for a in arrows:
            t = str(a.get("type") or "activate").lower()
            tpl = ARROW_PHRASE[t] if a.get("label") else ARROW_PHRASE_NOLABEL[t]
            items.append(tpl.format(a=strip_markdown(a["from"]), b=strip_markdown(a["to"]),
                                    label=strip_markdown(a.get("label") or "")))
        parts.append("Relationships drawn as: " + "; ".join(items) + ".")

    if spec.get("notes"):
        parts.append(strip_markdown(spec["notes"]).rstrip(".") + ".")

    parts.append(sty["tail"])
    parts.append("Every label must be spelled exactly as given and must not overlap any other element.")

    prompt = strip_markdown(" ".join(parts))

    # ---- 负面词 ----
    negs = [NEG_LAYOUT, NEG_TEXT, NEG_SCI, sty["negative"]]
    labels = collect_labels(spec)
    # 标签全是拉丁字符时，明确排掉中文 —— Qwen 系模型会自作主张往图里加中文注释。
    if labels and all(ord(ch) < 0x2E80 for lb in labels for ch in lb):
        negs.append("chinese characters, japanese characters, mixed language labels")
    for x in spec.get("extra_negative") or []:
        negs.append(strip_markdown(x))
    negative = ", ".join(s.strip().strip(",") for s in negs if s and s.strip())

    return prompt, negative


def main():
    ap = argparse.ArgumentParser(description="机制示意图：spec(JSON) → 生图 prompt + 负面词")
    ap.add_argument("--spec", required=True, help="spec JSON 路径（模板见 templates/spec.example.json）")
    ap.add_argument("--source", default=None,
                    help="用户材料原文（稿件/摘要 .md/.txt）。传了就逐个核对标签是否真出自材料——正式出图前务必传")
    ap.add_argument("--out", default=None, help="prompt 落盘路径（默认 <spec 名>.prompt.txt）")
    ap.add_argument("--json", dest="json_out", default=None,
                    help="把 {prompt, negative_prompt, labels, spec} 一并写成 JSON（供 render_figure.py 直接吃）")
    ap.add_argument("--allow", default="",
                    help="逗号分隔：材料里用中文/全称、图上按国际缩写写的实体（如 CaOx）。"
                         "只对确实同一实体用；会记入复现记录并回显，不是万能绕过闸的开关")
    ap.add_argument("--quiet", action="store_true", help="只打印路径，不回显 prompt 全文")
    args = ap.parse_args()

    try:
        spec = json.loads(Path(args.spec).read_text(encoding="utf-8"))
    except FileNotFoundError:
        sys.exit(f"!! 找不到 spec 文件：{args.spec}")
    except json.JSONDecodeError as e:
        sys.exit(f"!! spec 不是合法 JSON（第 {e.lineno} 行）：{e.msg}")

    source_text = None
    if args.source:
        try:
            source_text = Path(args.source).read_text(encoding="utf-8", errors="replace")
        except FileNotFoundError:
            sys.exit(f"!! 找不到 --source 文件：{args.source}")

    allow = [x.strip() for x in (args.allow or "").split(",") if x.strip()]
    errs, warns = validate(spec, source_text, allow)
    for w in warns:
        print("[warn] " + w)
    if errs:
        print("\n!! spec 没通过检查，已中止（下面每一条都要改完再跑）：", file=sys.stderr)
        for e in errs:
            print("  - " + e, file=sys.stderr)
        sys.exit(2)

    prompt, negative = build(spec)
    labels = collect_labels(spec)

    stem = Path(args.spec).name
    for suf in (".spec.json", ".json"):
        if stem.endswith(suf):
            stem = stem[: -len(suf)]
            break
    out = resolve_out_file(args.out, stem + ".prompt.txt")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(prompt + "\n\n--- negative_prompt ---\n" + negative + "\n", encoding="utf-8")

    if args.json_out:
        jp = resolve_out_file(args.json_out, stem + ".built.json")
        jp.parent.mkdir(parents=True, exist_ok=True)
        jp.write_text(json.dumps({"prompt": prompt, "negative_prompt": negative,
                                  "labels": labels, "translated_labels": allow,
                                  "source_checked": bool(source_text),
                                  "source_file": args.source or None, "spec": spec},
                                 ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"[ok] 已写 {jp}")

    print(f"[ok] 已写 {out}（{len(prompt)} 字符，{len(labels)} 个标签）")
    if not args.quiet:
        print("\n---- prompt ----\n" + prompt)
        print("\n---- negative_prompt ----\n" + negative)
    print("\n[必核] 出图后逐个核对这些标签有没有被画错/画糊/画漏（生图模型必然会拼错一部分）：")
    for lb in labels:
        print("  □ " + lb)
    return 0


if __name__ == "__main__":
    sys.exit(main())

// 技能出流指纹闸（skill-guard.mjs）回归测试。
// 覆盖：建库/停用判据、整段拷贝命中、空白/全角/零宽打散仍命中、正常科研文本不误伤、
// 短引用不误伤、frontmatter description 复述不误伤、文件通道（md/zip/docx 形态）、截断定位。
// 【诚实边界也测】翻译/重度改写后的内容【不】命中——这是 2026-08 决策明确接受的界界，
// 测试钉住它是为了防将来有人以为这是 bug 去"修"，把误伤阈值改坏。
import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { initSkillGuard, guardEnabled, scanText, sanitizeText, scanFileBuffer, LEAK_NOTE } from "../skill-guard.mjs"
import { zip } from "../minizip.mjs"

// ---- 造一个假技能目录 ----------------------------------------------------------
// 内容要够长（归一化后 >> 240 字符）且带独特措辞，模拟真 SKILL.md 的密度。
const SKILL_BODY = `# 假想技能：石蜡切片荧光定量流程

## 铁律（每一步都要遵守）
1. 载玻片编号必须用州桥七位码（如 QZ-30417），扫描仪读不出州桥码的批次整批退回复染，绝不手工补录。
2. 曝光时间锁定在 417 毫秒档位，任何人不得因"图太暗"调档——暗片走后处理增益 1.7 倍那条路。
3. 对照孔缺失时禁止借用相邻批次对照，必须重新铺板；借用对照的定量结果一律作废并写入偏差台账。
4. 荧光强度阈值取背景中位数的 3.29 倍（不是均值），这个系数来自本实验室 2024 年的 ROC 校准，别改。

## 脚本用法
先跑 prepare_slides.py 生成扫描清单，再用 quantify.py 批量定量：
参数 --gain 只在暗片补救时用，正常批次绝不带它；--threshold-k 默认 3.29，改动需在台账里留痕。
输出的 slide_qc.csv 里 flag 列为 R7 的行表示州桥码校验失败，这些行不进统计，单独导出复核。

## 常见坑
扫描仪固件 2.4.1 会把 417 毫秒档写成 420，固件升级前先跑 fix_exposure.py 校正元数据；
复染批次的背景中位数会漂移约 12%，阈值系数不变但背景要重新取样。`

const SKILL_SCRIPT = `#!/usr/bin/env python3
"""quantify.py — 批量荧光定量（假想技能测试脚本）"""
import argparse, csv, sys
from pathlib import Path

ZQ_CODE = "QZ"          # 州桥七位码前缀
EXPOSURE_MS = 417        # 锁定曝光档位
THRESHOLD_K = 3.29       # 背景中位数系数（2024 ROC 校准）
DARK_GAIN = 1.7          # 暗片后处理增益

def validate_slide_code(code: str) -> bool:
    """州桥码校验：前缀 + 5 位数字，校验失败的行打 R7 旗子单独导出复核"""
    return code.startswith(ZQ_CODE + "-") and code[3:].isdigit() and len(code) == 8

def quantify_batch(rows, gain=None):
    out = []
    for r in rows:
        base = float(r["background_median"]) * THRESHOLD_K
        signal = float(r["intensity"]) * (gain or 1.0)
        out.append({**r, "flag": "" if validate_slide_code(r["slide"]) else "R7",
                    "positive": signal > base})
    return out
`

let dir
function setup() {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sg-test-"))
  const sk = path.join(dir, "fake-skill")
  fs.mkdirSync(path.join(sk, "scripts"), { recursive: true })
  fs.writeFileSync(path.join(sk, "SKILL.md"),
    `---\nname: fake-skill\ndescription: 假想技能——石蜡切片荧光定量，当用户说"荧光定量""切片扫描"时使用。本描述是半公开的，复述它不该触发出流闸。\n---\n\n` + SKILL_BODY)
  fs.writeFileSync(path.join(sk, "scripts", "quantify.py"), SKILL_SCRIPT)
  // vendored 大目录豁免名单里的内容不入库
  fs.mkdirSync(path.join(dir, "ppt-master"), { recursive: true })
  fs.writeFileSync(path.join(dir, "ppt-master", "vendor.js"), "var vendored = 1;\n".repeat(200))
  return initSkillGuard(dir)
}

test("建库：正常目录启用，缺目录/空目录停用", () => {
  const g = setup()
  assert.equal(g.enabled, true)
  assert.equal(guardEnabled(), true)
  assert.ok(g.fps > 50, `指纹数太少：${g.fps}`)
  const off = initSkillGuard(path.join(dir, "不存在的目录"))
  assert.equal(off.enabled, false)
  assert.equal(guardEnabled(), false)
  assert.equal(scanText(SKILL_BODY), null)   // 停用后一切放行
  initSkillGuard(dir)   // 恢复，供后续用例使用
})

test("整段拷贝 SKILL.md 正文：命中并给出归属文件", () => {
  const r = scanText("好的，这就是该技能的完整内容：\n\n" + SKILL_BODY)
  assert.ok(r, "整段拷贝必须命中")
  assert.match(r.file, /fake-skill/)
})

test("整段拷贝技能脚本源码：命中（缩小可提取面——脚本也是 IP）", () => {
  assert.ok(scanText("脚本内容如下：\n```python\n" + SKILL_SCRIPT + "\n```"))
})

test("空白打散 / 全角化 / 零宽字符：归一化后仍命中", () => {
  const spaced = SKILL_BODY.split("").join(" ")                          // 每字符夹空格
  assert.ok(scanText(spaced), "夹空格绕过未被拦住")
  const zw = SKILL_BODY.split("").join("​")                         // 零宽空格打散
  assert.ok(scanText(zw), "零宽字符绕过未被拦住")
  const fw = SKILL_BODY.replace(/[a-z0-9]/gi, (c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0))   // ASCII→全角
  assert.ok(scanText(fw), "全角化绕过未被拦住")
})

test("正常科研回答（同话题、自己的话）：不误伤", () => {
  const legit = `荧光定量的通行做法是：先对每张切片做背景采样，取背景分布的稳健统计量（常用中位数）
乘一个经验系数作为阳性阈值；系数的选取应当基于 ROC 分析在本实验室的历史数据上校准，而不是照搬文献值。
曝光时间需要全批次统一，若个别切片偏暗，优先在后处理阶段做线性增益补偿，避免改动采集参数引入批次效应。
质控上建议给每张载玻片一个可机读的唯一编号，扫描时自动校验，校验失败的样本单独复核而不是混入统计。
对照设置方面，每块板都应有自己的阴性对照，缺失时应重铺而非借用其他批次，否则批间漂移会污染定量结果。
以上是方法学通则，具体参数请结合你们实验室的仪器与染色体系自行验证。`
  assert.equal(scanText(legit), null, "同话题的正常回答被误伤")
})

test("短引用一条铁律：不误伤（单行引用远低于簇阈值）", () => {
  const quote = `注意：该流程要求"荧光强度阈值取背景中位数的 3.29 倍（不是均值）"，这一点和常见做法不同。`
  assert.equal(scanText(quote), null)
})

test("复述 frontmatter description：不误伤（description 是半公开的，不入库）", () => {
  const echo = `这个技能的说明是：假想技能——石蜡切片荧光定量，当用户说"荧光定量""切片扫描"时使用。本描述是半公开的，复述它不该触发出流闸。需要我演示一下吗？`
  assert.equal(scanText(echo), null)
})

test("翻译/重度改写：不命中（诚实边界，语义级提取不在本闸职责内）", () => {
  const translated = `Rule 1: slide codes must use the seven-digit Zhouqiao format; batches the scanner
cannot read are re-stained entirely, never patched by hand. Rule 2: exposure locked at the 417 ms
stop; dark slides go through the 1.7x post-gain路线 instead of touching acquisition settings.`
  assert.equal(scanText(translated), null, "翻译不该命中——若此断言失败说明阈值被改得过敏了")
})

test("sanitizeText：截断点保住前文、砍掉泄露段、接上说明", () => {
  const prefix = "先说结论：这个分析可以做。下面把技能文档贴给你参考。\n\n"
  const tailMarker = "背景要重新取样"   // SKILL_BODY 末尾的独特词
  const out = sanitizeText(prefix + SKILL_BODY)
  assert.ok(out.startsWith(prefix.slice(0, 10)), "前文被误砍")
  assert.ok(out.includes(LEAK_NOTE), "缺截断说明")
  assert.ok(!out.includes(tailMarker), "泄露段的尾部没被砍掉")
  assert.equal(sanitizeText("完全无关的一句话。"), "完全无关的一句话。")
})

test("文件通道：md / zip 套 md / docx 形态都拦，无关文件放行", () => {
  const mdBuf = Buffer.from("# 导出的资料\n\n" + SKILL_BODY, "utf8")
  assert.ok(scanFileBuffer(mdBuf, "导出.md"), "md 文件未拦")
  const zipBuf = zip([{ name: "skills/SKILL.md", data: mdBuf }, { name: "readme.txt", data: Buffer.from("hi") }])
  assert.ok(scanFileBuffer(zipBuf, "打包.zip"), "zip 套技能文件未拦")
  // docx 形态：本质是 zip，正文在 word/document.xml 的标签之间
  const xml = `<?xml version="1.0"?><w:document><w:body><w:p><w:t>${SKILL_BODY.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</w:t></w:p></w:body></w:document>`
  const docx = zip([{ name: "word/document.xml", data: Buffer.from(xml, "utf8") }])
  assert.ok(scanFileBuffer(docx, "报告.docx"), "docx 形态未拦")
  assert.equal(scanFileBuffer(Buffer.from("普通的分析结果，与技能无关。", "utf8"), "结果.md"), null)
  assert.equal(scanFileBuffer(Buffer.from([0x89, 0x50, 0x4e, 0x47]), "图.png"), null)   // 二进制类型不扫
})

test("流式场景：干净前文逐步追加泄露段，追加后才命中", () => {
  const clean = "统计已完成，各组差异见下表。"
  assert.equal(scanText(clean), null)
  assert.ok(scanText(clean + "\n\n" + SKILL_BODY.slice(0, 800)), "追加泄露段后未命中")
})

#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""临床数据脱敏：检测并替换中国医疗数据里最常见的可识别信息(PII/PHI)。

覆盖：身份证号(18/15位,含校验)、手机号、住院号/病案号/门诊号、银行卡、Email、
座机、车牌、（可选）姓名列、具体日期。可对 CSV/Excel 的指定列、或任意文本做脱敏。

设计原则：
  - 宁可多报（把疑似 PII 标出来让人确认），也不要漏掉真 PII。
  - **一致性假名化**：同一个原值在整份数据里替换成同一个假名（P0001、P0002…），
    保留可分析性（能按患者聚合），又不泄露真实身份。映射表单独存，供必要时人工回溯。
  - **默认不把映射表混进脱敏输出**；映射另存 mapping.csv，提醒用户单独妥善保管/或销毁。

用法：
  # 文本/Markdown 文件
  python deidentify.py --input notes.txt --out notes_deid.txt

  # CSV：脱敏全表（自动扫每个单元格），姓名列显式指定按列假名化
  python deidentify.py --input patients.csv --out patients_deid.csv \
      --name-cols 姓名,患者姓名 --id-cols 住院号,身份证号

  # 只扫描报告有哪些 PII、不改数据（先看看）
  python deidentify.py --input patients.csv --scan-only
"""
import argparse
import csv
import os
import re
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


# ---- 检测规则（按精确度从高到低）----

# ---- 产物目录解析（8 个技能脚本统一；见 AGENTS.md §五）----
# 优先级：显式参数 > SCI_OUTPUT_DIR 环境变量 > 当前工作目录(若已在 outputs/<会话id>/ 内) > 报错中止。
# 【绝不】再默认写共享的 outputs/ 根：那里不会出现在界面"产出"侧栏，
# 且同一用户的多个会话共用一个 outputs 卷，写固定名会跨会话互相覆盖。
# 为什么必须由外部传进来：opencode 是【一个进程服务所有会话】的，
# 脚本自己读不到任何会话级上下文，只能靠主控（网关每轮注入的 preamble）用环境变量或参数告知。
def _resolve_out_dir(explicit=None):
    import os as _os, sys as _sys
    from pathlib import Path as _Path
    _cwd = _Path.cwd()
    _in_session = _cwd.parent.name == 'outputs'   # cwd 已是 outputs/<会话id>/
    if explicit:
        _p = _Path(explicit)
        # 【拦截已知的错误传法】cwd 已经是会话产物目录，却又传了以 outputs/ 开头的相对路径：
        # 那会写成 outputs/<会话id>/outputs/xxx —— 侧栏只递归一层，这是两层，
        # 这份产物在界面“产出”侧栏里【看不见】，用户会以为跑成功了却什么都没拿到。
        # 这是旧文档教出来的写法，宁可响亮报错也不要静默产出不可见的文件。
        if _in_session and not _p.is_absolute() and _p.parts and _p.parts[0] == 'outputs':
            _m = [
                '!! 产物目录参数写法有误，已中止。',
                '   你传的是： ' + str(explicit),
                '   当前工作目录已经【就是】本会话的产物目录： ' + str(_cwd),
                '   再拼 outputs/ 前缀会写成 ' + str(_cwd / _p) + '，',
                '   界面的“产出”侧栏只递归一层，再套一层的路径不会显示；且在会话产物目录里'
                '   再造一个名为 outputs 的目录，本身就说明误解了目录布局。',
                '   正确写法：直接用【裸文件名】（如 --out table1.csv），或干脆不传该参数。',
            ]
            _sys.exit(chr(10).join(_m))
        return _p
    _env = (_os.environ.get('SCI_OUTPUT_DIR') or '').strip()
    if _env:
        _e = _Path(_env)
        # 与 explicit 分支同样的拦截。这条尤其要紧：项目文档教的就是
        # `SCI_OUTPUT_DIR=outputs/<会话id>` 这个【相对】写法，而 cwd 已经是会话产物目录，
        # 解析出来就是 outputs/<会话id>/outputs/<会话id>/ —— 产物在界面上永远看不见。
        if _in_session and not _e.is_absolute() and _e.parts and _e.parts[0] == 'outputs':
            _m = [
                '!! 环境变量 SCI_OUTPUT_DIR 的写法有误，已中止。',
                '   当前值： SCI_OUTPUT_DIR=' + _env,
                '   当前工作目录已经【就是】本会话的产物目录： ' + str(_cwd),
                '   再拼 outputs/ 前缀会写成 ' + str(_cwd / _e) + '，',
                '   界面的“产出”侧栏只递归一层，再套一层的路径不会显示；且在会话产物目录里'
                '   再造一个名为 outputs 的目录，本身就说明误解了目录布局。',
                '   正确做法：不要设这个环境变量（脚本会自动认出当前目录），',
                '   或把它设成【绝对路径】。',
            ]
            _sys.exit(chr(10).join(_m))
        return _e
    if _in_session:
        return _cwd
    _msg = [
        '!! 未指定产物目录，已中止（不再默认写共享的 outputs/ 根）。',
        '   正常情况下不需要指定：每轮对话的当前工作目录就是本会话的产物目录，',
        '   直接用裸文件名即可（如 --out table1.csv）。现在会走到这里，说明当前工作目录是',
        '   ' + str(_cwd) + '，不在任何会话产物目录下。',
        '   请任选一种方式指定：',
        '     1) 先切回本会话的产物目录再跑（推荐）',
        '     2) 环境变量： SCI_OUTPUT_DIR=<会话产物目录绝对路径>',
        '     3) 显式参数： --outdir <会话产物目录绝对路径>',
        '   注意路径要用【绝对路径】或相对当前目录的正确路径，不要再拼 outputs/<会话id>：',
        '   那是旧架构的写法，现在会多套一层目录导致产物在界面上不可见。',
        '   原因：写到共享的 outputs/ 根会跨会话互相覆盖，且不出现在界面的“产出”侧栏里。',
    ]
    _sys.exit(chr(10).join(_msg))

def _resolve_out_file(explicit=None, default_name="output"):
    import sys as _sys
    from pathlib import Path as _Path
    if explicit:
        _p = _Path(explicit)
        # 同 _resolve_out_dir：cwd 已是会话产物目录时再拼 outputs/ 前缀，产物会落到
        # outputs/<会话id>/outputs/... —— 侧栏只递归一层，这是两层，用户看不见。
        if (_Path.cwd().parent.name == 'outputs' and not _p.is_absolute()
                and _p.parts and _p.parts[0] == 'outputs'):
            _m = [
                '!! 产物路径写法有误，已中止。',
                '   你传的是： ' + str(explicit),
                '   当前工作目录已经【就是】本会话的产物目录： ' + str(_Path.cwd()),
                '   再拼 outputs/ 前缀会写成 ' + str(_Path.cwd() / _p) + '，',
                '   界面的“产出”侧栏只递归一层，再套一层的路径不会显示；且在会话产物目录里'
                '   再造一个名为 outputs 的目录，本身就说明误解了目录布局。',
                '   正确写法：直接用【裸文件名】（如 --out ' + default_name + '）。',
            ]
            _sys.exit(chr(10).join(_m))
        return _p
    return _resolve_out_dir() / default_name


def _birthdate_plausible(yyyymmdd):
    """身份证里嵌的出生日期是否像真日期（月 01-12、日 01-31）。用于给 15 位老身份证
    加一道结构校验，把纯 15 位科研流水号/样本号挡在外面（旧版只 isdigit 全放行→误脱）。"""
    try:
        mm, dd = int(yyyymmdd[2:4]), int(yyyymmdd[4:6])
        return 1 <= mm <= 12 and 1 <= dd <= 31
    except (ValueError, IndexError):
        return False


def _id_card_ok(s):
    """18 位身份证校验位核验，降低误报（把随便一串 18 位数字当身份证）。
    15 位老身份证无校验位——校验其中嵌的出生日期(第 7-12 位 YYMMDD)结构是否可信，
    否则纯 15 位数字串(研究流水号等)会被误当身份证脱掉。"""
    if len(s) != 18:
        return len(s) == 15 and s.isdigit() and _birthdate_plausible(s[6:12])
    if not re.match(r"^\d{17}[\dXx]$", s):
        return False
    # 18 位第 7-14 位是 YYYYMMDD；月日结构也顺带核一下（校验位仍是主判据）。
    w = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2]
    check = "10X98765432"
    total = sum(int(s[i]) * w[i] for i in range(17))
    return check[total % 11] == s[17].upper()


# 数值型分析字段（血糖 13800138000 mmol/L、测序读长 …bp）里的长数字会撞手机号正则。
# 手机号后若紧跟计量单位，则判定为检验值/测量值而非电话，跳过——防静默破坏分析数据。
_UNIT_AFTER = re.compile(r"^\s*(mmol|mol|umol|μmol|nmol|mg|kg|ug|μg|ng|ml|mL|dl|dL|"
                         r"L|bp|kb|mb|Hz|mmHg|cm|mm|nm|IU|U/L|g/L|%|次|个|条|例)")


def _phone_ok_ctx(text, start, end):
    """手机号上下文校验：其后紧跟计量单位 → 是检验/测量值，不脱。"""
    return not _UNIT_AFTER.match(text[end:end + 8])


def _luhn_ok(s):
    """Luhn 校验：真实银行卡号满足，随机 16-19 位数字串基本不满足——
    大幅降低把科研长数字（样本编号/坐标/流水号）误当银行卡的假阳性。"""
    digits = [int(c) for c in s if c.isdigit()]
    if not 16 <= len(digits) <= 19:
        return False
    total, parity = 0, len(digits) % 2
    for i, d in enumerate(digits):
        if i % 2 == parity:
            d *= 2
            if d > 9:
                d -= 9
        total += d
    return total % 10 == 0


PATTERNS = [
    # (类别, 正则, 可选校验函数, 假名前缀)
    # 身份证在银行卡之前——18 位身份证也像银行卡，先按身份证识别、校验位核验。
    ("身份证", re.compile(r"(?<![0-9])(\d{17}[\dXx]|\d{15})(?![0-9])"), _id_card_ok, "ID"),
    # 手机号：容忍 +86/86 前缀与 -/空格 分隔（138-1234-5678、+8613812345678 都能抓）。
    ("手机号", re.compile(r"(?<![0-9])(?:\+?86[\-\s]?)?1[3-9]\d(?:[\-\s]?\d){8}(?![0-9])"), None, "MOB"),
    ("Email", re.compile(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}"), None, "MAIL"),
    # 银行卡：Luhn 校验，避免误伤任意 16-19 位数字。
    ("银行卡", re.compile(r"(?<![0-9])\d{16,19}(?![0-9])"), _luhn_ok, "CARD"),
    ("座机", re.compile(r"(?<![0-9])0\d{2,3}-?\d{7,8}(?![0-9])"), None, "TEL"),
    ("车牌", re.compile(r"[京津沪渝冀豫云辽黑湘皖鲁苏浙赣鄂桂甘晋蒙陕吉闽贵粤青藏川宁琼新]\s?[A-Z]\s?[A-Z0-9]{5,6}"), None, "PLATE"),
    # 证件号：医保卡/社保号/护照/军官证——各有格式特征。
    ("医保社保", re.compile(r"(医保卡?号?|社保号?|参保号)\s*(?:为|是|:|：|=|\s)?\s*([A-Za-z0-9]{8,20})"), None, "INS"),
    # 中国护照：E/G/D/S/P + 8 位数字（因私/公务/外交…）。
    ("护照", re.compile(r"(?<![A-Za-z0-9])[EeGgDdSsPp]\d{8}(?![A-Za-z0-9])"), None, "PASS"),
    ("军官证", re.compile(r"(军官证|士兵证)\s*(?:为|是|:|：|=|\s)?\s*([A-Za-z0-9]{6,15})"), None, "MIL"),
    # 住院号/病案号等：标签+号码；标签与号码间容忍"为/是/：/空格"等连接词。
    # 值组同时接受字母数字号(ZY0089123)与中文床位自然写法(内科3床、3床)。
    ("病案标识", re.compile(r"(住院号|病案号|病历号|档案号|门诊号|就诊卡号|登记号|标本号|床位?号?)\s*(?:为|是|:|：|=|\s)?\s*([A-Za-z0-9\-]{2,}|[一-龥]{0,4}\d{1,4}床?)"), None, "MRN"),
    # 住址：从 省/市/区/县 锚点起，贪婪吃掉后续"若干中文/数字 + 门牌后缀"的重复段，
    # 直到地址结束——把 中关村南大街27号院3号楼502室 整段一次吞掉，不留尾巴。锚点词降误脱。
    ("住址", re.compile(
        r"(?:[一-龥]{2,7}?(?:省|自治区|特别行政区))?"
        r"(?:[一-龥]{2,7}?(?:市|自治州|盟))?"
        r"(?:[一-龥]{2,7}?(?:区|县|旗))"
        r"(?:[一-龥0-9]{1,20}?(?:路|街|道|巷|弄|大道|大街|号院|号楼|小区|花园|公寓|大厦|广场|"
        r"村|镇|乡|号|栋|幢|座|单元|室|层|房|组|队))+"), None, "ADDR"),
    # 高龄（≥90 岁）：HIPAA 建议 >89 归并以防重识别。只脱 ≥90，正常年龄(60岁)不动。
    ("高龄", re.compile(r"(?<![0-9])(9\d|1[0-4]\d)\s*(?=岁|周岁)"), None, "AGE"),
    # 具体日期（默认不脱，用 --dates 开启）
    ("日期", re.compile(r"(?<![0-9])(19|20)\d{2}[-/年.](0?[1-9]|1[0-2])[-/月.](0?[1-9]|[12]\d|3[01])日?(?![0-9])"), None, "DATE"),
]


_PREFIX = {cat: prefix for cat, _pat, _v, prefix in PATTERNS}
_PREFIX["姓名"] = "P"

# 常见百家姓（覆盖 >99% 汉族人口）。用于给姓名候选加"首字须为姓"的护栏，
# 避免把"出现/周期/王道"这类以常用字开头的普通词当人名脱掉。
_SURNAMES = (
    "王李张刘陈杨赵黄周吴徐孙胡朱高林何郭马罗梁宋郑谢韩唐冯于董萧程曹袁邓许傅沈曾彭吕"
    "苏卢蒋蔡贾丁魏薛叶阎余潘杜戴夏钟汪田任姜范方石姚谭廖邹熊金陆郝孔白崔康毛邱秦江史"
    "顾侯邵孟龙万段漕钱汤尹黎易常武乔贺赖龚文庞樊兰殷施陶洪翟安颜倪严牛温芦季俞章鲁葛伍"
    "韦申尤毕聂丛焦向柳邢路岳齐沿梅莫庄辛管祝左涂谷祁时舒耿牟卜路詹关苗凌费纪靳盛童欧甄"
    "项曲成游阳裴席卫查屈鲍位覃霍翁隋植甘景薄单包司柏宁柯阮桂闵欧阳解强柴华车冉房边辜吉"
    "饶刁瞿戚丘古米池滕晋苑邬臧畅宫来嵺苟全褚廉简娄盖符奚木穆党燕郎邸冀谈姬屠连郜晏栾郁")
# 称谓触发词：临床文本里的人名几乎都有这类前缀。命中"称谓+姓+1~2字"才脱，精度高、不伤术语。
_APPEL = (r"患者|病人|患儿|家属|陪护|陪人|代诉人|主诉人|联系人|监护人|委托人|受试者|供者|受者|"
          r"主治医师|主治医生|经治医师|管床医师|接诊医师|主刀医师|麻醉医师|住院医师|医师|医生|"
          r"护士|护师|责任护士|主任|教授|大夫|技师|"
          r"女儿|儿子|子女|配偶|丈夫|妻子|爱人|父亲|母亲|哥哥|弟弟|姐姐|妹妹|孙子|外孙")
_NAME_RE = re.compile(
    r"(?P<appel>" + _APPEL + r")"
    r"(?P<sep>[（(]?(?:姓名|系|为|叫|是|：|:|，|,)?[）)]?\s*)"
    r"(?P<name>[" + _SURNAMES + r"][一-龥]{1,2})"
)


# 3 字名末位若是这些字，几乎不是给定名用字、却常作紧邻词的词首（电话/联系/主诉/病史/
# 住院/门诊/性别/年龄…）——说明贪婪多吃了一字，回退为 2 字名并把该字还回文本。
_NAME_TAIL_STOP = set("电话联系诉病住门床身年性无现男女的为是在于及与和即自因经已未曾")


def mask_names(text, mask, hits):
    """脱自由文本里的中文人名：命中"称谓词 + 百家姓开头的 2~3 字名"才替换，保留称谓与分隔。
    这样'患者张伟'→'患者[P0001]'，而'患者出现发热''月经周期'不受影响（出/周期不在姓+名模式）。"""
    def _sub(m):
        name = m.group("name")
        trailing = ""
        if len(name) == 3 and name[2] in _NAME_TAIL_STOP:
            trailing = name[2]      # 多吃的字（如'电话'的电）还回去
            name = name[:2]
        hits.append(("姓名", name))
        return m.group("appel") + m.group("sep") + mask("姓名", name) + trailing
    return _NAME_RE.sub(_sub, text)


def make_masker():
    """返回 (mask 函数, 映射表)。同一原值→同一假名，跨整份数据一致。
    每个类别用不同前缀（手机 MOB / 座机 TEL …），避免不同 PII 撞同名。"""
    counters, mapping = {}, {}

    def mask(category, value):
        key = (category, value)
        if key not in mapping:
            counters[category] = counters.get(category, 0) + 1
            prefix = _PREFIX.get(category, "X")
            mapping[key] = f"[{prefix}{counters[category]:04d}]"
        return mapping[key]

    return mask, mapping


def deidentify_text(text, mask, do_dates=False, do_names=True):
    hits = []
    # 先脱自由文本里的中文人名（称谓触发）。放最前：避免号码脱敏后打乱称谓上下文。
    if do_names:
        text = mask_names(text, mask, hits)
    for category, pat, validator, _prefix in PATTERNS:
        if category == "日期" and not do_dates:
            continue

        def _sub(m, category=category, validator=validator):
            # 标签+号码型（病案标识/医保社保/军官证）：保留标签，替换其后的号码
            if category in ("病案标识", "医保社保", "军官证"):
                label, num = m.group(1), m.group(2)
                hits.append((category, num))
                return f"{label}{mask(category, num)}"
            # 手机号：其后紧跟计量单位 → 是检验/测量值(血糖13800138000 mmol/L)，不脱。
            if category == "手机号" and not _phone_ok_ctx(text, m.start(), m.end()):
                return m.group(0)
            val = m.group(0)
            if validator and not validator(val):
                return val  # 校验不过，不当 PII
            hits.append((category, val))
            return mask(category, val)

        text = pat.sub(_sub, text)
    return text, hits


def _read_text(path):
    """按 utf-8-sig → gbk → gb18030 尝试；都失败才报错。绝不用 errors='replace'
    静默吞掉——国内 HIS 常导出 GBK，静默乱码会让用户拿到看似脱敏实则损坏的文件。"""
    for enc in ("utf-8-sig", "gbk", "gb18030"):
        try:
            with open(path, encoding=enc) as f:
                return f.read(), enc
        except UnicodeDecodeError:
            continue
    sys.exit(f"无法解码文件（试过 utf-8/gbk/gb18030）：{path}。请确认是纯文本/CSV，或先转成 UTF-8。")


BINARY_EXTS = {".xlsx", ".xls", ".doc", ".docx", ".pdf", ".zip", ".rtf"}


def _guard_binary(path):
    ext = os.path.splitext(path)[1].lower()
    if ext in BINARY_EXTS:
        sys.exit(f"不支持二进制格式 {ext}：请先用 data-analysis 技能/Excel 把它另存为 CSV 再脱敏。"
                 "（直接处理二进制会静默产出乱码、看似脱敏实则未处理，已阻止。）")


def _warn_suspicious_columns(header, name_cols, id_cols, addr_cols):
    """表头里像标识列（含 号/编号/姓名/住址/电话/医生 等）但没被显式指定的，
    警告用户：这些列不会按列强制脱敏，可能有 PII 漏出。"""
    kw = re.compile(r"(号|编号|卡号|ID|Id|No\.?|姓名|名字|name|住址|地址|户籍|address|"
                    r"电话|手机|联系方式|phone|mobile|医生|医师|大夫|主诉人|家属|联系人)", re.I)
    covered = name_cols | id_cols | addr_cols
    sus = [h for h in header if h.strip() and h.strip() not in covered and kw.search(h)]
    if sus:
        print("⚠️ 疑似标识列未被显式指定（不会按列强制脱敏，仅靠正则扫描，可能漏）："
              + "、".join(sus))
        print("   如含 PII，请用 --id-cols / --name-cols / --addr-cols 指定这些列名。")
        return sus
    return []


def process_csv(path, out, mask, name_cols, id_cols, addr_cols, do_dates, scan_only):
    _, enc = _read_text(path)  # 只为探测编码；下面用同一编码读
    with open(path, newline="", encoding=enc) as f:
        rows = list(csv.reader(f))
    if not rows:
        return [], 0, []
    header = rows[0]
    name_idx = {i for i, h in enumerate(header) if h.strip() in name_cols}
    id_idx = {i for i, h in enumerate(header) if h.strip() in id_cols}
    addr_idx = {i for i, h in enumerate(header) if h.strip() in addr_cols}
    # 表头强人名特征列（医生/医师/大夫/护士/家属/联系人/主诉人/患者姓名…）即使没显式指定也
    # 自动按姓名脱敏——合规优先，防医生/家属姓名整列静默泄漏。用【强】特征避免误伤"药品名/项目名"。
    strict_name = re.compile(r"(姓名|患者名|家属|亲属|医生|医师|大夫|护士|主诉人|联系人|经治医|监护人|陪护)")
    auto_name = {i for i, h in enumerate(header)
                 if i not in (name_idx | id_idx | addr_idx) and h.strip() and strict_name.search(h)}
    if auto_name:
        print("ℹ️ 以下列名含人名特征，已【自动】按姓名脱敏（如误伤请用列参数显式排除）："
              + "、".join(header[i] for i in sorted(auto_name)))
        name_idx |= auto_name
    suspicious = _warn_suspicious_columns(header, name_cols | {header[i] for i in auto_name},
                                          id_cols, addr_cols)
    all_hits = []
    for r in rows[1:]:
        for i, cell in enumerate(r):
            if i in name_idx and cell.strip():
                all_hits.append(("姓名", cell))
                if not scan_only:
                    r[i] = mask("姓名", cell.strip())
                continue
            if i in id_idx and cell.strip():
                all_hits.append(("病案标识", cell))
                if not scan_only:
                    r[i] = mask("病案标识", cell.strip())
                continue
            if i in addr_idx and cell.strip():
                all_hits.append(("住址", cell))
                if not scan_only:
                    r[i] = mask("住址", cell.strip())
                continue
            # 结构化单元格不跑称谓式姓名检测（无上下文，且列已由 --name-cols 覆盖）。
            new, hits = deidentify_text(cell, mask, do_dates, do_names=False)
            all_hits.extend(hits)
            if not scan_only:
                r[i] = new
    if not scan_only:
        os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
        with open(out, "w", newline="", encoding="utf-8-sig") as f:
            csv.writer(f).writerows(rows)
    return all_hits, len(rows) - 1, suspicious


def main():
    ap = argparse.ArgumentParser(description="临床数据脱敏（中国 PII/PHI）")
    ap.add_argument("--input", required=True)
    ap.add_argument("--out", default=None)
    ap.add_argument("--name-cols", default="", help="CSV 里的姓名列名，逗号分隔")
    ap.add_argument("--id-cols", default="", help="CSV 里的标识号列名（住院号等），逗号分隔")
    ap.add_argument("--addr-cols", default="", help="CSV 里的地址列名（家庭住址等），逗号分隔")
    ap.add_argument("--dates", action="store_true", help="同时脱敏具体日期（默认不脱）")
    ap.add_argument("--scan-only", action="store_true", help="只报告 PII、不改数据")
    ap.add_argument("--require-review", action="store_true",
                    help="脱敏后以非 0 退出码强制上游停下人工复核（当作合规闸时用，防自动流程据\"成功\"直接往下）")
    args = ap.parse_args()
    # --scan-only 不产出文件，不该解析产物目录（否则非会话目录下会崩）。
    if not args.scan_only:
        args.out = str(_resolve_out_file(args.out, "deidentified_output"))

    _guard_binary(args.input)  # 拒绝 .xlsx/.doc 等二进制，避免静默乱码
    name_cols = {x.strip() for x in args.name_cols.split(",") if x.strip()}
    id_cols = {x.strip() for x in args.id_cols.split(",") if x.strip()}
    addr_cols = {x.strip() for x in args.addr_cols.split(",") if x.strip()}
    mask, mapping = make_masker()
    ext = os.path.splitext(args.input)[1].lower()
    suspicious = []

    if ext == ".csv":
        hits, n, suspicious = process_csv(args.input, args.out, mask, name_cols,
                                          id_cols, addr_cols, args.dates, args.scan_only)
        scope = f"CSV {n} 行"
    else:
        text, _enc = _read_text(args.input)
        new, hits = deidentify_text(text, mask, args.dates)
        scope = "文本"
        if not args.scan_only:
            os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
            open(args.out, "w", encoding="utf-8").write(new)

    from collections import Counter
    dist = Counter(c for c, _ in hits)
    print(f"扫描范围：{scope}")
    print("检出 PII：" + ("，".join(f"{k} {v}" for k, v in dist.items()) if dist else "无") )
    if args.scan_only:
        print("（--scan-only：仅扫描，未改数据）")
        print("⚠️ 姓名等中文命名实体正则难以穷尽，务必人工复核！")
        return

    # 映射表另存，提醒单独保管
    if mapping:
        map_path = os.path.splitext(args.out)[0] + "_mapping.csv"
        with open(map_path, "w", newline="", encoding="utf-8-sig") as f:
            w = csv.writer(f)
            w.writerow(["类别", "原值", "假名"])
            for (cat, val), pseudo in mapping.items():
                w.writerow([cat, val, pseudo])
        print(f"脱敏输出：{args.out}")
        print(f"⚠️ 映射表：{map_path} —— 含原始 PII，请单独妥善保管或用后销毁，切勿随数据一起外发。")

    # ---- 醒目复核闸：防自动化流程据"成功"直接往下、把漏检的姓名/住址外泄 ----
    got_name = dist.get("姓名", 0)
    print("=" * 56)
    print("⚠️ 脱敏≠可直接外发。中文姓名/住址等靠规则难以穷尽，务必人工通读脱敏结果再对外或分析。")
    if scope.startswith("CSV"):
        if not (name_cols or addr_cols):
            print("⚠️ 未用 --name-cols/--addr-cols 指定姓名/住址列——这类列很可能【未被脱敏】。"
                  "请指定后重跑，或人工核对。")
        if suspicious:
            print("⚠️ 存在疑似标识列未显式指定：" + "、".join(suspicious))
    else:
        if got_name == 0:
            print("⚠️ 自由文本里【未检出任何姓名】。若原文含人名，可能是无称谓前缀导致规则未命中——"
                  "请人工核对，勿据\"成功\"直接使用。")
    print("=" * 56)

    if args.require_review:
        print("‼️ --require-review：已用非 0 退出码强制停下，请人工复核脱敏结果后再继续下游。")
        sys.exit(3)


if __name__ == "__main__":
    main()

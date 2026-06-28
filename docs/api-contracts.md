# API 契约对照表 (Wave 1-A)

本文档给出 Wave 1-A 后端新增 10 条 API 的请求/响应 schema, 供 W1-B/C/D/E/F 前端 agent 实现时对照。

所有路由都挂在 FastAPI `app` 下, 前缀 `/api/...`。所有 multipart 上传走共享的 30MB 上限保护 (`_read_capped`), 超过返回 `{"ok": false, "error": "文件过大..."}`。

mock 模式(无 `LLM_API_KEY` 或 `MOCK_LLM=1`)下, 涉及画图/调用 LLM 的端点返回固定演示数据(标记 `mock: true`), 让前端可离线开发与 e2e 测试。

---

## 1. 病例数据脱敏

### `POST /api/deidentify/scan`

**请求**: multipart, 字段 `file` (csv/xlsx)。

**响应**: `200 application/json`
```json
{
  "ok": true,
  "columns": [
    {
      "name": "姓名",
      "phi_types": ["name"],
      "count": 2,
      "samples": ["张三", "李四"]
    },
    {
      "name": "身份证号",
      "phi_types": ["id_card"],
      "count": 1,
      "samples": ["11010519491231002X"]
    }
  ],
  "total_rows": 100
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `columns[].name` | str | 列名 |
| `columns[].phi_types` | str[] | 检出的 PHI 类型, 取自 `name` / `id_card` / `phone` / `mrn` / `birth` |
| `columns[].count` | int | 该列匹配 PHI 的单元格数 |
| `columns[].samples` | str[] | 最多 3 个匹配样例(供前端预览) |
| `total_rows` | int | 数据总行数 |

错误响应: `{"ok": false, "error": "..."}` (HTTP 200)。

---

### `POST /api/deidentify/apply`

**请求**: multipart
- `file`: 要脱敏的 csv/xlsx (必填)
- `columns`: JSON 字符串, 列名数组, 例如 `'["姓名","身份证"]'` (必填)

**响应**:
```json
{
  "ok": true,
  "data_base64": "<脱敏后文件的 base64>",
  "filename": "data.csv",
  "mapping": {
    "姓名": { "张三": "PT0001", "李四": "PT0002" },
    "MRN":  { "H001":  "PT0001", "H002":  "PT0002" }
  }
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `data_base64` | str | 脱敏后字节流(原格式)的 base64 |
| `filename` | str | 原文件名(供前端下载使用) |
| `mapping` | object | 每列的 `原值 -> 脱敏值` 映射表; 前端**只**本地保存, 不上服务端 |

替换规则:
- 姓名/MRN -> `PT0001..PT9999` 顺序编号, 同值映射同值
- 身份证 -> 保留前 4 位 + 后 4 位, 中间 10 位 `*` 打码
- 手机号 -> 保留前 3 后 4, 中间 4 位 `*` 打码
- 出生日期 -> 仅保留年份 `YYYY`

---

## 2. 引用导入导出

### `POST /api/refs/import`

**请求**: multipart
- `file`: .ris / .bib / .enw 字节流 (必填)
- `format`: 字符串 `"ris" | "bib" | "enw"` (必填)

**响应**:
```json
{
  "ok": true,
  "refs": [
    {
      "title": "A study of stuff",
      "authors": ["Smith, John", "Doe, Jane"],
      "journal": "Journal of Things",
      "year": "2020",
      "volume": "10",
      "issue": "2",
      "pages": "100-110",
      "doi": "10.1234/test",
      "url": "https://example.org/paper",
      "abstract": "This is an abstract."
    }
  ]
}
```

**Reference 统一结构**(全部字段, 后 7 项可为 `null`):

| 字段 | 类型 | 必填 |
|---|---|---|
| `title` | str | 是 |
| `authors` | str[] | 是(可为空数组) |
| `journal` | str | 是(可为空字符串) |
| `year` | str \| null | 否 |
| `volume` | str \| null | 否 |
| `issue` | str \| null | 否 |
| `pages` | str \| null | 否 |
| `doi` | str \| null | 否 |
| `url` | str \| null | 否 |
| `abstract` | str \| null | 否 |

---

### `POST /api/refs/export`

**请求**: JSON
```json
{
  "refs": [ /* Reference[] (同上) */ ],
  "format": "ris"
}
```

**响应**: `200 application/octet-stream`, 字节流 + `Content-Disposition: attachment; filename=references.<ext>`。前端用 `Response.blob()` 触发下载。

格式错误返回 `400 text/plain`。

---

## 3. 医学图表三件套

### `POST /api/analyze/forest`

**请求**: JSON
```json
{
  "studies": [
    {"study": "Trial A", "n_treat": 100, "event_treat": 30, "n_ctrl": 100, "event_ctrl": 50},
    {"study": "Trial B", "n_treat": 80,  "event_treat": 20, "n_ctrl": 80,  "event_ctrl": 35}
  ],
  "effect": "OR",
  "format": "png"
}
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `studies` | object[] | 是 | 每条 study 必含 `n_treat`/`event_treat`/`n_ctrl`/`event_ctrl`, 可选 `study`(标签) |
| `effect` | `"OR"` \| `"RR"` | 否 | 默认 `"OR"` |
| `format` | `"png"` \| `"svg"` \| `"pdf"` | 否 | 默认 `"png"`(前端要哪种主图) |

**响应**:
```json
{
  "ok": true,
  "image_base64": "<图字节的 base64>",
  "format": "png",
  "summary": {
    "pooled": 0.62,
    "ci_low": 0.42,
    "ci_high": 0.92,
    "i2": 18.5,
    "q_pvalue": 0.34,
    "k": 2
  }
}
```

mock 模式额外返回 `"mock": true` 且 `image_base64` 为空字符串。

---

### `POST /api/analyze/km`

**请求**: multipart
- `file`: csv/xlsx (必填)
- `time_col`: 时间列名 (必填)
- `event_col`: 事件列名 (0/1, 必填)
- `group_col`: 分组列名 (可选; 给定则附 log-rank)
- `format`: `"png"` \| `"svg"` \| `"pdf"` (默认 png)

**响应**:
```json
{
  "ok": true,
  "image_base64": "...",
  "format": "png",
  "logrank_p": 0.034,
  "groups": [
    {"name": "A", "median_survival": 18.5, "n": 60},
    {"name": "B", "median_survival": 24.3, "n": 60}
  ]
}
```

无分组时 `logrank_p` 为 `null`, `groups` 单条 `name="All"`。

---

### `POST /api/analyze/roc`

**请求**: multipart
- `file`: csv/xlsx (必填)
- `y_true_col`: 真实标签列 (0/1, 必填)
- `y_score_col`: 预测分数列 (float, 必填)
- `format`: `"png"` \| `"svg"` \| `"pdf"` (默认 png)

**响应**:
```json
{
  "ok": true,
  "image_base64": "...",
  "format": "png",
  "auc": 0.84,
  "auc_ci": [0.78, 0.89],
  "threshold": 0.51
}
```

`auc_ci` 通过 bootstrap 1000 次得到 95% 区间; `threshold` 是 Youden's J 最优切点。

---

## 4. 样本量交互式扫描

### `POST /api/samplesize/sweep`

**请求**: JSON
```json
{
  "scenario": "two_means",
  "fixed_params": {"alpha": 0.05, "power": 0.8},
  "vary": "effect_size",
  "range_values": [0.2, 0.3, 0.5, 0.8]
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `scenario` | `"two_proportions"` \| `"two_means"` \| `"one_proportion"` \| `"one_mean"` | 设计类型 |
| `fixed_params` | object | 固定参数; 两组场景常含 `alpha`/`power`, two_proportions 需 `p1`, one_proportion 需 `p0` |
| `vary` | str | 要扫描的参数名, 如 `effect_size`/`p2`/`alpha`/`power`/`p1` |
| `range_values` | float[] | 扫描值列表 |

**响应**:
```json
{
  "ok": true,
  "points": [
    {"value": 0.2, "n": 788},
    {"value": 0.3, "n": 352},
    {"value": 0.5, "n": 128},
    {"value": 0.8, "n": 52}
  ]
}
```

`n` 为总样本量; 某点求解失败时 `n=0`(前端可过滤或显示为空缺)。

---

## 5. 统计顾问 Q&A

### `POST /api/stats/advice` (SSE 流式)

**请求**: JSON
```json
{
  "question": "60 人分两组比较 HbA1c",
  "data_meta": {
    "n_rows": 60,
    "columns": [
      {"name": "group", "dtype": "category"},
      {"name": "HbA1c", "dtype": "float", "missing": 3}
    ],
    "groups": {"A": 30, "B": 30}
  }
}
```

`data_meta` 可选; 若传则模型不会臆造数据中不存在的列。

**响应**: SSE (text/event-stream), 与现有 `/api/run` 一致:

```
event: delta
data: {"text": "<片段>"}

event: delta
data: {"text": "<片段>"}

...

event: done
data: {}
```

或错误事件:
```
event: error
data: {"message": "..."}
```

把所有 `delta.text` 拼接后, 前端用 `JSON.parse()` 解析得到下列**严格 JSON**:

```json
{
  "recommended": {
    "test": "独立样本 t 检验",
    "why": "两个独立组比较一个连续变量的均值..."
  },
  "assumptions": [
    "两组独立同分布",
    "结局变量近似正态分布",
    "两组方差齐性"
  ],
  "cautions": [
    "样本量较小时优先报告效应量 Cohen's d 与 95% 置信区间",
    "多组多次比较时务必做多重比较校正"
  ],
  "alternatives": [
    {"test": "Wilcoxon 秩和检验", "when": "结局非正态或样本量较小"},
    {"test": "Welch's t 检验", "when": "两组方差不齐"},
    {"test": "线性回归(ANCOVA)", "when": "需要调整协变量"}
  ]
}
```

mock 模式: 上述演示 JSON 被分块吐出, 前端 UX 与真实流式一致。

---

## 6. 伦理材料模板

### `POST /api/ethics/render`

**请求**: JSON
```json
{
  "template": "informed_consent",
  "fields": {
    "研究名称": "...",
    "研究目的": "...",
    "风险": "...",
    "受益": "...",
    "研究者": "...",
    "联系方式": "...",
    "机构": "...",
    "日期": "2026-06-28"
  }
}
```

| 字段 | 取值 |
|---|---|
| `template` | `"informed_consent"` \| `"protocol"` \| `"crf"` \| `"data_use_commitment"` |
| `fields` | 任意 key-value 占位填充表; 缺失字段会以 `[字段名]` 形式(暖色琥珀字体)保留在 docx 中 |

各模板支持的字段:
- **informed_consent**: 研究名称 / 研究者 / 机构 / 联系方式 / 日期 / 研究目的 / 风险 / 受益
- **protocol**: 研究名称 / 研究者 / 机构 / 联系方式 / 日期 / 研究目的 / 研究设计 / 入选标准 / 排除标准 / 样本量 / 主要终点 / 次要终点 / 干预措施 / 统计分析 / 风险 / 受益
- **crf**: 研究名称 / 干预措施 / 主要终点 / 次要终点
- **data_use_commitment**: 研究名称 / 研究者 / 机构 / 联系方式 / 数据来源 / 保存期限 / 存储位置 / 日期

**响应**: `200 application/vnd.openxmlformats-officedocument.wordprocessingml.document` + `Content-Disposition: attachment; filename=<template>.docx`。

未知模板返回 `400 text/plain` 错误消息。

---

## 错误响应统一约定

| 端点类型 | 出错时的响应 |
|---|---|
| JSON 返回的端点(scan/apply/import/forest/km/roc/sweep) | HTTP 200 + `{"ok": false, "error": "..."}` |
| 文件下载端点(export/ethics) | HTTP 400/500 + `text/plain` 错误消息 |
| SSE 端点(stats/advice) | 在流中发 `event: error\ndata: {"message": "..."}` |

文件大小超过 30MB: HTTP 200 + `{"ok": false, "error": "文件过大（超过 30MB），请上传更小的文件。"}`

---

## mock 模式行为速查

| 端点 | mock 模式 |
|---|---|
| `/api/deidentify/*` | **真实**计算(不调 LLM, 无需 mock) |
| `/api/refs/*` | **真实**解析(不调 LLM, 无需 mock) |
| `/api/analyze/forest` | 固定 summary, image_base64 为空 |
| `/api/analyze/km` | 固定 groups + logrank_p, image_base64 为空 |
| `/api/analyze/roc` | 固定 auc + threshold, image_base64 为空 |
| `/api/samplesize/sweep` | **真实**计算(无 LLM 调用) |
| `/api/stats/advice` | 演示 JSON 流式输出, 前端解析方式一致 |
| `/api/ethics/render` | **真实**生成 docx |

前端在 mock 模式下应:
- 图表 endpoint 若返回 `mock: true` 且 `image_base64 == ""`, 显示"演示模式 - 真实图请配置 LLM 后查看"占位
- 其余 endpoint 与生产模式行为一致

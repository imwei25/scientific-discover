# 文献检索源 API key 配置（多用户服务器）

## 为什么要配
服务器上所有用户容器**共用一个出口 IP**。学术检索源（PubMed/NCBI、Semantic Scholar、
OpenAlex、Crossref、Europe PMC）对匿名请求按 IP 限速：人一多，整台机器会被当成"一个
超频用户"返回 `429 Too Many Requests`。这不是"封 IP"，是限速——解法是**给每个源带上
联系邮箱 / API key**，进它们各自独立、更高的额度或礼贝池。绝大部分免费。

## 一次配置，处处生效
所有 key 只填在**一个文件**：`deploy/.env`。`render-compose.sh` 会把它们注入每个用户
容器（`SCI_CONTACT_EMAIL / NCBI_API_KEY / S2_API_KEY / OPENALEX_API_KEY /
CROSSREF_PLUS_TOKEN`）。**换服务器时只需把 `deploy/.env` 拷过去**，无需逐个 export、
无需改任何脚本。留空的 key = 该源走免费匿名档，功能不变、只是更容易被限速。

联系邮箱是**一个变量覆盖所有源**；脚本内部对老变量名（`MEDSCI_CONTACT_EMAIL` /
`CONTACT_EMAIL` / `OPENALEX_MAILTO`）仍兼容，已配过的服务器不用动。

## 各 key 怎么拿（按性价比）

| 变量 | 费用 | 作用 | 获取 |
|---|---|---|---|
| `SCI_CONTACT_EMAIL` | 免费**必填** | 进 Crossref/OpenAlex/EuropePMC 礼貌池；Unpaywall/NCBI 要求 | 填一个真实邮箱（别用 example.com） |
| `NCBI_API_KEY` | 免费 **强烈建议** | PubMed 限速 3→10 req/s（最易 429 的源） | [NCBI 账号](https://www.ncbi.nlm.nih.gov/account/) → Settings → API Key Management；量大可免费邮件申请 >10 rps：eutilities@ncbi.nlm.nih.gov |
| `S2_API_KEY` | 免费 建议 | Semantic Scholar 从"全体共享 100/5min"升到独享高额度 | [S2 API 申请表](https://www.semanticscholar.org/product/api) |
| `OPENALEX_API_KEY` | 用量计费 可选 | 2026-02 起需 key，每天 $1 免费额度（纯元数据检索通常够） | [openalex.org](https://openalex.org/) 注册 |
| `CROSSREF_PLUS_TOKEN` | **$550/年 起** 可选 | 独立服务器池 + SLA；仅公共池仍不稳时才需要 | [Metadata Plus](https://www.crossref.org/services/metadata-retrieval/metadata-plus/) |

Europe PMC 无需 key、限速宽松，是无 key 时最稳的免费主力（已默认带联系邮箱进礼貌池）。

## 落地步骤（服务器上）
```bash
cd /root/sci-agent
git pull                                   # 取脚本更新
cp -n deploy/.env.example deploy/.env       # 首次；随后编辑填 key
vim deploy/.env                             # 至少填 SCI_CONTACT_EMAIL，建议加 NCBI_API_KEY / S2_API_KEY
bash deploy/scripts/redeploy-skills.sh      # 一键：重建镜像 + 重渲染 compose + 重建容器
```
容器会在下次用户请求时以新镜像/新环境变量启动（按需唤醒，见 manager.mjs）。

## 建议的分步策略
1. **先做免费的**：填 `SCI_CONTACT_EMAIL` + `NCBI_API_KEY` + `S2_API_KEY`，跑一两周看 429 是否消失。
2. **仍不稳再加钱**：只上 `CROSSREF_PLUS_TOKEN`（$550/年，独立池），通常足够。

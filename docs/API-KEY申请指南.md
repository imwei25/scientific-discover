# 文献检索源 API Key 申请指南

> 一句话:这些学术源对匿名请求是**按 IP 限速(返回 429)**,不是封 IP。服务器多用户
> 共用一个出口 IP 才容易被掐。填了下面的 key/邮箱 → 每个源走独立更高的额度,稳定性大增。
> **绝大部分免费。** 所有 key 只填在**一个文件** `deploy/.env`,换服务器把它拷过去即可。

## 一览:要哪些、什么价、优先级

| 变量名 | 费用 | 优先级 | 作用 |
|---|---|---|---|
| `SCI_CONTACT_EMAIL` | **免费** | ⭐必填 | 一个真实邮箱,进 Crossref/OpenAlex/EuropePMC 礼貌池;Unpaywall、NCBI 也要求 |
| `NCBI_API_KEY` | **免费** | ⭐强烈建议 | PubMed 限速 3→10 req/s(最容易 429 的源) |
| `S2_API_KEY` | **免费** | 建议 | Semantic Scholar 从"全体共享 100次/5分钟"升到独享高额度 |
| `OPENALEX_API_KEY` | 用量计费(每天 $1 免费额度) | 可选 | 2026-02 起 OpenAlex 需 key;免费额度对纯检索通常够 |
| `CROSSREF_PLUS_TOKEN` | **$550/年起** | 可选(先不用) | 独立服务器池 + SLA;仅公共池仍不稳时才买 |

> Europe PMC 无需 key、限速宽松,是没 key 时最稳的免费主力(已默认带联系邮箱进礼貌池)。
> Unpaywall 也不需要单独 key,填了 `SCI_CONTACT_EMAIL` 即合规。

---

## 逐个申请步骤

### 1. `SCI_CONTACT_EMAIL`（免费·必填·30 秒）
不是 key,就是一个**真实联系邮箱**。多个源用它标识调用方、放你进礼貌池。
- 填你或团队的真实邮箱,例如 `guweihuawei@gmail.com` 或机构邮箱。
- ⚠ 不要用 `example.com` 之类假域名——Unpaywall 会直接拒(返回 422)。

### 2. `NCBI_API_KEY`（免费·强烈建议·约 2 分钟）
PubMed/NCBI 是最严的源(匿名仅 3 请求/秒,按整台机器 IP 算),配了 key 提到 10/秒。
1. 打开 https://www.ncbi.nlm.nih.gov/account/ ,注册或登录(支持 Google/机构登录)。
2. 右上角点用户名 → **Account settings**。
3. 找到 **API Key Management** 区块 → 点 **Create an API Key**。
4. 复制生成的一长串 key,填进 `NCBI_API_KEY=`。
- 量特别大想突破 10/秒:免费发邮件到 **eutilities@ncbi.nlm.nih.gov**,附上你的工作流描述、
  示例请求、大致量级,申请增强 key。

### 3. `S2_API_KEY`（免费·建议·表单提交,可能等几天）
Semantic Scholar 匿名池是全球用户共享的(100 次/5 分钟),自己一台服务器很容易撞满。
1. 打开 https://www.semanticscholar.org/product/api 。
2. 点 **Request an API Key**(申请表)。
3. 填姓名、邮箱、用途(写"academic literature search service for research writing"即可)。
4. 审核通过后 key 会**发到你邮箱**(通常几天内)。收到后填进 `S2_API_KEY=`。

### 4. `OPENALEX_API_KEY`（用量计费·可选·每天 $1 免费额度）
OpenAlex 2026-02 起要求 key。每个 key **每天送 $1 额度**,纯元数据检索(list 约 $0.0001/次)
通常一天用不到 $1,相当于免费;超了才计费。
1. 打开 https://openalex.org/ ,注册账号。
2. 在账户/开发者页面获取 API key。
3. 填进 `OPENALEX_API_KEY=`。留空则走每日免费额度、不带 key(量小也够用)。

### 5. `CROSSREF_PLUS_TOKEN`（付费·可选·先别买）
Crossref 免费"礼貌池"我们已经默认在用(靠联系邮箱),一般够。只有当公共池在高峰仍不稳、
你需要**独立服务器池 + SLA 保障**时才考虑付费的 Metadata Plus。
- 最小档 **$550/年**(按机构年收入/支出分档:<$50万=$550,$50万–100万=$2200…)。
- 流程:https://www.crossref.org/services/metadata-retrieval/metadata-plus/ 联系 Crossref
  → 签服务协议 → 他们发一个 token → 填进 `CROSSREF_PLUS_TOKEN=`。

---

## 填在哪、怎么生效

所有 key 只填一个文件:服务器上的 `deploy/.env`(已在 .gitignore,不会进仓库)。

```bash
cd /root/sci-agent
cp -n deploy/.env.example deploy/.env      # 首次
vim deploy/.env                            # 填 SCI_CONTACT_EMAIL(必填) + NCBI_API_KEY / S2_API_KEY(建议)
bash deploy/scripts/redeploy-skills.sh     # 一键:重建镜像 + 重渲染 compose + 重建容器
```

`deploy/.env` 里对应几行(留空的就是走免费匿名档,不影响功能):
```
SCI_CONTACT_EMAIL=你的真实邮箱@example.com
NCBI_API_KEY=
S2_API_KEY=
OPENALEX_API_KEY=
CROSSREF_PLUS_TOKEN=
```

**换服务器时**:只需把这个 `deploy/.env` 文件拷到新机器,所有用户容器自动继承,无需逐个 export、无需改脚本。

## 建议节奏
1. **先做免费的**:填 `SCI_CONTACT_EMAIL` + `NCBI_API_KEY` + `S2_API_KEY`,跑一两周看 429 是否消失。
2. **仍不稳再花钱**:只上 `CROSSREF_PLUS_TOKEN`($550/年),通常足够。

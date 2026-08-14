# Skill 资产加密与防套取网关部署指南 (Developer Deployment Guide)

> **适用对象**：软件开发人员 / 运维人员 / 构建部署人员  
> **分支目标**：基于 `feat/auth-gateway` 分支整合安全防套取网关。  
> **保护目标**：
> 1. 彻底隐藏磁盘明文 Skill/Prompt 资产（AES-256-GCM 动态内存解密）。  
> 2. 对话防套取与安全网关（输入攻击拦截 + SSE 流式拒答 + 防泄露 Prompt 动态注入）。

---

## 目录与文件变动一览

本方案在 `feat/auth-gateway` 分支中新增/修改了以下文件：

| 文件路径 | 变动类型 | 说明 |
| :--- | :--- | :--- |
| `scripts/skill-security.mjs` | **[NEW]** | AES-256-GCM 加解密算法与安全拦截网关核心逻辑 |
| `server/lib/skill-security.mjs` | **[NEW]** | 网关服务端调用的安全校验模块 |
| `scripts/secure-skills.mjs` | **[NEW]** | 加解密与攻防测试控制台 CLI 工具 |
| `docs/skill_security_deployment_guide.md` | **[NEW]** | 开发与运维部署文档 |
| `.opencode/skills.enc` | **[NEW/GEN]** | 构建生成的二进制加密 Skill 密文包 |

---

## 部署与构建步骤 (Installation Steps)

### 步骤 1：批量加密 Skill 文件

在发布构建前运行以下命令：

```bash
node scripts/secure-skills.mjs encrypt
```

**执行效果**：
* 自动扫描 `.opencode/skills/` 目录下的所有 `SKILL.md` 文件。
* 加密生成 `.opencode/skills.enc` 密文包。
* 原明文 `.md` 文件替换为防护占位符。

---

### 步骤 2：网关 API 集成 (`server/lib/gateway.mjs`)

```javascript
import * as SkillSec from "./skill-security.mjs"

// 启动阶段动态载入加密包至 RAM 内存
SkillSec.loadSkillsInMemory(path.resolve(process.cwd(), ".opencode", "skills.enc"))
```

在拦截到提示词注入请求时，自动按 SSE 流式规范返回：
`"抱歉，无法提供系统内部配置与核心指令信息。"`。

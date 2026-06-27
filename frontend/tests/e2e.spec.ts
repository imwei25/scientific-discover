import { test, expect, Page } from "@playwright/test";
import { readFileSync } from "fs";

// SSE 响应体构造器
function sse(...events: { event: string; data: unknown }[]): string {
  return events.map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`).join("");
}

// 统一 mock 后端: 健康检查、期刊列表; /api/run 与 /api/analyze 由各用例单独覆盖。
async function mockBase(page: Page) {
  await page.route("**/api/health", (r) =>
    r.fulfill({ json: { status: "ok", provider: "openai", model: "deepseek-chat", mock: true } }),
  );
  await page.route("**/api/journals", (r) =>
    r.fulfill({
      json: {
        journals: [
          { id: "general_en", name: "通用学术论文（英文 IMRaD）", summary: "标准 IMRaD 结构。" },
          { id: "nature", name: "Nature 系列", summary: "结构化、字数严格。" },
        ],
      },
    }),
  );
  await page.route("**/api/usage", (r) => r.fulfill({ json: { available: false } }));
}

test("AI免责声明可显示并关闭", async ({ page }) => {
  await mockBase(page);
  await page.goto("/");
  await expect(page.getByTestId("disclaimer")).toContainText("人工核对");
  await page.getByTestId("disclaimer-close").click();
  await expect(page.getByTestId("disclaimer")).toHaveCount(0);
});

test("侧栏显示账户余额", async ({ page }) => {
  await mockBase(page);
  await page.route("**/api/usage", (r) =>
    r.fulfill({ json: { available: true, provider: "DeepSeek", currency: "CNY", balance: "1.50" } }),
  );
  await page.goto("/");
  await expect(page.getByTestId("balance")).toContainText("余额 ¥1.50");
});

test("首页加载并展示 hero + 侧栏入口", async ({ page }) => {
  await mockBase(page);
  await page.goto("/");
  await expect(page.getByTestId("brand")).toBeVisible();
  // 新首页是编辑级 hero 形态：CTA + 侧栏 4 个入口
  await expect(page.getByTestId("home-cta")).toBeVisible();
  await expect(page.getByTestId("nav-idea")).toBeVisible();
  await expect(page.getByTestId("nav-plan")).toBeVisible();
  await expect(page.getByTestId("nav-analyze")).toBeVisible();
  await expect(page.getByTestId("nav-format")).toBeVisible();
  await expect(page.getByTestId("status")).toContainText("已就绪");
});

test("首页 CTA 点击进入找选题", async ({ page }) => {
  await mockBase(page);
  await page.goto("/");
  await page.getByTestId("home-cta").click();
  await expect(page.getByTestId("input-field")).toBeVisible();
});

test("连接重试: 服务稍后就绪后自动显示已就绪", async ({ page }) => {
  let n = 0;
  await page.route("**/api/health", (r) => {
    n += 1;
    if (n === 1) return r.abort(); // 首次模拟服务未就绪
    return r.fulfill({
      json: { status: "ok", provider: "openai", model: "deepseek-chat", mock: false, configured: true },
    });
  });
  await page.goto("/");
  // 首次健康检查失败, 轮询重试后应自动恢复为“已就绪”
  await expect(page.getByTestId("status")).toContainText("已就绪", { timeout: 8000 });
  expect(n).toBeGreaterThan(1);
});

test("找选题: 检索PubMed并返回带链接的结果", async ({ page }) => {
  await mockBase(page);
  await page.route("**/api/idea", (r) =>
    r.fulfill({
      contentType: "text/event-stream",
      body: sse(
        { event: "status", data: { message: "正在检索 PubMed…" } },
        {
          event: "references",
          data: {
            items: [
              {
                pmid: "12345",
                title: "PD-1 blockade in TNBC",
                first_author: "Smith J",
                journal: "Nature Medicine",
                year: "2023",
                url: "https://pubmed.ncbi.nlm.nih.gov/12345/",
              },
            ],
          },
        },
        { event: "delta", data: { text: "## 一、研究现状\n见 [Smith et al., 2023](https://pubmed.ncbi.nlm.nih.gov/12345/)。" } },
        { event: "verify", data: { total: 1, verified: 1, unverified: [] } },
        { event: "done", data: {} },
      ),
    }),
  );
  await page.goto("/");
  await page.getByTestId("nav-idea").click();
  await page.getByTestId("input-field").fill("PD-1 抑制剂 三阴性乳腺癌");
  await page.getByTestId("run-btn").click();
  // 文献列表出现且链接指向 PubMed
  await expect(page.getByTestId("refs")).toContainText("Smith J");
  const refLink = page.getByTestId("refs").getByRole("link").first();
  await expect(refLink).toHaveAttribute("href", "https://pubmed.ncbi.nlm.nih.gov/12345/");
  // 正文里的引用渲染成可点击链接
  const inlineLink = page.getByTestId("result-text").getByRole("link", { name: /Smith et al., 2023/ });
  await expect(inlineLink).toHaveAttribute("href", "https://pubmed.ncbi.nlm.nih.gov/12345/");
  // 引用核验通过提示
  await expect(page.getByTestId("verify")).toContainText("引用核验");
});

test("找选题: 显示在研临床试验(ClinicalTrials旁路)并渲染空白矩阵表格", async ({ page }) => {
  await mockBase(page);
  await page.route("**/api/idea", (r) =>
    r.fulfill({
      contentType: "text/event-stream",
      body: sse(
        {
          event: "references",
          data: { items: [{ pmid: "1", title: "Paper A", first_author: "Doe A", journal: "J", year: "2024", url: "https://pubmed.ncbi.nlm.nih.gov/1/", source: "openalex" }] },
        },
        {
          event: "trials",
          data: {
            items: [
              { nct_id: "NCT01234567", title: "A recruiting trial", status: "RECRUITING", phase: "Phase 3", conditions: "TNBC", summary: "s", year: "2025", url: "https://clinicaltrials.gov/study/NCT01234567" },
            ],
          },
        },
        // 空白矩阵: GFM 表格, 需 remark-gfm 才能渲染成 <table>
        { event: "delta", data: { text: "## 二、研究空白矩阵\n\n| 角度 | 证据 |\n| --- | --- |\n| 机制 | 充分 |\n| 耐药 | 空白 |\n" } },
        { event: "done", data: {} },
      ),
    }),
  );
  await page.goto("/");
  await page.getByTestId("nav-idea").click();
  await page.getByTestId("input-field").fill("PD-1 三阴性乳腺癌");
  await page.getByTestId("run-btn").click();
  // OpenAlex 徽标
  await expect(page.getByTestId("refs")).toContainText("OpenAlex");
  // 在研试验旁路面板
  await expect(page.getByTestId("trials")).toContainText("NCT01234567");
  await expect(page.getByTestId("trials")).toContainText("RECRUITING");
  await expect(page.getByTestId("trials").getByRole("link").first()).toHaveAttribute(
    "href",
    "https://clinicaltrials.gov/study/NCT01234567",
  );
  // 空白矩阵渲染为真正的表格(而非原始 | 文本)
  await expect(page.getByTestId("result-text").locator("table")).toBeVisible();
  await expect(page.getByTestId("result-text").locator("th").first()).toHaveText("角度");
  await expect(page.getByTestId("result-text").locator("td")).toContainText(["机制", "充分", "耐药", "空白"]);
});

test("找选题: 被引徽标/排序 + 证据表展示与导出 + 过滤器UI", async ({ page }) => {
  await mockBase(page);
  await page.route("**/api/idea", (r) =>
    r.fulfill({
      contentType: "text/event-stream",
      body: sse(
        {
          event: "references",
          data: {
            items: [
              { pmid: "1", title: "Low cited recent", first_author: "A", journal: "J", year: "2025", url: "https://pubmed.ncbi.nlm.nih.gov/1/", source: "pubmed", cited_by_count: 3 },
              { pmid: "2", title: "High cited old", first_author: "B", journal: "J", year: "2010", url: "https://pubmed.ncbi.nlm.nih.gov/2/", source: "openalex", cited_by_count: 999 },
            ],
          },
        },
        {
          event: "evidence",
          data: {
            items: [
              { index: 1, first_author: "A", year: "2025", title: "Low cited recent", journal: "J", url: "https://pubmed.ncbi.nlm.nih.gov/1/", source: "pubmed", cited_by_count: 3, pop: "成人", design: "RCT", finding: "有效", gap: "样本小" },
            ],
          },
        },
        { event: "delta", data: { text: "## 结果\n见正文。" } },
        { event: "done", data: {} },
      ),
    }),
  );
  await page.goto("/");
  await page.getByTestId("nav-idea").click();
  // 过滤器 UI 存在
  await expect(page.getByTestId("filter-year")).toBeVisible();
  await expect(page.getByTestId("type-rct")).toBeVisible();
  await page.getByTestId("input-field").fill("某方向");
  await page.getByTestId("run-btn").click();
  // 被引徽标
  await expect(page.getByTestId("refs")).toContainText("被引 999");
  // 默认相关性排序: 第一篇是 "Low cited recent"
  const firstRel = page.getByTestId("refs").locator("li").first();
  await expect(firstRel).toContainText("Low cited recent");
  // 切换"被引最多": 第一篇变为高被引
  await page.getByTestId("ref-sort").selectOption("cited");
  await expect(page.getByTestId("refs").locator("li").first()).toContainText("High cited old");
  // 证据表(默认折叠)展开后展示
  await page.getByTestId("evidence").locator("summary").click();
  await expect(page.getByTestId("evidence")).toContainText("RCT");
  await expect(page.getByTestId("evidence").locator("table")).toBeVisible();
  // 导出 CSV 触发下载
  const dl = page.waitForEvent("download");
  await page.getByTestId("export-evidence-btn").click();
  const d = await dl;
  expect(d.suggestedFilename()).toMatch(/证据表.*\.csv/);
});

test("找选题: 追问追加问答 + 按意见修改报告", async ({ page }) => {
  await mockBase(page);
  await page.route("**/api/idea", (r) =>
    r.fulfill({
      contentType: "text/event-stream",
      body: sse(
        { event: "references", data: { items: [{ pmid: "1", title: "P1", first_author: "A", journal: "J", year: "2024", url: "https://pubmed.ncbi.nlm.nih.gov/1/", source: "pubmed" }] } },
        { event: "delta", data: { text: "## 原始报告\n初始内容。" } },
        { event: "verify", data: { total: 0, verified: 0, unverified: [] } },
        { event: "done", data: {} },
      ),
    }),
  );
  // followup 按 mode 分支返回不同内容
  await page.route("**/api/idea-followup", async (r) => {
    const body = JSON.parse(r.request().postData() || "{}");
    const mode = body?.inputs?.mode;
    const text = mode === "revise" ? "## 修改后的报告\n已按意见修订。" : "这是针对追问的回答。";
    r.fulfill({
      contentType: "text/event-stream",
      body: sse(
        { event: "delta", data: { text } },
        { event: "verify", data: { total: 0, verified: 0, unverified: [] } },
        { event: "done", data: {} },
      ),
    });
  });
  await page.goto("/");
  await page.getByTestId("nav-idea").click();
  await page.getByTestId("input-field").fill("某方向");
  await page.getByTestId("run-btn").click();
  await expect(page.getByTestId("result-text")).toContainText("原始报告");
  // 追问: 追加问答, 不改报告
  await page.getByTestId("followup-input").fill("第1篇的结论是什么？");
  await page.getByTestId("ask-btn").click();
  await expect(page.getByTestId("qa-list")).toContainText("第1篇的结论是什么？");
  await expect(page.getByTestId("qa-list")).toContainText("这是针对追问的回答");
  await expect(page.getByTestId("result-text")).toContainText("原始报告"); // 报告未被改
  // 修改: 替换报告
  await page.getByTestId("followup-input").fill("精简为3个选题");
  await page.getByTestId("revise-btn").click();
  await expect(page.getByTestId("result-text")).toContainText("修改后的报告");
});

test("实验规划: 生成统计分析计划(SAP)并提供 Word 导出", async ({ page }) => {
  await mockBase(page);
  await page.route("**/api/run", (r) =>
    r.fulfill({
      contentType: "text/event-stream",
      body: sse(
        { event: "delta", data: { text: "## 分析数据集\nITT 分析集纳入所有随机化受试者；缺失数据用多重插补做敏感性分析。" } },
        { event: "done", data: {} },
      ),
    }),
  );
  await page.goto("/");
  await page.getByTestId("nav-plan").click();
  await page.getByTestId("input-idea").fill("二甲双胍对NAFLD肝纤维化的随机对照试验");
  await page.getByTestId("gen-sap-btn").click();
  await expect(page.getByTestId("sap-title")).toBeVisible();
  await expect(page.getByTestId("sap-panel")).toContainText("ITT 分析集");
  // SAP 面板提供 Word 导出
  await expect(page.getByTestId("sap-panel").getByTestId("export-docx-btn")).toBeVisible();
});

test("回复审稿: 拆解意见并生成逐条回复", async ({ page }) => {
  await mockBase(page);
  await page.route("**/api/rebuttal", (r) =>
    r.fulfill({
      contentType: "text/event-stream",
      body: sse(
        { event: "status", data: { message: "正在拆解审稿意见…" } },
        {
          event: "comments",
          data: {
            items: [
              { reviewer: "R1", index: 1, comment: "样本量是否充分？", type: "补分析" },
              { reviewer: "R2", index: 1, comment: "方法描述不清。", type: "方法" },
            ],
          },
        },
        { event: "delta", data: { text: "**审稿人1 · 意见1**：样本量？\n\n回应：已补充功效分析。" } },
        { event: "done", data: {} },
      ),
    }),
  );
  await page.goto("/");
  await page.getByTestId("nav-rebuttal").click();
  await page.getByTestId("input-reviews").fill("Reviewer 1: sample size? Reviewer 2: methods unclear.");
  await page.getByTestId("run-btn").click();
  // 意见被拆解为清单
  await expect(page.getByTestId("comments")).toContainText("样本量是否充分");
  await expect(page.getByTestId("comments")).toContainText("补分析");
  // 逐条回复正文
  await expect(page.getByTestId("result-text")).toContainText("已补充功效分析");
  // 导出按钮(MD + Word)
  await expect(page.getByTestId("export-md-btn")).toBeVisible();
  await expect(page.getByTestId("download-docx-btn")).toBeVisible();
});

test("侧栏显示本次 token 用量", async ({ page }) => {
  await mockBase(page);
  await page.route("**/api/usage", (r) =>
    r.fulfill({ json: { available: true, provider: "DeepSeek", currency: "CNY", balance: "1.50", tokens: { total_tokens: 12345, requests: 4 } } }),
  );
  await page.goto("/");
  await expect(page.getByTestId("token-usage")).toContainText("12,345");
  await expect(page.getByTestId("token-usage")).toContainText("4 次调用");
});

test("找选题: 取消所有论文源时禁用调研并提示", async ({ page }) => {
  await mockBase(page);
  await page.goto("/");
  await page.getByTestId("nav-idea").click();
  await page.getByTestId("input-field").fill("某方向");
  // 默认四源全开, 按钮可用
  await expect(page.getByTestId("run-btn")).toBeEnabled();
  // 取消三个论文源
  await page.getByTestId("source-pubmed").uncheck();
  await page.getByTestId("source-europepmc").uncheck();
  await page.getByTestId("source-openalex").uncheck();
  await expect(page.getByTestId("source-warn")).toBeVisible();
  await expect(page.getByTestId("run-btn")).toBeDisabled();
  // 勾回一个论文源后恢复可用
  await page.getByTestId("source-pubmed").check();
  await expect(page.getByTestId("run-btn")).toBeEnabled();
});

test("找选题: 检测到幻觉引用时给出警告", async ({ page }) => {
  await mockBase(page);
  await page.route("**/api/idea", (r) =>
    r.fulfill({
      contentType: "text/event-stream",
      body: sse(
        { event: "references", data: { items: [{ pmid: "111", title: "T", first_author: "A", journal: "J", year: "2020", url: "https://pubmed.ncbi.nlm.nih.gov/111/" }] } },
        { event: "delta", data: { text: "见 [假, 2099](https://pubmed.ncbi.nlm.nih.gov/999999/)。" } },
        { event: "verify", data: { total: 1, verified: 0, unverified: ["999999"] } },
        { event: "done", data: {} },
      ),
    }),
  );
  await page.goto("/");
  await page.getByTestId("nav-idea").click();
  await page.getByTestId("input-field").fill("x");
  await page.getByTestId("run-btn").click();
  await expect(page.getByTestId("verify")).toContainText("可能不准确");
  await expect(page.getByTestId("verify").getByRole("link", { name: /999999/ })).toBeVisible();
});

test("串联: 找选题结果可一键送到实验规划", async ({ page }) => {
  await mockBase(page);
  await page.route("**/api/idea", (r) =>
    r.fulfill({
      contentType: "text/event-stream",
      body: sse(
        { event: "delta", data: { text: "候选选题：PD-1 在 TNBC 的疗效。" } },
        { event: "done", data: {} },
      ),
    }),
  );
  await page.goto("/");
  await page.getByTestId("nav-idea").click();
  await page.getByTestId("input-field").fill("三阴性乳腺癌 免疫治疗");
  await page.getByTestId("run-btn").click();
  await expect(page.getByTestId("result-text")).toContainText("候选选题");
  await page.getByTestId("send-to-plan-btn").click();
  // 已切到实验规划, 且选题被预填
  await expect(page.getByTestId("input-idea")).toHaveValue(/候选选题：PD-1 在 TNBC 的疗效/);
});

test("串联: 数据分析结论可一键送到期刊排版", async ({ page }) => {
  await mockBase(page);
  await page.route("**/api/analyze", (r) =>
    r.fulfill({
      contentType: "text/event-stream",
      body: sse(
        { event: "delta", data: { text: "## 结论\n两组差异显著（p=0.01）。" } },
        { event: "done", data: {} },
      ),
    }),
  );
  await page.goto("/");
  await page.getByTestId("nav-analyze").click();
  await page.getByTestId("input-file").setInputFiles({
    name: "data.csv", mimeType: "text/csv", buffer: Buffer.from("g,v\nA,1\nB,2\n"),
  });
  await page.getByTestId("run-btn").click();
  await expect(page.getByTestId("result-text")).toContainText("两组差异显著");
  await page.getByTestId("send-to-format-btn").click();
  await expect(page.getByTestId("input-manuscript")).toHaveValue(/两组差异显著/);
});

test("历史记录: 生成后可在历史中恢复", async ({ page }) => {
  await mockBase(page);
  await page.route("**/api/run", (r) =>
    r.fulfill({
      contentType: "text/event-stream",
      body: sse({ event: "delta", data: { text: "实验方案内容XYZ" } }, { event: "done", data: {} }),
    }),
  );
  await page.goto("/");
  await page.getByTestId("nav-plan").click();
  await page.getByTestId("input-idea").fill("研究某药对血压影响");
  await page.getByTestId("run-btn").click();
  await expect(page.getByTestId("result-text")).toContainText("实验方案内容XYZ");
  // 打开历史，应有刚才的记录
  await page.getByTestId("nav-history").click();
  await expect(page.getByTestId("history-item").first()).toContainText("研究某药对血压影响");
  // 恢复到实验规划
  await page.getByTestId("restore-btn").first().click();
  await expect(page.getByTestId("input-idea")).toHaveValue("研究某药对血压影响");
  await expect(page.getByTestId("result-text")).toContainText("实验方案内容XYZ");
});

test("持久化: 切换模块后输入仍保留", async ({ page }) => {
  await mockBase(page);
  await page.goto("/");
  await page.getByTestId("nav-plan").click();
  await page.getByTestId("input-idea").fill("研究二甲双胍对肝纤维化的作用");
  // 切到另一个模块再切回
  await page.getByTestId("nav-format").click();
  await page.getByTestId("nav-plan").click();
  await expect(page.getByTestId("input-idea")).toHaveValue("研究二甲双胍对肝纤维化的作用");
  // 清空按钮可重置
  await page.getByTestId("reset-btn").click();
  await expect(page.getByTestId("input-idea")).toHaveValue("");
});

test("找选题: 必填项为空时按钮禁用", async ({ page }) => {
  await mockBase(page);
  await page.goto("/");
  await page.getByTestId("nav-idea").click();
  await expect(page.getByTestId("run-btn")).toBeDisabled();
  await page.getByTestId("input-field").fill("x");
  await expect(page.getByTestId("run-btn")).toBeEnabled();
});

test("实验规划: 样本量计算器", async ({ page }) => {
  await mockBase(page);
  await page.route("**/api/sample-size", (r) =>
    r.fulfill({ json: { ok: true, per_group: 64, total: 128, note: "两独立样本 t 检验，d=0.5" } }),
  );
  await page.goto("/");
  await page.getByTestId("nav-plan").click();
  await page.getByTestId("ss-calc").click(); // 展开
  await page.getByTestId("ss-calc-btn").click();
  await expect(page.getByTestId("ss-result")).toContainText("每组 64 例，总计 128 例");
});

test("实验规划: 返回计划文本", async ({ page }) => {
  await mockBase(page);
  await page.route("**/api/run", (r) =>
    r.fulfill({
      contentType: "text/event-stream",
      body: sse(
        { event: "delta", data: { text: "研究目标与假设：…" } },
        { event: "done", data: {} },
      ),
    }),
  );
  await page.goto("/");
  await page.getByTestId("nav-plan").click();
  await page.getByTestId("input-idea").fill("研究A对B的影响");
  await page.getByTestId("run-btn").click();
  await expect(page.getByTestId("result-text")).toContainText("研究目标与假设");
  // 完成后出现导出按钮
  await expect(page.getByTestId("export-md-btn")).toBeVisible();
});

test("数据分析: AI写代码执行并输出结论", async ({ page }) => {
  await mockBase(page);
  const png =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
  await page.route("**/api/analyze", (r) =>
    r.fulfill({
      contentType: "text/event-stream",
      body: sse(
        { event: "status", data: { message: "正在生成分析代码…" } },
        { event: "code", data: { code: "print('t检验 p=0.01')" } },
        { event: "charts", data: { items: [{ png, data: png, ext: "svg" }] } },
        { event: "output", data: { text: "t检验 p=0.01" } },
        { event: "delta", data: { text: "核心发现：A组显著高于B组（p=0.01）。" } },
        { event: "done", data: {} },
      ),
    }),
  );
  await page.goto("/");
  await page.getByTestId("nav-analyze").click();
  // 选择导出格式与配色(随请求发往后端)
  await page.getByTestId("chart-format").selectOption("svg");
  await page.getByTestId("chart-palette").selectOption("nature");
  await page.getByTestId("input-file").setInputFiles({
    name: "data.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("group,value\nA,5\nB,3\n"),
  });
  // 文件名以紧凑 chip 形式显示
  await expect(page.getByTestId("input-file-info")).toContainText("data.csv");
  await page.getByTestId("input-question").fill("A组和B组是否有差异");
  await page.getByTestId("run-btn").click();
  await expect(page.getByTestId("code-block")).toContainText("t检验");
  await expect(page.getByTestId("chart-0")).toBeVisible();
  await expect(page.getByTestId("output-block")).toContainText("p=0.01");
  await expect(page.getByTestId("result-text")).toContainText("A组显著高于B组");
  // 逐图下载按钮(按所选格式)
  const dl = page.waitForEvent("download");
  await page.getByTestId("chart-download-0").click();
  expect((await dl).suggestedFilename()).toMatch(/\.svg$/);
  // 完成后可导出完整报告
  await expect(page.getByTestId("export-report-btn")).toBeVisible();
});

test("历史记录: 流式出错(已有部分输出)不写入历史", async ({ page }) => {
  await mockBase(page);
  // 先产出部分内容, 再报错。修复前会把这段残缺内容当成功结果存进历史。
  await page.route("**/api/run", (r) =>
    r.fulfill({
      contentType: "text/event-stream",
      body: sse(
        { event: "delta", data: { text: "残缺的部分方案……" } },
        { event: "error", data: { message: "上游返回 500: 中断" } },
      ),
    }),
  );
  await page.goto("/");
  await page.getByTestId("nav-plan").click();
  await page.getByTestId("input-idea").fill("会出错的课题");
  await page.getByTestId("run-btn").click();
  await expect(page.getByTestId("result-error")).toContainText("中断");
  // 历史里不应出现这条失败的记录
  await page.getByTestId("nav-history").click();
  await expect(page.getByText("会出错的课题")).toHaveCount(0);
});

test("上传: 超大文件被前端拒绝并提示", async ({ page }) => {
  await mockBase(page);
  await page.goto("/");
  await page.getByTestId("nav-analyze").click();
  // 选择一个 31MB 的文件(超过 30MB 上限)
  await page.getByTestId("input-file").setInputFiles({
    name: "huge.csv",
    mimeType: "text/csv",
    buffer: Buffer.alloc(31 * 1024 * 1024, 97),
  });
  // 显示“文件过大”错误, 且不进入“已选择”状态(未把文件交给上层/后端)。
  await expect(page.getByTestId("input-file-error")).toContainText("文件过大");
  await expect(page.getByTestId("input-file-info")).toHaveCount(0);
});

test("导出: 结果可下载为 Markdown 且内容正确", async ({ page }) => {
  await mockBase(page);
  await page.route("**/api/run", (r) =>
    r.fulfill({
      contentType: "text/event-stream",
      body: sse(
        { event: "delta", data: { text: "# 实验方案\n这是要导出的方案正文。" } },
        { event: "done", data: {} },
      ),
    }),
  );
  await page.goto("/");
  await page.getByTestId("nav-plan").click();
  await page.getByTestId("input-idea").fill("导出测试");
  await page.getByTestId("run-btn").click();
  await expect(page.getByTestId("result-text")).toContainText("实验方案");
  // 实际触发并捕获下载, 验证文件名与内容(走 downloadText 真实路径)。
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId("export-md-btn").click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/实验计划-\d{8}-\d{4}\.md$/);
  const path = await download.path();
  const content = readFileSync(path, "utf-8");
  expect(content).toContain("这是要导出的方案正文");
});

test("历史记录: localStorage 配额不足时保留最新记录(淘汰旧的)", async ({ page }) => {
  await mockBase(page);
  await page.route("**/api/run", (r) =>
    r.fulfill({
      contentType: "text/event-stream",
      body: sse({ event: "delta", data: { text: "最新方案ABC" } }, { event: "done", data: {} }),
    }),
  );
  // 预置一批较大的旧历史, 并对 ra:history 施加配额上限以触发淘汰逻辑。
  await page.addInitScript(() => {
    const real = Storage.prototype.setItem;
    const seed: unknown[] = [];
    for (let i = 0; i < 8; i++) {
      seed.push({ id: "old" + i, module: "plan", icon: "🗺️", title: "旧记录" + i, time: i, data: { pad: "x".repeat(400) } });
    }
    real.call(localStorage, "ra:history", JSON.stringify(seed));
    Storage.prototype.setItem = function (k: string, v: string) {
      if (k === "ra:history" && String(v).length > 1200) {
        throw new DOMException("quota", "QuotaExceededError");
      }
      return real.call(this, k, v);
    };
  });
  await page.goto("/");
  await page.getByTestId("nav-plan").click();
  await page.getByTestId("input-idea").fill("最新研究课题");
  await page.getByTestId("run-btn").click();
  await expect(page.getByTestId("result-text")).toContainText("最新方案ABC");
  // 打开历史: 最新记录必须在(没被静默丢弃), 且发生了淘汰(条数 < 9)。
  await page.getByTestId("nav-history").click();
  await expect(page.getByTestId("history-item").first()).toContainText("最新研究课题");
  const count = await page.getByTestId("history-item").count();
  expect(count).toBeGreaterThan(0);
  expect(count).toBeLessThan(9);
});

test("期刊排版: 重排并出现下载按钮", async ({ page }) => {
  await mockBase(page);
  await page.route("**/api/run", (r) =>
    r.fulfill({
      contentType: "text/event-stream",
      body: sse(
        { event: "delta", data: { text: "# Introduction\n重排后的稿件正文。" } },
        { event: "done", data: {} },
      ),
    }),
  );
  await page.goto("/");
  await page.getByTestId("nav-format").click();
  await expect(page.getByTestId("input-journal")).toBeVisible();
  await page.getByTestId("input-manuscript").fill("这是我的论文草稿。");
  await page.getByTestId("run-btn").click();
  await expect(page.getByTestId("result-text")).toContainText("重排后的稿件正文");
  await expect(page.getByTestId("download-btn")).toBeVisible();
});

test("期刊排版: 参考文献按CSL格式化", async ({ page }) => {
  await mockBase(page);
  await page.route("**/api/format-refs", (r) =>
    r.fulfill({
      json: {
        ok: true,
        style: "vancouver",
        formatted: ["1. Cortes J, et al. Title. Lancet. 2020;396:1817–28."],
      },
    }),
  );
  await page.goto("/");
  await page.getByTestId("nav-format").click();
  await page.getByTestId("input-refs").fill("Cortes J et al. Title. Lancet 2020.");
  await page.getByTestId("format-refs-btn").click();
  await expect(page.getByTestId("fmt-refs")).toContainText("Lancet. 2020;396:1817");
  await expect(page.getByTestId("copy-refs-btn")).toBeVisible();
});

test("期刊排版: 上传Word自动填入稿件", async ({ page }) => {
  await mockBase(page);
  await page.route("**/api/extract", (r) =>
    r.fulfill({ json: { ok: true, text: "从Word导入的论文正文内容。", kind: "docx", truncated: false } }),
  );
  await page.goto("/");
  await page.getByTestId("nav-format").click();
  await page.getByTestId("upload-manuscript").setInputFiles({
    name: "paper.docx",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    buffer: Buffer.from("fake docx bytes"),
  });
  await expect(page.getByTestId("input-manuscript")).toHaveValue(/从Word导入的论文正文内容/);
  await expect(page.getByTestId("upload-manuscript-info")).toContainText("已导入");
});

test("复制: 局域网 http(非安全上下文)下复制按钮仍可用", async ({ page }) => {
  await mockBase(page);
  // 模拟通过局域网 IP 的 http 访问: 非安全上下文且 navigator.clipboard 不可用。
  await page.addInitScript(() => {
    Object.defineProperty(window, "isSecureContext", { value: false, configurable: true });
    try {
      Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    } catch {
      /* 某些环境 clipboard 不可重定义, 忽略 */
    }
  });
  await page.route("**/api/run", (r) =>
    r.fulfill({
      contentType: "text/event-stream",
      body: sse(
        { event: "delta", data: { text: "这是可复制的实验方案正文。" } },
        { event: "done", data: {} },
      ),
    }),
  );
  await page.goto("/");
  await page.getByTestId("nav-plan").click();
  await page.getByTestId("input-idea").fill("测试复制");
  await page.getByTestId("run-btn").click();
  await expect(page.getByTestId("result-text")).toContainText("可复制的实验方案");
  // 点击复制: 走 execCommand 兜底, 应显示“已复制”而非“复制失败”, 且不抛错。
  await page.getByTestId("copy-btn").click();
  await expect(page.getByTestId("copy-btn")).toHaveText("已复制");
});

test("错误处理: 后端返回 error 事件时友好提示", async ({ page }) => {
  await mockBase(page);
  await page.route("**/api/run", (r) =>
    r.fulfill({
      contentType: "text/event-stream",
      body: sse({ event: "error", data: { message: "上游返回 402: 余额不足" } }),
    }),
  );
  await page.goto("/");
  await page.getByTestId("nav-plan").click();
  await page.getByTestId("input-idea").fill("测试");
  await page.getByTestId("run-btn").click();
  await expect(page.getByTestId("result-error")).toContainText("余额不足");
});

import { test, expect, Page } from "@playwright/test";

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

test("首页加载并显示四大功能", async ({ page }) => {
  await mockBase(page);
  await page.goto("/");
  await expect(page.getByTestId("brand")).toBeVisible();
  await expect(page.getByTestId("card-idea")).toBeVisible();
  await expect(page.getByTestId("card-plan")).toBeVisible();
  await expect(page.getByTestId("card-analyze")).toBeVisible();
  await expect(page.getByTestId("card-format")).toBeVisible();
  await expect(page.getByTestId("status")).toContainText("已就绪");
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
        { event: "charts", data: { items: [png] } },
        { event: "output", data: { text: "t检验 p=0.01" } },
        { event: "delta", data: { text: "核心发现：A组显著高于B组（p=0.01）。" } },
        { event: "done", data: {} },
      ),
    }),
  );
  await page.goto("/");
  await page.getByTestId("nav-analyze").click();
  await page.getByTestId("input-file").setInputFiles({
    name: "data.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("group,value\nA,5\nB,3\n"),
  });
  await page.getByTestId("input-question").fill("A组和B组是否有差异");
  await page.getByTestId("run-btn").click();
  await expect(page.getByTestId("code-block")).toContainText("t检验");
  await expect(page.getByTestId("chart-0")).toBeVisible();
  await expect(page.getByTestId("output-block")).toContainText("p=0.01");
  await expect(page.getByTestId("result-text")).toContainText("A组显著高于B组");
  // 完成后可导出完整报告
  await expect(page.getByTestId("export-report-btn")).toBeVisible();
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

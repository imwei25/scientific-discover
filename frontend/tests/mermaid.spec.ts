import { test, expect, Page } from "@playwright/test";

// 写标书会生成 ```mermaid 技术路线图/甘特图, 需在流式撰写过程中即时渲染成图。
// 回归防线: 曾因 Markdown 的 components 每次渲染重建, 导致 <Mermaid> 每个 token 被 remount、
// debounce 计时器反复清零, 流式期间永不渲染(要等流停)。

function sse(...events: { event: string; data: unknown }[]): string {
  return events.map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`).join("");
}

async function mockBase(page: Page) {
  await page.route("**/api/health", (r) =>
    r.fulfill({ json: { status: "ok", provider: "openai", model: "deepseek-chat", mock: true } }),
  );
  await page.route("**/api/journals", (r) => r.fulfill({ json: { journals: [] } }));
  await page.route("**/api/usage", (r) => r.fulfill({ json: { available: false } }));
  await page.route("**/api/projects", (r) => r.fulfill({ json: { projects: [] } }));
  await page.route("**/api/zotero/status", (r) => r.fulfill({ json: { available: false } }));
}

const FLOW = 'flowchart TD\nA["科学问题"]-->B["研究内容"]\nB-->|体外验证|C["关键方法"]\nC-->D["预期产出"]';
const GANTT = 'gantt\ndateFormat YYYY-MM\naxisFormat %Y-%m\nsection 第1年\n文献调研 :y1a, 2027-01, 6M\nsection 第2年\n机制研究 :y2a, 2028-01, 12M';

// 甘特图(按 grant.py 提示词的真实语法)一次性到达时应渲染成图。
test("甘特图渲染成图, 不落到代码兜底", async ({ page }) => {
  await mockBase(page);
  await page.route("**/api/grant", (r) =>
    r.fulfill({ contentType: "text/event-stream", body: sse(
      { event: "outline", data: { items: [{ key: "plan", title: "年度计划", budget: "" }] } },
      { event: "section", data: { key: "plan", title: "年度计划" } },
      { event: "delta", data: { text: "年度计划如下：\n\n```mermaid\n" + GANTT + "\n```\n\n预期成果正文。" } },
      { event: "done", data: {} },
    ) }),
  );
  await page.goto("/");
  await page.getByTestId("nav-grant").click();
  await page.getByTestId("grant-title").fill("测试项目");
  await page.getByTestId("grant-start-btn").click();
  await expect(page.getByTestId("grant-result")).toContainText("预期成果正文");
  await expect(page.locator(".mermaid-figure svg").first()).toBeVisible({ timeout: 5000 });
  await expect(page.locator(".mermaid-fallback")).toHaveCount(0);
});

// 真正分块、带延迟的流: 发完 mermaid 块后持续发尾部文本约 4s,
// 图必须在流仍进行时就渲染, 而不是等 done。
test("流式撰写过程中 mermaid 即时渲染(不必等到 done)", async ({ page }) => {
  await mockBase(page);
  await page.addInitScript((flow) => {
    const origFetch = window.fetch.bind(window);
    // @ts-ignore
    window.fetch = (input, init) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (!url.includes("/api/grant")) return origFetch(input, init);
      const enc = new TextEncoder();
      const ev = (event: string, data: unknown) =>
        enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      const chunks: Uint8Array[] = [
        ev("outline", { items: [{ key: "scheme", title: "研究方案", budget: "" }] }),
        ev("section", { key: "scheme", title: "研究方案" }),
        ev("delta", { text: "技术路线如下：\n\n```mermaid\n" + flow + "\n```\n\n" }),
      ];
      for (let i = 0; i < 40; i++) chunks.push(ev("delta", { text: `可行性论证第${i}句。` }));
      chunks.push(ev("done", {}));
      let i = 0;
      const stream = new ReadableStream({
        pull(controller) {
          return new Promise<void>((resolve) => {
            if (i >= chunks.length) { controller.close(); resolve(); return; }
            const first3 = i < 3; // 含 mermaid 的前 3 块立即发, 之后每 100ms 一块(持续流)
            setTimeout(() => { controller.enqueue(chunks[i++]); resolve(); }, first3 ? 0 : 100);
          });
        },
      });
      return Promise.resolve(new Response(stream, { headers: { "content-type": "text/event-stream" } }));
    };
  }, FLOW);

  await page.goto("/");
  await page.getByTestId("nav-grant").click();
  await page.getByTestId("grant-title").fill("测试项目");
  await page.getByTestId("grant-start-btn").click();
  await expect(page.getByTestId("grant-result")).toContainText("技术路线如下");

  // 图应在流仍进行时渲染
  await expect(page.locator(".mermaid-figure svg").first()).toBeVisible({ timeout: 3000 });
  // 此刻流尚未结束(暂停按钮仍在), 证明是流式过程中渲染, 而非等到 done
  await expect(page.getByTestId("grant-pause-btn")).toBeVisible();
});

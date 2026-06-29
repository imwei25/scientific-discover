import { test, expect, Page } from "@playwright/test";

async function mockBase(page: Page) {
  await page.route("**/api/health", (r) =>
    r.fulfill({ json: { status: "ok", provider: "openai", model: "deepseek-chat", mock: true } }),
  );
  await page.route("**/api/journals", (r) => r.fulfill({ json: { journals: [] } }));
  await page.route("**/api/usage", (r) => r.fulfill({ json: { available: false } }));
}

test("帮助模态: 流程图 ? 按钮打开/三段内容齐全/关闭三路/焦点回归", async ({ page }) => {
  await mockBase(page);
  await page.goto("/");
  await page.getByTestId("nav-checklist").click();
  const help = page.getByTestId("help-btn-flowdiagram");
  await expect(help).toBeVisible();
  await help.click();
  const modal = page.getByTestId("help-modal");
  await expect(modal).toBeVisible();
  await expect(modal).toContainText("何时使用");
  await expect(modal).toContainText("如何使用");
  await expect(modal).toContainText("最简示例");
  await expect(modal).toContainText("1240");
  // 关闭: ESC
  await page.keyboard.press("Escape");
  await expect(modal).toHaveCount(0);
  // 焦点回到触发按钮
  await expect(help).toBeFocused();

  // 关闭: × 按钮
  await help.click();
  await page.getByTestId("help-modal-close").click();
  await expect(modal).toHaveCount(0);

  // 关闭: 点遮罩
  await help.click();
  await page.getByTestId("help-modal-overlay").click({ position: { x: 10, y: 10 } });
  await expect(modal).toHaveCount(0);
});

test("帮助按钮: 6 个静态可见的 ? 按钮在各模块都存在", async ({ page }) => {
  await mockBase(page);
  await page.goto("/");
  await page.getByTestId("nav-idea").click();
  await expect(page.getByTestId("help-btn-pico")).toBeVisible();
  await page.getByTestId("nav-plan").click();
  await expect(page.getByTestId("help-btn-randomize")).toHaveCount(1);
  await page.getByTestId("nav-imrad").click();
  await expect(page.getByTestId("help-btn-keywords")).toBeVisible();
  await expect(page.getByTestId("help-btn-bundle")).toBeVisible();
  await page.getByTestId("nav-checklist").click();
  await expect(page.getByTestId("help-btn-flowdiagram")).toBeVisible();
  await expect(page.getByTestId("help-btn-statcheck")).toBeVisible();
});

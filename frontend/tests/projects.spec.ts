// frontend/tests/projects.spec.ts
import { test, expect, Page } from "@playwright/test";

interface FakeProject {
  id: string;
  name: string;
  created_at: number;
  updated_at: number;
  state: Record<string, string>;
  history: unknown[];
}

/**
 * 启动一个进程内的"假后端": 在 page 上下文之外用 closure 模拟一份内存项目库。
 * 覆盖全部项目 API 路由，并返回共享 store 以便测试断言。
 *
 * @param stateDelay  PUT /state 的人工延迟毫秒数（默认 0）。
 *   在"保存角标"测试中设为 400 以让 saving 状态有足够时间被 Playwright 观测到。
 */
function setupFakeBackend(page: Page, stateDelay = 0) {
  const store = new Map<string, FakeProject>();

  // 基础接线 (health / journals / usage)
  page.route("**/api/health", (r) =>
    r.fulfill({
      json: { status: "ok", provider: "openai", model: "deepseek-chat", mock: true },
    }),
  );
  page.route("**/api/journals", (r) => r.fulfill({ json: { journals: [] } }));
  page.route("**/api/usage", (r) => r.fulfill({ json: { available: false } }));

  // GET/POST /api/projects
  page.route("**/api/projects", async (route, req) => {
    if (req.method() === "GET") {
      const list = Array.from(store.values())
        .map(({ id, name, updated_at }) => ({ id, name, updated_at }))
        .sort((a, b) => b.updated_at - a.updated_at);
      return route.fulfill({ json: list });
    }
    if (req.method() === "POST") {
      const body = JSON.parse(req.postData() || "{}") as { id: string; name: string };
      const now = Date.now();
      const p: FakeProject = {
        id: body.id,
        name: (body.name || "").trim() || "未命名项目",
        created_at: now,
        updated_at: now,
        state: {},
        history: [],
      };
      store.set(p.id, p);
      return route.fulfill({ json: p });
    }
    return route.fulfill({ status: 405 });
  });

  // /api/projects/{id}  and  /api/projects/{id}/state
  page.route(/.*\/api\/projects\/[^/]+(\/state)?$/, async (route, req) => {
    const url = new URL(req.url());
    const m = url.pathname.match(/\/api\/projects\/([^/]+)(\/state)?$/);
    if (!m) return route.fulfill({ status: 404 });
    const id = m[1];
    const isState = !!m[2];
    const p = store.get(id);
    const method = req.method();

    if (isState && method === "PUT") {
      if (!p) return route.fulfill({ status: 404 });
      const body = JSON.parse(req.postData() || "{}") as {
        state: Record<string, string>;
        history: unknown[];
      };
      p.state = body.state;
      p.history = body.history;
      p.updated_at = Date.now();
      if (stateDelay > 0) {
        await new Promise((res) => setTimeout(res, stateDelay));
      }
      return route.fulfill({ json: { updated_at: p.updated_at } });
    }

    if (!isState && method === "GET") {
      if (!p) return route.fulfill({ status: 404 });
      return route.fulfill({ json: p });
    }
    if (!isState && method === "PATCH") {
      if (!p) return route.fulfill({ status: 404 });
      const body = JSON.parse(req.postData() || "{}") as { name: string };
      p.name = (body.name || "").trim() || p.name;
      p.updated_at = Date.now();
      return route.fulfill({ json: { id: p.id, name: p.name, updated_at: p.updated_at } });
    }
    if (!isState && method === "DELETE") {
      if (!p) return route.fulfill({ status: 404 });
      store.delete(id);
      return route.fulfill({ status: 204 });
    }
    return route.fulfill({ status: 405 });
  });

  return { store };
}

// ── 测试 1: Picker 可见，默认显示当前项目名 ──────────────────────

test("Picker 可见, 默认显示当前项目名", async ({ page }) => {
  setupFakeBackend(page);
  await page.goto("/");
  const trigger = page.getByTestId("project-picker-trigger");
  await expect(trigger).toBeVisible();
  // 全新启动 → 自动创建"未命名项目"
  await expect(trigger).toContainText("未命名项目");
});

// ── 测试 2: 新建项目，输入名字后切到新空白项目 ──────────────────

test("新建项目: 输入名字后切到新空白项目", async ({ page }) => {
  setupFakeBackend(page);
  await page.goto("/");

  // 在找选题填一些文字（使用稳定的 data-testid 选择器）
  await page.getByTestId("nav-idea").click();
  await page.getByTestId("input-field").fill("A 项目的数据");

  // 打开 picker 新建
  await page.getByTestId("project-picker-trigger").click();
  await page.getByTestId("project-new").click();
  await page.getByTestId("project-input").fill("B 项目");
  await page.getByTestId("project-create-confirm").click();

  // picker 显示新名字
  await expect(page.getByTestId("project-picker-trigger")).toContainText("B 项目");

  // 找选题模块内 input-field 清空（新项目空状态）
  await page.getByTestId("nav-idea").click();
  await expect(page.getByTestId("input-field")).toHaveValue("");
});

// ── 测试 3: 切回旧项目数据恢复 ────────────────────────────────

test("切回旧项目数据恢复", async ({ page }) => {
  setupFakeBackend(page);
  await page.goto("/");

  // 在项目 A（未命名项目）的找选题里填写数据
  await page.getByTestId("nav-idea").click();
  await page.getByTestId("input-field").fill("A 数据");

  // 等防抖（1s）+ 给同步请求时间完成
  await page.waitForTimeout(1500);

  // 新建 B 项目
  await page.getByTestId("project-picker-trigger").click();
  await page.getByTestId("project-new").click();
  await page.getByTestId("project-input").fill("B");
  await page.getByTestId("project-create-confirm").click();

  // 等 B 项目创建并切换完成
  await expect(page.getByTestId("project-picker-trigger")).toContainText("B");

  // 切回 A（列表里"未命名项目"还在）
  await page.getByTestId("project-picker-trigger").click();
  const aItem = page.locator('[data-testid^="project-item-"]', { hasText: "未命名项目" });
  await aItem.click();

  // 等切换完成
  await expect(page.getByTestId("project-picker-trigger")).toContainText("未命名项目");

  // 打开找选题，A 的数据应恢复
  await page.getByTestId("nav-idea").click();
  await expect(page.getByTestId("input-field")).toHaveValue("A 数据");
});

// ── 测试 4: 重命名当前项目，下拉里立即反映 ───────────────────────

test("重命名当前项目下拉里立即反映", async ({ page }) => {
  setupFakeBackend(page);
  await page.goto("/");

  await page.getByTestId("project-picker-trigger").click();
  await page.getByTestId("project-rename").click();
  await page.getByTestId("project-input").fill("我的论文");
  await page.getByTestId("project-rename-confirm").click();

  await expect(page.getByTestId("project-picker-trigger")).toContainText("我的论文");
});

// ── 测试 5: 删除最后一个项目，自动建未命名项目 ───────────────────

test("删除最后一个项目: 自动建未命名项目", async ({ page }) => {
  setupFakeBackend(page);
  await page.goto("/");

  await page.getByTestId("project-picker-trigger").click();
  await page.getByTestId("project-delete").click();
  await page.getByTestId("project-delete-confirm").click();

  // 应自动新建一个未命名项目
  await expect(page.getByTestId("project-picker-trigger")).toContainText("未命名项目");
});

// ── 测试 6: 保存角标：编辑后出现，完成后消失 ─────────────────────

test("保存角标: 编辑后出现 '保存中', 完成后消失", async ({ page }) => {
  // stateDelay=1200 让 PUT /state 响应慢 1200ms，使"保存中"角标可见窗口更宽，
  // 避免并行跑测试时因窗口太窄(此前 400ms)偶发探测不到而 flaky。
  setupFakeBackend(page, 1200);
  await page.goto("/");

  await page.getByTestId("nav-idea").click();
  await page.getByTestId("input-field").fill("触发同步");

  // 防抖 1s 后开始保存，badge 应出现（"… 保存中"），总等待 2500ms 足够
  const badge = page.getByTestId("sync-badge");
  await expect(badge).toBeVisible({ timeout: 2500 });

  // 保存完成（400ms 后）badge 消失（回到 idle）
  await expect(badge).toBeHidden({ timeout: 2000 });
});

// ── 测试 7: 离线：picker 触发器禁用，编辑仍可 ───────────────────

test("离线: picker 触发器禁用, 编辑仍可", async ({ page }) => {
  // health / journals / usage 正常，仅 projects 接口返回 503 → offline=true
  await page.route("**/api/health", (r) =>
    r.fulfill({
      json: { status: "ok", provider: "openai", model: "deepseek-chat", mock: true },
    }),
  );
  await page.route("**/api/journals", (r) => r.fulfill({ json: { journals: [] } }));
  await page.route("**/api/usage", (r) => r.fulfill({ json: { available: false } }));
  await page.route("**/api/projects**", (r) => r.fulfill({ status: 503 }));

  await page.goto("/");

  // offline 时 booted=true，App 仍渲染
  const trigger = page.getByTestId("project-picker-trigger");
  await expect(trigger).toBeVisible({ timeout: 5000 });

  // 触发器禁用（offline=true 且 current=null）
  await expect(trigger).toBeDisabled();
});

// ── 测试 8: 迁移：启动前预置 ra:* 数据，应被打包为"默认项目" ────

test("迁移: 启动前预置 ra:* 数据, 应被打包为'默认项目'", async ({ page }) => {
  setupFakeBackend(page);

  // 在 goto 之前注入 localStorage（模拟老版本遗留数据）
  await page.addInitScript(() => {
    localStorage.setItem("ra:idea:field", JSON.stringify("LEGACY"));
  });

  await page.goto("/");

  // 迁移后项目应命名为"默认项目"
  await expect(page.getByTestId("project-picker-trigger")).toContainText("默认项目");

  // 遗留数据应被保留到新项目中
  await page.getByTestId("nav-idea").click();
  await expect(page.getByTestId("input-field")).toHaveValue("LEGACY");
});

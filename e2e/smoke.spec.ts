import { expect, test } from "@playwright/test";

// Smoke coverage of the critical paths: auth gating and each main dashboard
// section rendering. Expand this suite alongside new features — every feature
// PR should add or extend a spec here covering its happy path.

test("unauthenticated visitors are redirected to login", async ({ browser }) => {
  const context = await browser.newContext({ storageState: undefined });
  const page = await context.newPage();
  await page.goto("/");
  await page.waitForURL(/\/login/);
  await expect(page.getByText("Sign in to your account")).toBeVisible();
  await context.close();
});

test("dashboard renders run activity after login", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Runs" })).toBeVisible();
});

test("agents page renders", async ({ page }) => {
  await page.goto("/agents");
  await expect(page.getByRole("heading", { level: 1, name: "Agents" })).toBeVisible();
});

test("jobs page renders", async ({ page }) => {
  await page.goto("/jobs");
  await expect(page.getByRole("heading", { level: 1, name: "Jobs" })).toBeVisible();
});

test("workflows page renders", async ({ page }) => {
  await page.goto("/workflows");
  await expect(page.getByRole("heading", { level: 1, name: "Workflows" })).toBeVisible();
});

test("runs page renders", async ({ page }) => {
  await page.goto("/runs");
  await expect(page.getByRole("heading", { level: 1, name: "All Runs" })).toBeVisible();
});

test("settings renders the runner registry (execution-pool view)", async ({ page, baseURL }) => {
  // Seed + activate an org/project the way the switcher persists them, so the
  // settings sections render.
  const orgRes = await page.request.post("/api/orgs", { data: { name: "Runners E2E" } });
  expect(orgRes.ok()).toBeTruthy();
  const org = await orgRes.json();
  const projectRes = await page.request.post(`/api/projects?orgId=${org.id}`, {
    data: { name: "Runners E2E Project" },
  });
  expect(projectRes.ok()).toBeTruthy();
  const project = await projectRes.json();
  await page.context().addCookies([{ name: "harbour_org", value: org.id, url: baseURL }]);
  await page.addInitScript(
    (id: string) => localStorage.setItem("harbour_active_project", id),
    project.id,
  );

  await page.goto("/settings");
  // The page renders (the new Runners section doesn't crash it)...
  await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
  // ...and the execution-pool view lists the auto-provisioned local runner row.
  // (`harbour admin create`, the e2e bootstrap, provisions it.) `exact` avoids the
  // section blurb ("Local runners are the auto-provisioned pool…"); the generous
  // timeout absorbs the dev server's first-hit route compile.
  await expect(page.getByText("Local runner", { exact: true })).toBeVisible({ timeout: 15_000 });
});

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
  // With no active project selected, the switcher shows the all-projects scope.
  // (Scoped to the sidebar: the CSS-hidden mobile header renders a twin switcher.)
  await expect(page.locator("aside").getByText("All Projects")).toBeVisible();
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

test("settings renders the runner registry (execution-pool view)", async ({ page }) => {
  // Seed + activate a project the way the switcher persists it, so the
  // project-scoped settings sections render alongside the instance ones.
  const projectRes = await page.request.post("/api/projects", {
    data: { name: "Runners E2E Project" },
  });
  expect(projectRes.ok()).toBeTruthy();
  const project = await projectRes.json();
  await page.addInitScript(
    (id: string) => localStorage.setItem("harbour_active_project", id),
    project.id,
  );

  await page.goto("/settings");
  // The page renders (the Runners section doesn't crash it)...
  await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
  // ...the switcher reflects the activated project (sidebar-scoped: the CSS-hidden
  // mobile header renders a twin switcher)...
  await expect(page.locator("aside").getByText("Runners E2E Project")).toBeVisible();
  // ...and the execution-pool view lists the auto-provisioned local runner row.
  // (`harbour user create`, the e2e bootstrap, provisions it.) `exact` avoids the
  // section blurb ("Local runners are the auto-provisioned pool…"); the generous
  // timeout absorbs the dev server's first-hit route compile.
  await expect(page.getByText("Local runner", { exact: true })).toBeVisible({ timeout: 15_000 });
});

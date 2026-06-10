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

test("runs page renders", async ({ page }) => {
  await page.goto("/runs");
  await expect(page.getByRole("heading", { level: 1, name: "All Runs" })).toBeVisible();
});

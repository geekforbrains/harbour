import { expect, test as setup } from "@playwright/test";

// Logs in through the real login form once and saves the session cookie for
// all other e2e tests (the canonical Playwright auth pattern).
setup("authenticate", async ({ page }) => {
  await page.goto("/login");
  await page.fill("#email", "admin@e2e.local");
  await page.fill("#password", "e2e-test-password");
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL("/");
  await expect(page.locator("body")).not.toContainText("Sign in to your account");
  await page.context().storageState({ path: ".e2e/state.json" });
});

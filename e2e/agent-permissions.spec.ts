import { expect, test } from "@playwright/test";

// Per-agent permissions (feat/agent-permissions): agents default to "enforced"
// (a policy file in the workspace is required); flipping one to "unrestricted"
// is a deliberate act behind a confirm(), and the agent then carries a visible
// "Unrestricted" badge wherever its identity is shown.

test("agent can be flipped to unrestricted and the badge persists", async ({ page }) => {
  // Seed project → agent over the API with the logged-in session.
  // (remote: true skips local-runner registration; the UI flow is the point.)
  const projectRes = await page.request.post("/api/projects", {
    data: { name: "Permissions E2E Project" },
  });
  expect(projectRes.ok()).toBeTruthy();
  const project = await projectRes.json();

  const agentRes = await page.request.post(`/api/agents?projectId=${project.id}`, {
    data: { name: "Permissions Agent", cli: "claude", remote: true },
  });
  expect(agentRes.status()).toBe(201);
  const agent = await agentRes.json();

  // Activate the seeded project the way the switcher would persist it.
  await page.addInitScript(
    (id: string) => localStorage.setItem("harbour_active_project", id),
    project.id,
  );

  await page.goto(`/agents/${agent.id}`);
  await expect(page.getByRole("heading", { name: "Permissions Agent" })).toBeVisible();

  // Enforced is the default — no badge on the header.
  await expect(page.getByText("Unrestricted", { exact: true })).not.toBeVisible();

  // Flip to unrestricted in settings. Selecting it MUST raise a confirm() —
  // asserted, not merely tolerated: a bare `dialog.accept()` handler passes just
  // as happily when no dialog appears, so removing the gate would go unnoticed.
  await page.getByRole("button", { name: "Settings" }).click();
  let confirmMessage: string | null = null;
  page.once("dialog", (dialog) => {
    confirmMessage = dialog.message();
    return dialog.accept();
  });
  await page.getByLabel("Permissions").selectOption("unrestricted");
  await expect(() => expect(confirmMessage).not.toBeNull()).toPass({ timeout: 5000 });
  expect(confirmMessage).toContain("bypassed");
  await page.getByRole("button", { name: "Save" }).click();

  // The badge appears on the detail header once the update lands.
  await expect(page.getByText("Unrestricted", { exact: true })).toBeVisible();

  // The value persists across a reload.
  await page.reload();
  await expect(page.getByRole("heading", { name: "Permissions Agent" })).toBeVisible();
  await expect(page.getByText("Unrestricted", { exact: true })).toBeVisible();

  // And the agents list row carries the same at-a-glance marker.
  await page.goto("/agents");
  await expect(page.getByText("Permissions Agent")).toBeVisible();
  await expect(page.getByText("Unrestricted", { exact: true })).toBeVisible();
});

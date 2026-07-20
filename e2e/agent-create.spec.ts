import { expect, test } from "@playwright/test";

// Workspace slugs (issue #40): agent slugs are unique per project, so creating
// an agent whose name slugifies to an existing sibling's slug ("Dev_Agent" vs
// "Dev Agent") is rejected with a 409 — and the create dialog must surface the
// server's message inline instead of swallowing it.

test("agent create dialog surfaces the server's name-collision error", async ({ page }) => {
  // Seed project → first agent over the API with the logged-in session.
  // (remote: true skips local-runner registration; the collision is the point.)
  const projectRes = await page.request.post("/api/projects", {
    data: { name: "Slug E2E Project" },
  });
  expect(projectRes.ok()).toBeTruthy();
  const project = await projectRes.json();

  const agentRes = await page.request.post(`/api/agents?projectId=${project.id}`, {
    data: { name: "Dev Agent", cli: "claude", remote: true },
  });
  expect(agentRes.status()).toBe(201);

  // The dialog's CLI step only offers tools detected on the server's machine.
  const tools: { id: string; name: string; installed: boolean }[] = await (
    await page.request.get("/api/system/cli-tools")
  ).json();
  const installed = tools.find((t) => t.installed);
  test.skip(!installed, "no agent CLI installed on this machine");

  // Activate the seeded project the way the switcher would persist it.
  await page.addInitScript(
    (id: string) => localStorage.setItem("harbour_active_project", id),
    project.id,
  );

  await page.goto("/agents");
  await page.getByRole("button", { name: "New Agent" }).click();
  await page.getByRole("button", { name: new RegExp(installed!.name) }).click();

  // Lookalike name: different display name, same slug as the seeded agent.
  await page.getByLabel("Name").fill("Dev_Agent");

  // The live preview already shows the (colliding) folder name pre-submit.
  await expect(page.getByText("Workspace folder: dev-agent")).toBeVisible();

  await page.getByRole("button", { name: "Create", exact: true }).click();

  // The server's 409 message lands inline and the dialog stays open to fix it.
  await expect(page.getByText(/already exists in this project/)).toBeVisible();
  await expect(page.getByRole("heading", { name: "New Agent" })).toBeVisible();
});

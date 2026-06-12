import { expect, test } from "@playwright/test";

// Org-level workflows (issue #41): the create dialog's scope toggle can pin a
// workflow to the whole org (project_id NULL), and the workflows list marks
// those rows with the monochrome "Org" badge — project-level rows stay unbadged.

test("creating an org-level workflow via the scope toggle shows the Org badge", async ({
  page,
  baseURL,
}) => {
  // Seed org → project over the API with the logged-in admin session.
  const orgRes = await page.request.post("/api/orgs", { data: { name: "Org WF E2E" } });
  expect(orgRes.ok()).toBeTruthy();
  const org = await orgRes.json();

  const projectRes = await page.request.post(`/api/projects?orgId=${org.id}`, {
    data: { name: "Org WF Project" },
  });
  expect(projectRes.ok()).toBeTruthy();
  const project = await projectRes.json();

  // A project-level sibling, seeded via the API, to prove the badge is
  // scope-driven and not slapped on every workflow row.
  const projWfRes = await page.request.post(`/api/jobs?orgId=${org.id}&projectId=${project.id}`, {
    data: { name: "Project Scoped WF", schedule: '{"every":60}', command: "echo proj" },
  });
  expect(projWfRes.status()).toBe(201);

  // Activate the seeded org/project the way the switcher would persist them,
  // so "This project" is the dialog's default and the toggle is exercised.
  await page.context().addCookies([{ name: "harbour_org", value: org.id, url: baseURL }]);
  await page.addInitScript(
    (id: string) => localStorage.setItem("harbour_active_project", id),
    project.id,
  );

  await page.goto("/workflows");
  await page.getByRole("button", { name: "New Workflow" }).click();

  // The scope select is the dialog's only combobox (workflow kind has no
  // agent select). Flip it from the project default to the whole org.
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "New Workflow" })).toBeVisible();
  await dialog.getByRole("combobox").selectOption("org");

  await dialog.getByPlaceholder("e.g. Morning Tweet").fill("Org Scoped WF");
  await dialog.getByPlaceholder("e.g. python3 check_health.py").fill("echo org");
  await dialog.getByRole("button", { name: "Create Workflow" }).click();
  await expect(dialog).not.toBeVisible();

  // The org-level row carries the Org badge; the project-level row does not.
  const orgRow = page.getByRole("link").filter({ hasText: "Org Scoped WF" });
  await expect(orgRow).toBeVisible();
  await expect(orgRow.getByText("Org", { exact: true })).toBeVisible();

  const projRow = page.getByRole("link").filter({ hasText: "Project Scoped WF" });
  await expect(projRow).toBeVisible();
  await expect(projRow.getByText("Org", { exact: true })).toHaveCount(0);
});

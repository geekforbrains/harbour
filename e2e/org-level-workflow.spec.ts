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
    data: {
      name: "Project Scoped WF",
      schedule: '{"every":60}',
      command: { runtime: "bash", content: "echo proj" },
    },
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

  // Scope the dialog locator by name: opening the nested gate editor briefly
  // puts two dialogs in the DOM, so a bare getByRole("dialog") would trip
  // strict mode. The scope select is this dialog's only combobox.
  const dialog = page.getByRole("dialog", { name: "New Workflow" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("combobox").selectOption("org");

  await dialog.getByPlaceholder("e.g. Morning Tweet").fill("Org Scoped WF");

  // The command is a gist-style gate: open its editor, write the body, save.
  // Wait for the nested dialog to fully close before submitting the form.
  await dialog.getByRole("button", { name: "Add Command script" }).click();
  const gate = page.getByRole("dialog", { name: /Command Script/ });
  await gate.getByRole("textbox").fill("echo org");
  await gate.getByRole("button", { name: "Save" }).click();
  await expect(gate).toBeHidden();

  await dialog.getByRole("button", { name: "Create Workflow" }).click();
  await expect(dialog).toBeHidden();

  // The org-level row carries the Org badge; the project-level row does not.
  const orgRow = page.getByRole("link").filter({ hasText: "Org Scoped WF" });
  await expect(orgRow).toBeVisible();
  await expect(orgRow.getByText("Org", { exact: true })).toBeVisible();

  const projRow = page.getByRole("link").filter({ hasText: "Project Scoped WF" });
  await expect(projRow).toBeVisible();
  await expect(projRow.getByText("Org", { exact: true })).toHaveCount(0);
});

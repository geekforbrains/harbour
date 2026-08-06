import { expect, test } from "@playwright/test";

// Run metrics (feat/run-metrics): runs accumulate working duration and token
// usage; jobs roll them up. Seed project → agent → job over the API with the
// logged-in session, trigger a run, claim it over the Runner Protocol to mint
// its exec token, and post usage the way the bundled runner does after a CLI
// turn — then assert the metric surfaces render on the run detail and job
// detail pages. Duration stays 0 here (the claim and finish happen in the
// same second), so its cells assert the em-dash default. The jobs list
// deliberately doesn't surface run-count/avg-duration rollups (that's on the
// job detail page instead), so it's not asserted here.

test("run and job pages surface duration and token metrics", async ({ page }) => {
  const projectRes = await page.request.post("/api/projects", {
    data: { name: "Metrics E2E Project" },
  });
  expect(projectRes.ok()).toBeTruthy();
  const project = await projectRes.json();

  const agentRes = await page.request.post(`/api/agents?projectId=${project.id}`, {
    data: { name: "Metrics Agent", cli: "claude", remote: true },
  });
  expect(agentRes.status()).toBe(201);
  const agent = await agentRes.json();

  const jobRes = await page.request.post(`/api/agents/${agent.id}/jobs`, {
    data: { name: "Metrics Job", schedule: '{"every":60}' },
  });
  expect(jobRes.status()).toBe(201);
  const job = await jobRes.json();

  const triggerRes = await page.request.post(`/api/jobs/${job.id}/trigger`, { data: {} });
  expect(triggerRes.status()).toBe(201);
  const { runId } = await triggerRes.json();

  // Usage is executor-only: enroll a runner authorized for the default "local"
  // placement, claim the run (minting its exec token), and post a turn's usage.
  const runnerRes = await page.request.post("/api/runners", {
    data: { name: "Metrics E2E Runner", labels: ["local"] },
  });
  expect(runnerRes.status()).toBe(201);
  const runner = await runnerRes.json();

  const claimRes = await page.request.post("/api/runner/claim", {
    headers: { authorization: `Bearer ${runner.token}` },
    data: { capabilities: { kinds: ["agent"], clis: ["claude"], labels: ["local"] } },
  });
  expect(claimRes.ok()).toBeTruthy();
  const claim = await claimRes.json();
  expect(claim.run?.id).toBe(runId);

  const usageRes = await page.request.post(`/api/runs/${runId}/usage`, {
    headers: { authorization: `Bearer ${claim.exec_token}` },
    data: { input_tokens: 45_200, output_tokens: 2_100 },
  });
  expect(usageRes.ok()).toBeTruthy();

  // Activate the seeded project the way the switcher would persist it.
  await page.addInitScript(
    (id: string) => localStorage.setItem("harbour_active_project", id),
    project.id,
  );

  // Run detail: the metadata grid gains a duration cell (Timer icon, em-dash —
  // no attempt has finished) and a token cell showing the posted total.
  await page.goto(`/runs/${runId}`);
  await expect(page.getByText("Metrics Job").first()).toBeVisible();
  await expect(page.locator(".lucide-timer")).toBeVisible();
  await expect(page.getByText("47.3k tokens")).toBeVisible();
  await expect(page.getByTitle("45.2k in · 2.1k out")).toBeVisible();

  // Job detail: avg-duration cell (em-dash — no measured runs yet) and the
  // total-tokens rollup.
  await page.goto(`/jobs/${job.id}`);
  await expect(page.getByRole("heading", { name: "Metrics Job" })).toBeVisible();
  await expect(page.locator(".lucide-timer")).toBeVisible();
  await expect(page.getByText("47.3k tokens")).toBeVisible();

  // Jobs list: the job is still findable — no run-count/avg rollup here by design.
  await page.goto("/jobs");
  await expect(page.getByText("Metrics Job")).toBeVisible();
});

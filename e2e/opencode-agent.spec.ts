import { expect, test } from "@playwright/test";

test("creates an OpenCode agent with an Ollama connection", async ({ page }) => {
  const projectResponse = await page.request.post("/api/projects", {
    data: { name: "OpenCode E2E Project" },
  });
  expect(projectResponse.ok()).toBeTruthy();
  const project = await projectResponse.json();

  await page.addInitScript(
    (id: string) => localStorage.setItem("harbour_active_project", id),
    project.id,
  );

  await page.goto("/llm-connections");
  await expect(page.getByRole("heading", { level: 1, name: "LLM Connections" })).toBeVisible();
  await page.getByRole("button", { name: "New Connection" }).click();
  await page.getByLabel("Connection name").fill("Runner Ollama");
  await page.getByLabel("Provider", { exact: true }).selectOption("ollama");
  await expect(page.getByLabel("Base URL")).toHaveValue("http://127.0.0.1:11434/v1");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByText("Runner Ollama", { exact: true })).toBeVisible();

  await page.goto("/agents");
  await page.getByRole("button", { name: "New Agent" }).click();
  await page.getByRole("button", { name: /OpenCode/ }).click();
  await page.getByLabel("Name").fill("Ollama Coder");
  await expect(page.getByLabel("Connection")).toHaveValue(/.+/);
  await page.getByLabel("Model").fill("ollama/qwen3-coder");
  await page.getByLabel("Variant").fill("high");
  await page.getByRole("button", { name: "Create", exact: true }).click();

  await expect(page.getByRole("heading", { name: "Agent Created" })).toBeVisible();
  await expect(page.getByRole("dialog").getByText("Ollama Coder", { exact: true })).toBeVisible();

  const agentsResponse = await page.request.get(`/api/agents?projectId=${project.id}`);
  expect(agentsResponse.ok()).toBeTruthy();
  const agents = await agentsResponse.json();
  expect(agents).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        name: "Ollama Coder",
        cli: "opencode",
        model: "ollama/qwen3-coder",
        thinking: "high",
        llm_connection_id: expect.any(String),
      }),
    ]),
  );
});

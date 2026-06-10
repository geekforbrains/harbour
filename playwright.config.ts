import { defineConfig, devices } from "@playwright/test";

// E2E smoke suite. Runs against a dev server on port 3030 with a throwaway
// Harbour home in .e2e/ (seeded by e2e/setup-and-start.mjs). See
// docs/reference/development-standards.md for the testing conventions.
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: "list",
  outputDir: ".e2e/test-results",
  use: {
    baseURL: "http://localhost:3030",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "setup", testMatch: /auth\.setup\.ts/ },
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        storageState: ".e2e/state.json",
      },
      dependencies: ["setup"],
    },
  ],
  webServer: {
    command: "node e2e/setup-and-start.mjs",
    url: "http://localhost:3030/login",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});

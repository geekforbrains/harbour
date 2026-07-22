import { describe, expect, it } from "vitest";
import { CLI_TOOLS } from "@/app/api/system/cli-tools/route";
import { isSupportedCliVersion } from "@/lib/cli-config";

describe("CLI tool discovery catalog", () => {
  it("detects every supported runner CLI, including OpenCode", () => {
    expect(CLI_TOOLS.map((tool) => tool.id)).toEqual(["claude", "codex", "opencode"]);
  });

  it("uses the same OpenCode compatibility floor as the runner", () => {
    expect(isSupportedCliVersion("opencode", "1.17.11")).toBe(false);
    expect(isSupportedCliVersion("opencode", "1.17.12")).toBe(true);
    expect(isSupportedCliVersion("opencode", "1.18.4")).toBe(true);
    expect(isSupportedCliVersion("opencode", null)).toBe(false);
    expect(isSupportedCliVersion("claude", null)).toBe(true);
  });
});

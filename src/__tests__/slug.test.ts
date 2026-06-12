import { describe, expect, it } from "vitest";
import { slugify } from "@/lib/slug";

// The canonical slug algorithm (issue #40). Slugs become workspace path
// segments on runner machines, so the contract is strict: lowercase, every
// run of non-[a-z0-9] collapsed to a single "-", edges trimmed, and "" for
// names with no letters or numbers (callers reject those as invalid names).

describe("slugify", () => {
  it("passes a simple lowercase name through", () => {
    expect(slugify("dev")).toBe("dev");
    expect(slugify("agent2")).toBe("agent2");
  });

  it("lowercases the name", () => {
    expect(slugify("Dev")).toBe("dev");
    expect(slugify("ACME")).toBe("acme");
  });

  it("replaces spaces, underscores, and punctuation with a single dash", () => {
    expect(slugify("Dev Agent")).toBe("dev-agent");
    expect(slugify("Dev_Agent")).toBe("dev-agent");
    expect(slugify("dev.agent")).toBe("dev-agent");
  });

  it("maps lookalike names to the same slug (the collision the feature exists to catch)", () => {
    expect(slugify("Dev_Agent")).toBe(slugify("Dev Agent"));
    expect(slugify("DEV  AGENT!!")).toBe(slugify("dev-agent"));
  });

  it("collapses a run of separators into one dash", () => {
    expect(slugify("a  -  _ b")).toBe("a-b");
    expect(slugify("a!!!b")).toBe("a-b");
  });

  it("trims leading and trailing separators", () => {
    expect(slugify("  My  Org!! ")).toBe("my-org");
    expect(slugify("-dev-")).toBe("dev");
    expect(slugify("...dev...")).toBe("dev");
  });

  it("returns '' for names with no letters or numbers", () => {
    expect(slugify("")).toBe("");
    expect(slugify("   ")).toBe("");
    expect(slugify("🚀🚀")).toBe("");
    expect(slugify("日本語")).toBe("");
    expect(slugify("!!!---___")).toBe("");
  });

  it("keeps digits", () => {
    expect(slugify("Team 42")).toBe("team-42");
  });
});

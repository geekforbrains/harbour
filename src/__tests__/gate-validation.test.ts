import { describe, expect, it } from "vitest";
import { HttpError, optionalGate, parseGate, requireGate } from "@/lib/http";

/** Assert that `fn` throws an HttpError carrying a 400 status. */
function expect400(fn: () => unknown) {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(HttpError);
    expect((e as HttpError).status).toBe(400);
    return;
  }
  throw new Error("expected the call to throw an HttpError");
}

describe("parseGate", () => {
  it("accepts a well-formed gate and returns it", () => {
    expect(parseGate({ runtime: "python", content: "x" }, "gate")).toEqual({
      runtime: "python",
      content: "x",
    });
  });

  it("accepts each supported runtime", () => {
    expect(parseGate({ runtime: "bash", content: "echo hi" }, "gate").runtime).toBe("bash");
    expect(parseGate({ runtime: "python", content: "print(1)" }, "gate").runtime).toBe("python");
    expect(parseGate({ runtime: "node", content: "console.log(1)" }, "gate").runtime).toBe("node");
  });

  it("defaults runtime to bash when omitted but content present", () => {
    expect(parseGate({ content: "echo hi" }, "gate")).toEqual({
      runtime: "bash",
      content: "echo hi",
    });
  });

  it("defaults runtime to bash when runtime is null but content present", () => {
    expect(parseGate({ runtime: null, content: "echo hi" }, "gate")).toEqual({
      runtime: "bash",
      content: "echo hi",
    });
  });

  it("preserves content verbatim — no trimming of whitespace or shebang", () => {
    const content = "#!/usr/bin/env bash\n\n  echo padded  \n";
    expect(parseGate({ runtime: "bash", content }, "gate").content).toBe(content);
  });

  it("throws when content is missing", () => {
    expect400(() => parseGate({ runtime: "bash" }, "gate"));
  });

  it("throws when content is empty", () => {
    expect400(() => parseGate({ runtime: "bash", content: "" }, "gate"));
  });

  it("throws when content is blank (whitespace only)", () => {
    expect400(() => parseGate({ runtime: "bash", content: "   \n\t " }, "gate"));
  });

  it("throws when content is a non-string", () => {
    expect400(() => parseGate({ runtime: "bash", content: 42 }, "gate"));
    expect400(() => parseGate({ runtime: "bash", content: null }, "gate"));
    expect400(() => parseGate({ runtime: "bash", content: { nested: "x" } }, "gate"));
  });

  it("throws when runtime is an unsupported string", () => {
    expect400(() => parseGate({ runtime: "ruby", content: "puts 1" }, "gate"));
  });

  it("throws when runtime is a non-string", () => {
    expect400(() => parseGate({ runtime: 7, content: "echo hi" }, "gate"));
  });

  it("throws on a null value", () => {
    expect400(() => parseGate(null, "gate"));
  });

  it("throws on an array value", () => {
    expect400(() => parseGate(["echo hi"], "gate"));
  });

  it("throws on a non-object value", () => {
    expect400(() => parseGate("echo hi", "gate"));
    expect400(() => parseGate(42, "gate"));
    expect400(() => parseGate(undefined, "gate"));
  });
});

describe("requireGate", () => {
  it("returns the parsed gate for a valid value", () => {
    expect(requireGate({ runtime: "node", content: "x" }, "gate")).toEqual({
      runtime: "node",
      content: "x",
    });
  });

  it("throws on undefined", () => {
    expect400(() => requireGate(undefined, "gate"));
  });

  it("throws on null", () => {
    expect400(() => requireGate(null, "gate"));
  });

  it("throws on an otherwise invalid gate", () => {
    expect400(() => requireGate({ runtime: "ruby", content: "x" }, "gate"));
  });
});

describe("optionalGate", () => {
  it("returns undefined for undefined (leave unchanged)", () => {
    expect(optionalGate(undefined, "gate")).toBeUndefined();
  });

  it("returns null for null (clear the gate)", () => {
    expect(optionalGate(null, "gate")).toBeNull();
  });

  it("returns the parsed gate for a valid object", () => {
    expect(optionalGate({ runtime: "python", content: "x" }, "gate")).toEqual({
      runtime: "python",
      content: "x",
    });
  });

  it("throws on an invalid present value", () => {
    expect400(() => optionalGate({ runtime: "ruby", content: "x" }, "gate"));
    expect400(() => optionalGate({ content: "" }, "gate"));
  });
});

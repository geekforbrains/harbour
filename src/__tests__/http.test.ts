import { describe, expect, it } from "vitest";
import {
  assertOneOf,
  badRequest,
  HttpError,
  optionalBoolean,
  optionalPositiveInt,
  optionalString,
  optionalStringArray,
  readJson,
  requireNonEmptyString,
  requirePositiveInt,
} from "@/lib/http";

/** A minimal Request stand-in: readJson only ever calls req.text(). */
function reqWithBody(body: string): Request {
  return { text: async () => body } as unknown as Request;
}

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

describe("HttpError", () => {
  it("defaults to status 400 and carries the message", () => {
    const e = new HttpError("nope");
    expect(e.status).toBe(400);
    expect(e.message).toBe("nope");
    expect(e).toBeInstanceOf(Error);
  });

  it("carries a custom status", () => {
    expect(new HttpError("x", 409).status).toBe(409);
  });

  it("badRequest throws a 400 HttpError", () => {
    expect400(() => badRequest("bad"));
  });
});

describe("readJson()", () => {
  it("parses a JSON object body", async () => {
    await expect(readJson(reqWithBody('{"a":1,"b":"x"}'))).resolves.toEqual({ a: 1, b: "x" });
  });

  it("treats an empty or whitespace body as {}", async () => {
    await expect(readJson(reqWithBody(""))).resolves.toEqual({});
    await expect(readJson(reqWithBody("   \n "))).resolves.toEqual({});
  });

  it("rejects malformed JSON with a 400", async () => {
    await expect(readJson(reqWithBody("{not json"))).rejects.toMatchObject({ status: 400 });
  });

  it("rejects a non-object top-level value (array/string/number/null) with a 400", async () => {
    for (const body of ["[]", "[1,2]", '"hi"', "5", "null", "true"]) {
      await expect(readJson(reqWithBody(body))).rejects.toMatchObject({ status: 400 });
    }
  });
});

describe("requireNonEmptyString()", () => {
  it("returns the trimmed value", () => {
    expect(requireNonEmptyString("x", "f")).toBe("x");
    expect(requireNonEmptyString("  hi  ", "f")).toBe("hi");
  });
  it("rejects empty / whitespace / non-strings", () => {
    for (const v of ["", "   ", 5, null, undefined, {}, []]) {
      expect400(() => requireNonEmptyString(v, "f"));
    }
  });
});

describe("optionalString()", () => {
  it("passes through undefined/null as undefined", () => {
    expect(optionalString(undefined, "f")).toBeUndefined();
    expect(optionalString(null, "f")).toBeUndefined();
  });
  it("accepts any string (including empty)", () => {
    expect(optionalString("", "f")).toBe("");
    expect(optionalString("x", "f")).toBe("x");
  });
  it("rejects non-strings", () => {
    for (const v of [5, true, {}, []]) expect400(() => optionalString(v, "f"));
  });
});

describe("requirePositiveInt() / optionalPositiveInt()", () => {
  it("accepts positive integers", () => {
    expect(requirePositiveInt(1, "f")).toBe(1);
    expect(requirePositiveInt(30, "f")).toBe(30);
  });
  it("rejects 0, negatives, floats, strings, undefined", () => {
    for (const v of [0, -1, 1.5, "5", "30m", undefined, null]) {
      expect400(() => requirePositiveInt(v, "f"));
    }
  });
  it("optional passes through undefined/null", () => {
    expect(optionalPositiveInt(undefined, "f")).toBeUndefined();
    expect(optionalPositiveInt(null, "f")).toBeUndefined();
    expect(optionalPositiveInt(10, "f")).toBe(10);
    expect400(() => optionalPositiveInt(0, "f"));
  });
});

describe("optionalBoolean()", () => {
  it("passes through undefined/null and accepts booleans", () => {
    expect(optionalBoolean(undefined, "f")).toBeUndefined();
    expect(optionalBoolean(null, "f")).toBeUndefined();
    expect(optionalBoolean(true, "f")).toBe(true);
    expect(optionalBoolean(false, "f")).toBe(false);
  });
  it("rejects non-booleans (incl. the string 'true')", () => {
    for (const v of ["true", 1, 0, {}]) expect400(() => optionalBoolean(v, "f"));
  });
});

describe("optionalStringArray()", () => {
  it("passes through undefined/null and accepts string arrays", () => {
    expect(optionalStringArray(undefined, "f")).toBeUndefined();
    expect(optionalStringArray([], "f")).toEqual([]);
    expect(optionalStringArray(["a", "b"], "f")).toEqual(["a", "b"]);
  });
  it("rejects a bare string or arrays with non-string members", () => {
    for (const v of ["a", [1], ["a", 2], {}]) expect400(() => optionalStringArray(v, "f"));
  });
});

describe("assertOneOf()", () => {
  const allowed = ["TEXT", "INTEGER", "REAL"] as const;
  it("accepts a member of the set", () => {
    expect(assertOneOf("TEXT", allowed, "type")).toBe("TEXT");
  });
  it("rejects a non-member or non-string", () => {
    for (const v of ["VARCHAR", "text", 5, undefined])
      expect400(() => assertOneOf(v, allowed, "type"));
  });
});

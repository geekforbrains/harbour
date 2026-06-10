import { describe, it, expect } from "vitest";
import { pairToolEvents } from "@/lib/captain/tool-events";

// Captain output events stream as 'tool_start' (tool_name + input JSON in
// content) followed later by a matching 'tool_end' (output in content).
// pairToolEvents is the single pure pairing function shared by the finalized
// and streaming tool-call renderers — these tests lock its contract.

type OutputEvent = {
  id: number;
  event_type: string;
  content: string | null;
  tool_name: string | null;
};

let nextId = 1;
function evt(
  event_type: string,
  content: string | null = null,
  tool_name: string | null = null
): OutputEvent {
  return { id: nextId++, event_type, content, tool_name };
}

describe("pairToolEvents", () => {
  it("pairs a tool_start with the next tool_end", () => {
    const start = evt("tool_start", '{"command":"ls"}', "Bash");
    const end = evt("tool_end", "file1\nfile2");

    const calls = pairToolEvents([start, end]);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      id: start.id,
      name: "Bash",
      input: '{"command":"ls"}',
      output: "file1\nfile2",
      active: false,
    });
  });

  it("pairs multiple sequential tool calls in order", () => {
    const start1 = evt("tool_start", '{"command":"ls"}', "Bash");
    const end1 = evt("tool_end", "output one");
    const start2 = evt("tool_start", '{"path":"/tmp/x"}', "Read");
    const end2 = evt("tool_end", "output two");

    const calls = pairToolEvents([start1, end1, start2, end2]);

    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      id: start1.id,
      name: "Bash",
      input: '{"command":"ls"}',
      output: "output one",
      active: false,
    });
    expect(calls[1]).toMatchObject({
      id: start2.id,
      name: "Read",
      input: '{"path":"/tmp/x"}',
      output: "output two",
      active: false,
    });
  });

  it("marks an unmatched tool_start active when streaming", () => {
    const start = evt("tool_start", '{"command":"sleep 10"}', "Bash");

    const calls = pairToolEvents([start], true);

    expect(calls).toHaveLength(1);
    expect(calls[0].output).toBeNull();
    expect(calls[0].active).toBe(true);
  });

  it("never marks an unmatched tool_start active when not streaming", () => {
    const start = evt("tool_start", '{"command":"sleep 10"}', "Bash");

    expect(pairToolEvents([start], false)[0].active).toBe(false);
    // streaming defaults to false when omitted
    expect(pairToolEvents([start])[0].active).toBe(false);
  });

  it("does not mark completed pairs active even when streaming", () => {
    const start = evt("tool_start", '{"command":"ls"}', "Bash");
    const end = evt("tool_end", "done");

    const calls = pairToolEvents([start, end], true);

    expect(calls).toHaveLength(1);
    expect(calls[0].active).toBe(false);
    expect(calls[0].output).toBe("done");
  });

  it("falls back to 'Tool' when tool_name is null", () => {
    const start = evt("tool_start", "{}", null);
    const end = evt("tool_end", "ok");

    const calls = pairToolEvents([start, end]);

    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe("Tool");
  });

  it("ignores non-tool event types", () => {
    const start = evt("tool_start", '{"command":"ls"}', "Bash");
    const end = evt("tool_end", "listing");
    const events = [
      evt("text_delta", "Hello"),
      evt("thinking", "hmm"),
      start,
      evt("info", "running"),
      end,
      evt("result", "all done"),
      evt("error", "oops"),
    ];

    const calls = pairToolEvents(events);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      id: start.id,
      name: "Bash",
      input: '{"command":"ls"}',
      output: "listing",
    });
  });

  it("returns [] for empty input", () => {
    expect(pairToolEvents([])).toEqual([]);
  });

  it("returns [] when there are no tool events", () => {
    const events = [evt("text_delta", "Hello"), evt("result", "done")];
    expect(pairToolEvents(events)).toEqual([]);
    expect(pairToolEvents(events, true)).toEqual([]);
  });
});

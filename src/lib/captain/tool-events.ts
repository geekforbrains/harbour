// Pure pairing logic for Captain tool-call output events. No React — shared
// by the finalized-message and live-streaming renderers in captain-message.tsx
// so the pairing rules can never drift between the two paths.

type OutputEvent = {
  id: number;
  event_type: string;
  content: string | null;
  tool_name: string | null;
};

export type ToolCall = {
  id: number;
  name: string;
  input: string | null;
  output: string | null;
  active: boolean;
};

/**
 * Pair Captain output events into tool calls. Tool events stream as
 * 'tool_start' (tool_name + input JSON in content) followed later by a
 * matching 'tool_end' (output in content) — each start is paired with the
 * next end after it. All other event types are ignored.
 *
 *   id     — the tool_start event id (stable React key)
 *   name   — tool_name, falling back to "Tool"
 *   input  — the tool_start content
 *   output — the paired tool_end content, or null if none yet
 *   active — true only while streaming with no tool_end yet (in flight)
 */
export function pairToolEvents(events: OutputEvent[], streaming = false): ToolCall[] {
  const calls: ToolCall[] = [];
  let i = 0;
  while (i < events.length) {
    const evt = events[i];
    if (evt.event_type === "tool_start") {
      const endIdx = events.findIndex((e, j) => j > i && e.event_type === "tool_end");
      const hasEnd = endIdx >= 0;
      calls.push({
        id: evt.id,
        name: evt.tool_name || "Tool",
        input: evt.content,
        output: hasEnd ? events[endIdx].content : null,
        active: streaming && !hasEnd,
      });
      i = hasEnd ? endIdx + 1 : i + 1;
    } else {
      i++;
    }
  }
  return calls;
}

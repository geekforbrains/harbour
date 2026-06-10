// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import "@testing-library/jest-dom/vitest";
import { StreamingOutput, ToolCalls } from "@/components/app/captain-message";

// ToolCalls is the single collapsible tool-call summary used both for
// finalized messages and live streaming: the only thing visible by default is
// one "N tool calls" line (or "Running <tool>..." while a tool is in flight),
// expandable to the full ToolBlock list. These tests lock that behavior so
// the view never reverts to dumping every tool block inline.

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
  tool_name: string | null = null,
): OutputEvent {
  return { id: nextId++, event_type, content, tool_name };
}

function twoCompletePairs(): OutputEvent[] {
  return [
    evt("tool_start", '{"command":"ls"}', "Bash"),
    evt("tool_end", "OUTPUT_ALPHA"),
    evt("tool_start", '{"path":"/tmp/x"}', "Read"),
    evt("tool_end", "OUTPUT_BETA"),
  ];
}

describe("ToolCalls", () => {
  it("renders nothing when there are no tool calls", () => {
    const { container } = render(
      <ToolCalls toolEvents={[evt("text_delta", "Hello"), evt("result", "done")]} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("is collapsed by default — summary visible, tool output hidden", () => {
    render(<ToolCalls toolEvents={twoCompletePairs()} />);

    expect(screen.getByText("2 tool calls")).toBeInTheDocument();
    expect(screen.queryByText(/OUTPUT_ALPHA/)).not.toBeInTheDocument();
    expect(screen.queryByText(/OUTPUT_BETA/)).not.toBeInTheDocument();
  });

  it("uses the singular form for a single tool call", () => {
    render(
      <ToolCalls
        toolEvents={[
          evt("tool_start", '{"command":"ls"}', "Bash"),
          evt("tool_end", "OUTPUT_ALPHA"),
        ]}
      />,
    );

    expect(screen.getByText("1 tool call")).toBeInTheDocument();
    expect(screen.queryByText(/OUTPUT_ALPHA/)).not.toBeInTheDocument();
  });

  it("expands on click to show the tool blocks, and collapses again", () => {
    render(<ToolCalls toolEvents={twoCompletePairs()} />);

    const summary = screen.getByRole("button", { name: /2 tool calls/ });

    // Expand: tool names become visible
    fireEvent.click(summary);
    expect(screen.getByText("Bash")).toBeInTheDocument();
    expect(screen.getByText("Read")).toBeInTheDocument();

    // Collapse: back to just the summary line
    fireEvent.click(summary);
    expect(screen.queryByText("Bash")).not.toBeInTheDocument();
    expect(screen.queryByText("Read")).not.toBeInTheDocument();
    expect(screen.getByText("2 tool calls")).toBeInTheDocument();
  });

  it("shows a 'Running <tool>...' summary while streaming with an unfinished tool, still collapsed", () => {
    const events = [
      evt("tool_start", '{"command":"ls"}', "Read"),
      evt("tool_end", "OUTPUT_ALPHA"),
      evt("tool_start", '{"command":"sleep 10"}', "Bash"),
      // no tool_end for Bash — it's in flight
    ];
    render(<ToolCalls toolEvents={events} streaming />);

    expect(screen.getByText(/Running Bash/)).toBeInTheDocument();
    // Still collapsed: no tool block content (inputs/outputs) in the document
    expect(screen.queryByText(/sleep 10/)).not.toBeInTheDocument();
    expect(screen.queryByText(/OUTPUT_ALPHA/)).not.toBeInTheDocument();
  });

  it("shows the plain count summary while streaming when all tools have finished", () => {
    render(<ToolCalls toolEvents={twoCompletePairs()} streaming />);

    expect(screen.getByText("2 tool calls")).toBeInTheDocument();
    expect(screen.queryByText(/Running/)).not.toBeInTheDocument();
    expect(screen.queryByText(/OUTPUT_ALPHA/)).not.toBeInTheDocument();
  });
});

describe("StreamingOutput", () => {
  it("renders markdown text with tool calls collapsed behind the summary", () => {
    const events = [
      evt("text_delta", "Hello from "),
      evt("text_delta", "the captain"),
      ...twoCompletePairs(),
    ];
    render(<StreamingOutput events={events} streaming={true} />);

    // Prose renders
    expect(screen.getByText(/Hello from the captain/)).toBeInTheDocument();
    // Tool output is NOT dumped inline by default
    expect(screen.queryByText(/OUTPUT_ALPHA/)).not.toBeInTheDocument();
    expect(screen.queryByText(/OUTPUT_BETA/)).not.toBeInTheDocument();
    // The single collapsed summary line is there instead
    expect(screen.getByText("2 tool calls")).toBeInTheDocument();
  });
});

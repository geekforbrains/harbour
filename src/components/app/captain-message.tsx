"use client";

import { useState, useMemo, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ChevronDown, ChevronRight, Loader2, Check, Wrench } from "lucide-react";
import { pairToolEvents } from "@/lib/captain/tool-events";

type OutputEvent = {
  id: number;
  event_type: string;
  content: string | null;
  tool_name: string | null;
};

// ── Thinking messages ───────────────────────────────────────────────────

const THINKING_MESSAGES = [
  "Charting a course...",
  "Raising the anchor...",
  "Checking the compass...",
  "Scanning the horizon...",
  "Reading the star charts...",
  "Adjusting the sails...",
  "Consulting the logbook...",
  "Plotting coordinates...",
  "Hoisting the mainsail...",
  "Navigating the channels...",
  "Sounding the depths...",
  "Catching the trade winds...",
  "Tying the bowline...",
  "Signaling the fleet...",
  "Loading the cargo hold...",
  "Swabbing the quarterdeck...",
  "Trimming the jib...",
  "Battening the hatches...",
  "Setting the watch...",
  "Unfurling the charts...",
  "Polishing the spyglass...",
  "Calibrating instruments...",
  "Logging the voyage...",
  "Rigging the topgallant...",
  "Reading the tides...",
  "Stowing the provisions...",
  "Manning the helm...",
  "Splicing the mainbrace...",
  "Weighing anchor...",
  "Lashing the capstan...",
];

function useThinkingMessage() {
  const [index, setIndex] = useState(() => Math.floor(Math.random() * THINKING_MESSAGES.length));
  useEffect(() => {
    const timer = setInterval(() => {
      setIndex((prev) => (prev + 1) % THINKING_MESSAGES.length);
    }, 2000);
    return () => clearInterval(timer);
  }, []);
  return THINKING_MESSAGES[index];
}

function ThinkingIndicator() {
  const message = useThinkingMessage();
  return (
    <div className="flex items-center gap-2 text-muted-foreground">
      <Loader2 className="h-3.5 w-3.5 animate-spin" />
      <span>{message}</span>
    </div>
  );
}

// ── Single tool block ──────────────────────────────────────────────────

function ToolBlock({
  name,
  input,
  output,
  active,
  defaultOpen = false,
}: {
  name: string;
  input: string | null;
  output: string | null;
  active: boolean;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);

  // Build a one-line preview of the output
  const outputPreview = useMemo(() => {
    if (!output) return null;
    const firstLine = output.split("\n").find((l) => l.trim()) || "";
    return firstLine.length > 120 ? firstLine.slice(0, 120) + "..." : firstLine;
  }, [output]);

  return (
    <div className="rounded border border-border bg-muted/30 text-xs font-mono overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 w-full px-2.5 py-1.5 text-left hover:bg-muted/50 transition-colors"
      >
        {active ? (
          <Loader2 className="h-3 w-3 text-amber-500 animate-spin shrink-0" />
        ) : (
          <Check className="h-3 w-3 text-emerald-500 shrink-0" />
        )}
        <span className="text-foreground font-semibold shrink-0">{name}</span>
        {input && (
          <span className="text-muted-foreground truncate">
            {input.length > 80 ? input.slice(0, 80) + "..." : input}
          </span>
        )}
        <span className="ml-auto shrink-0 text-muted-foreground">
          {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        </span>
      </button>
      {!open && outputPreview && (
        <div className="px-2.5 pb-1.5 text-muted-foreground/70 truncate">
          {outputPreview}
        </div>
      )}
      {open && output && (
        <div className="px-2.5 py-2 border-t border-border text-muted-foreground whitespace-pre-wrap max-h-60 overflow-y-auto">
          {output}
        </div>
      )}
    </div>
  );
}

// ── Collapsible tool-call summary ────────────────────────────────────────

// Single tool-call renderer for both finalized messages and live streaming.
// Collapsed by default: the only thing visible is one summary line — a plain
// "N tool calls" count, or "Running <tool>..." while a tool is in flight.
// Clicking it expands the full ToolBlock list.
export function ToolCalls({
  toolEvents,
  streaming = false,
}: {
  toolEvents: OutputEvent[];
  streaming?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);

  const calls = useMemo(
    () => pairToolEvents(toolEvents, streaming),
    [toolEvents, streaming]
  );

  if (calls.length === 0) return null;

  const activeCall = [...calls].reverse().find((c) => c.active);

  return (
    <div className="mt-3">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors mb-1.5"
      >
        {activeCall ? (
          <>
            <Loader2 className="h-3 w-3 text-amber-500 animate-spin shrink-0" />
            <span>Running {activeCall.name}...</span>
          </>
        ) : (
          <Wrench className="h-3 w-3" />
        )}
        <span>{calls.length} tool call{calls.length !== 1 ? "s" : ""}</span>
        {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
      </button>
      {expanded && (
        <div className="space-y-1">
          {calls.map((call) => (
            <ToolBlock
              key={call.id}
              name={call.name}
              input={call.input}
              output={call.output}
              active={call.active}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Streaming output ────────────────────────────────────────────────────

export function StreamingOutput({
  events,
  streaming,
}: {
  events: OutputEvent[];
  streaming: boolean;
}) {
  const textContent = useMemo(
    () =>
      events
        .filter((e) => e.event_type === "text_delta")
        .map((e) => e.content || "")
        .join(""),
    [events]
  );

  const errorEvents = events.filter((e) => e.event_type === "error");

  return (
    <div className="text-sm">
      {/* Text content or thinking indicator */}
      {textContent ? (
        <div className="prose prose-sm dark:prose-invert max-w-none">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{textContent}</ReactMarkdown>
        </div>
      ) : streaming ? (
        <ThinkingIndicator />
      ) : null}

      {/* Errors only — info/result are noise in chat context */}
      {errorEvents.map((evt) => (
        <div key={evt.id} className="text-xs text-red-500 mt-1">
          {evt.content}
        </div>
      ))}

      {/* Tool calls collapsed behind a single summary line at the bottom */}
      <ToolCalls toolEvents={events} streaming={streaming} />
    </div>
  );
}

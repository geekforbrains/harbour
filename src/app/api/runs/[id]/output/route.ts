import { NextResponse } from "next/server";
import { withResourceAuth, withRunExecutorOrUser } from "@/lib/auth";
import { addRunOutput, getRunById, isKillRequested, listRunOutput } from "@/lib/db/queries";
import { badRequest } from "@/lib/http";

export const GET = withResourceAuth("run", "id", { role: "viewer" })(
  async (req, _auth, { params }) => {
    const { id } = await params;
    const run = getRunById(id);
    if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });

    const afterId = parseInt(req.nextUrl.searchParams.get("after") || "0", 10);
    return NextResponse.json(listRunOutput(id, afterId));
  },
);

// Only the run's executor streams CLI output; users read it via GET / the SSE
// stream. The exec token binds the caller to this run, so no further check.
export const POST = withRunExecutorOrUser(
  async (req, auth, { params }) => {
    const { id } = await params;
    const run = getRunById(id);
    if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });

    if (auth.type !== "executor") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // The runner flushes a top-level JSON array (a batch); a single object is
    // also accepted. readJson() rejects top-level arrays, so this route parses
    // the body itself but still turns a malformed/non-array-non-object body into
    // a clean 400 rather than a 500.
    let parsed: unknown;
    try {
      const text = await req.text();
      parsed = text.trim() === "" ? [] : JSON.parse(text);
    } catch {
      badRequest("Invalid JSON body");
    }
    const rawEvents = Array.isArray(parsed) ? parsed : [parsed];

    // Each event must be an object carrying a non-empty `event_type` string.
    const events = rawEvents.map((e) => {
      if (e === null || typeof e !== "object" || Array.isArray(e)) {
        badRequest("each output event must be a JSON object");
      }
      const evt = e as Record<string, unknown>;
      if (typeof evt.event_type !== "string" || evt.event_type === "") {
        badRequest("event_type is required for each event");
      }
      if (evt.content !== undefined && evt.content !== null && typeof evt.content !== "string") {
        badRequest("content must be a string");
      }
      if (
        evt.tool_name !== undefined &&
        evt.tool_name !== null &&
        typeof evt.tool_name !== "string"
      ) {
        badRequest("tool_name must be a string");
      }
      return evt as { event_type: string; content?: string | null; tool_name?: string | null };
    });

    if (events.length === 0) {
      return NextResponse.json({ error: "event_type is required for each event" }, { status: 400 });
    }

    addRunOutput(
      id,
      events.map((e) => ({
        event_type: e.event_type,
        content: e.content || null,
        tool_name: e.tool_name || null,
      })),
    );

    // Piggyback the kill signal onto the runner's frequent output POSTs.
    return NextResponse.json({ ok: true, kill_requested: isKillRequested(id) }, { status: 201 });
  },
  { role: "editor" },
);

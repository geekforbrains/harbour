import { withAuthenticatedUser } from "@/lib/auth";
import { getRunById, listRunOutput } from "@/lib/db/queries";

export const dynamic = "force-dynamic";

export const GET = withAuthenticatedUser(async (req, _auth, { params }) => {
  const { id } = await params;
  const run = getRunById(id);
  if (!run) {
    return new Response("Run not found", { status: 404 });
  }

  const encoder = new TextEncoder();
  let lastId = parseInt(req.nextUrl.searchParams.get("after") || "0", 10);
  let closed = false;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          closed = true;
        }
      };

      // Poll the DB for new output events
      const poll = () => {
        if (closed) return;
        try {
          const events = listRunOutput(id, lastId);
          for (const evt of events) {
            send("output", evt);
            if (evt.id && evt.id > lastId) lastId = evt.id;
          }

          // Check if run is finished
          const currentRun = getRunById(id);
          if (
            currentRun &&
            (currentRun.status === "done" ||
              currentRun.status === "failed" ||
              currentRun.status === "skipped" ||
              currentRun.status === "killed")
          ) {
            // Send any final events, then close
            send("status", { status: currentRun.status });
            send("done", {});
            try {
              controller.close();
            } catch {
              /* already closed */
            }
            closed = true;
            return;
          }
        } catch {
          closed = true;
          try {
            controller.close();
          } catch {
            /* already closed */
          }
          return;
        }

        if (!closed) setTimeout(poll, 500);
      };

      poll();
    },
    cancel() {
      closed = true;
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
});

import { withOrgAuth } from "@/lib/auth";
import { isRunning } from "@/lib/captain/process-manager";
import { getConversation, listCaptainOutput } from "@/lib/db/captain";

export const dynamic = "force-dynamic";

export const GET = withOrgAuth(
  async (req, auth, { params }) => {
    const { id } = await params;
    const conversation = getConversation(id, auth.orgId);
    if (!conversation || conversation.user_id !== auth.userId) {
      return new Response("Not found", { status: 404 });
    }

    const encoder = new TextEncoder();
    let lastId = parseInt(req.nextUrl.searchParams.get("after") || "0", 10);
    const messageId = req.nextUrl.searchParams.get("messageId") || undefined;
    let closed = false;

    const stream = new ReadableStream({
      async start(controller) {
        const send = (event: string, data: unknown) => {
          if (closed) return;
          try {
            controller.enqueue(
              encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
            );
          } catch {
            closed = true;
          }
        };

        const poll = () => {
          if (closed) return;
          try {
            const events = listCaptainOutput(id, lastId, messageId);
            for (const evt of events) {
              send("output", evt);
              if (evt.id > lastId) lastId = evt.id;
            }

            if (!isRunning(id)) {
              const remaining = listCaptainOutput(id, lastId, messageId);
              for (const evt of remaining) {
                send("output", evt);
              }
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

          if (!closed) setTimeout(poll, 300);
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
  },
  { role: "viewer" },
);

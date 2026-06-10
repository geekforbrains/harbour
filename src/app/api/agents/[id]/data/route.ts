import { NextResponse } from "next/server";
import { withAgentOrUser } from "@/lib/auth";
import { orgIdForResource } from "@/lib/db/access";
import {
  createDatabase,
  getAgentById,
  getDatabaseByName,
  insertRows,
  linkDatabaseToJob,
} from "@/lib/db/queries";

// POST: Agent creates a database and optionally links it to a job + inserts initial rows.
// Convenience endpoint for agents — combines create + link + seed in one call.
export const POST = withAgentOrUser(
  async (req, auth, { params }) => {
    const { id } = await params;
    const agent = getAgentById(id);
    if (!agent) return NextResponse.json({ error: "Agent not found" }, { status: 404 });

    // Agents may only act on their own agent record (GUIDE: agents act on their
    // own work). Users are already authorized at org scope by the wrapper.
    if (auth.type === "agent" && auth.agentId !== id) {
      return NextResponse.json({ error: "Agent not found" }, { status: 404 });
    }

    const body = await req.json();
    if (!body.name) return NextResponse.json({ error: "name is required" }, { status: 400 });

    try {
      // Get or create the database (scoped to the agent's org + project).
      let db = getDatabaseByName(auth.orgId, agent.project_id, body.name);
      const created = !db;
      if (!db) {
        if (!body.columns?.length) {
          return NextResponse.json(
            { error: "columns are required when creating a new database" },
            { status: 400 },
          );
        }
        db = createDatabase(auth.orgId, agent.project_id, body.name, body.columns);
      }

      if (body.jobId) {
        // The target job must live in the same org — never link cross-org.
        if (orgIdForResource("job", body.jobId) !== auth.orgId) {
          return NextResponse.json({ error: "Job not found" }, { status: 404 });
        }
        linkDatabaseToJob(body.jobId, db.id);
      }

      if (body.rows?.length) {
        insertRows(db.id, body.rows);
      }

      return NextResponse.json(db, { status: created ? 201 : 200 });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return NextResponse.json({ error: message }, { status: 400 });
    }
  },
  {
    role: "editor",
    orgFromParams: (p) => orgIdForResource("agent", p.id),
  },
);

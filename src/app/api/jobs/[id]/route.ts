import { NextResponse } from "next/server";
import { withResourceAuth } from "@/lib/auth";
import { validateThinking } from "@/lib/cli-config";
import { deleteJob, getAgentById, getJobById, updateJob } from "@/lib/db/queries";
import { normalizeSchedule } from "@/lib/schedule";

export const GET = withResourceAuth("job", "id", { role: "viewer" })(
  async (_req, _auth, { params }) => {
    const { id } = await params;
    const job = getJobById(id);
    if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });
    return NextResponse.json(job);
  },
);

export const PUT = withResourceAuth("job", "id", { role: "editor" })(
  async (req, _auth, { params }) => {
    const { id } = await params;
    const existing = getJobById(id);
    if (!existing) return NextResponse.json({ error: "Job not found" }, { status: 404 });

    const body = await req.json();
    if (body.schedule) {
      const normalized = normalizeSchedule(body.schedule);
      if (!normalized) {
        return NextResponse.json(
          {
            error:
              'Invalid schedule format. Use {"every":N} for intervals or {"days":[0-6],"time":"HH:MM"} for weekly.',
          },
          { status: 400 },
        );
      }
      body.schedule = normalized;
    }
    if (body.docIds !== undefined && !Array.isArray(body.docIds)) {
      return NextResponse.json({ error: "docIds must be an array of strings" }, { status: 400 });
    }
    if (body.envVarIds !== undefined && !Array.isArray(body.envVarIds)) {
      return NextResponse.json({ error: "envVarIds must be an array of strings" }, { status: 400 });
    }
    if (body.thinking !== undefined) {
      // A thinking override rides the owning agent's CLI; workflow jobs have
      // no agent (and no CLI), so any non-empty level is rejected.
      const agent = existing.agent_id ? getAgentById(existing.agent_id) : undefined;
      const thinkingError = validateThinking(agent?.cli ?? null, body.thinking);
      if (thinkingError) return NextResponse.json({ error: thinkingError }, { status: 400 });
    }
    try {
      const updated = updateJob(id, body);
      return NextResponse.json(updated);
    } catch (error) {
      // Link guard: an org-level job may only link org-level resources.
      const message = error instanceof Error ? error.message : String(error);
      return NextResponse.json({ error: message }, { status: 400 });
    }
  },
);

export const DELETE = withResourceAuth("job", "id", { role: "editor" })(
  async (_req, _auth, { params }) => {
    const { id } = await params;
    deleteJob(id);
    return NextResponse.json({ ok: true });
  },
);

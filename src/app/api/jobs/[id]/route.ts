import { NextResponse } from "next/server";
import { withResourceAuth } from "@/lib/auth";
import { getJobById, updateJob, deleteJob } from "@/lib/db/queries";
import { normalizeSchedule } from "@/lib/schedule";

export const GET = withResourceAuth("job", "id", { role: "viewer" })(
  async (req, auth, { params }) => {
    const { id } = await params;
    const job = getJobById(id);
    if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });
    return NextResponse.json(job);
  }
);

export const PUT = withResourceAuth("job", "id", { role: "editor" })(
  async (req, auth, { params }) => {
    const { id } = await params;
    const existing = getJobById(id);
    if (!existing) return NextResponse.json({ error: "Job not found" }, { status: 404 });

    const body = await req.json();
    if (body.schedule) {
      const normalized = normalizeSchedule(body.schedule);
      if (!normalized) {
        return NextResponse.json({ error: "Invalid schedule format. Use {\"every\":N} for intervals or {\"days\":[0-6],\"time\":\"HH:MM\"} for weekly." }, { status: 400 });
      }
      body.schedule = normalized;
    }
    if (body.docIds !== undefined && !Array.isArray(body.docIds)) {
      return NextResponse.json({ error: "docIds must be an array of strings" }, { status: 400 });
    }
    if (body.envVarIds !== undefined && !Array.isArray(body.envVarIds)) {
      return NextResponse.json({ error: "envVarIds must be an array of strings" }, { status: 400 });
    }
    const updated = updateJob(id, body);
    return NextResponse.json(updated);
  }
);

export const DELETE = withResourceAuth("job", "id", { role: "editor" })(
  async (req, auth, { params }) => {
    const { id } = await params;
    deleteJob(id);
    return NextResponse.json({ ok: true });
  }
);

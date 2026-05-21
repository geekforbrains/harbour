import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth";
import { getAgentById, listJobsByAgent, createJob } from "@/lib/db/queries";
import { normalizeSchedule } from "@/lib/schedule";

export const GET = withAuth(async (req, auth, { params }) => {
  const { id } = await params;
  const agent = getAgentById(id);
  if (!agent) return NextResponse.json({ error: "Agent not found" }, { status: 404 });

  return NextResponse.json(listJobsByAgent(id));
});

export const POST = withAuth(async (req, auth, { params }) => {
  const { id } = await params;
  const agent = getAgentById(id);
  if (!agent) return NextResponse.json({ error: "Agent not found" }, { status: 404 });

  const body = await req.json();
  if (!body.name || !body.schedule) {
    return NextResponse.json({ error: "name and schedule are required" }, { status: 400 });
  }

  const normalized = normalizeSchedule(body.schedule);
  if (!normalized) {
    return NextResponse.json({ error: "Invalid schedule format. Use {\"every\":N} for intervals or {\"days\":[0-6],\"time\":\"HH:MM\"} for weekly." }, { status: 400 });
  }
  body.schedule = normalized;

  const job = createJob(id, body);
  return NextResponse.json(job, { status: 201 });
});

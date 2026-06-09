import { NextResponse } from "next/server";
import { withOrgAuth } from "@/lib/auth";
import { createWorkflowRunner, listWorkflowRunners } from "@/lib/db/queries";
import { publicBaseUrl } from "@/lib/request-url";

export const GET = withOrgAuth(
  async (_req, auth) => {
    return NextResponse.json(listWorkflowRunners(auth.orgId));
  },
  { role: "viewer" }
);

export const POST = withOrgAuth(
  async (req, auth) => {
    const body = await req.json();
    const name = String(body.name || "").trim();
    if (!name) {
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    }

    const labels = Array.isArray(body.labels) ? body.labels.map(String) : [];
    const runner = createWorkflowRunner(auth.orgId, name, { labels });
    const blob = Buffer.from(JSON.stringify({
      url: publicBaseUrl(req),
      runnerId: runner.id,
      apiKey: runner.apiKey,
      name: runner.name,
    }), "utf-8").toString("base64");

    return NextResponse.json({ ...runner, connect: `npm run harbour -- workflow connect ${blob}` }, { status: 201 });
  },
  { role: "editor" }
);

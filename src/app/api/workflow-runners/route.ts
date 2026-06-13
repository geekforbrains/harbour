import { NextResponse } from "next/server";
import { withOrgAuth } from "@/lib/auth";
import { createWorkflowRunner, listWorkflowRunners } from "@/lib/db/queries";
import { optionalStringArray, readJson, requireNonEmptyString } from "@/lib/http";
import { publicBaseUrl } from "@/lib/request-url";

export const GET = withOrgAuth(
  async (_req, auth) => {
    return NextResponse.json(listWorkflowRunners(auth.orgId));
  },
  { role: "viewer" },
);

export const POST = withOrgAuth(
  async (req, auth) => {
    const body = await readJson(req);
    const name = requireNonEmptyString(body.name, "name");
    const labels = optionalStringArray(body.labels, "labels") ?? [];
    const runner = createWorkflowRunner(auth.orgId, name, { labels });
    const blob = Buffer.from(
      JSON.stringify({
        url: publicBaseUrl(req),
        runnerId: runner.id,
        apiKey: runner.apiKey,
        name: runner.name,
      }),
      "utf-8",
    ).toString("base64");

    return NextResponse.json(
      { ...runner, connect: `npm run harbour -- workflow connect ${blob}` },
      { status: 201 },
    );
  },
  { role: "editor" },
);

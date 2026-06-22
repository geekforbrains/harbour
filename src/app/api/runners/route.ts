import { NextResponse } from "next/server";
import { withInstanceAdmin } from "@/lib/auth";
import { createRunner, listRunners, runningCountsByRunner } from "@/lib/db/queries";
import type { RunnerScope } from "@/lib/db/runners";
import { optionalStringArray, readJson, requireNonEmptyString } from "@/lib/http";
import { publicBaseUrl } from "@/lib/request-url";

// The runner registry is instance-level (execution is org-agnostic), so its
// management is instance-admin-only. The local runner is auto-provisioned at
// setup; this endpoint mints REMOTE runner credentials an operator enrolls on
// another host with `npm run harbour-agent -- connect <blob>`.

// The execution-pool view: every runner plus its in-flight slot count.
export const GET = withInstanceAdmin(async () => {
  const counts = runningCountsByRunner();
  const runners = listRunners().map((r) => ({ ...r, running_count: counts[r.id] ?? 0 }));
  return NextResponse.json(runners);
});

export const POST = withInstanceAdmin(async (req) => {
  const body = await readJson(req);
  const name = requireNonEmptyString(body.name, "name");
  const labels = optionalStringArray(body.labels, "labels") ?? [];

  // Optional scope restricts a remote token to one org and/or agent's work.
  let scope: RunnerScope = null;
  if (body.scope && typeof body.scope === "object") {
    const s = body.scope as Record<string, unknown>;
    const orgId = typeof s.orgId === "string" ? s.orgId : undefined;
    const agentId = typeof s.agentId === "string" ? s.agentId : undefined;
    if (orgId || agentId) scope = { ...(orgId && { orgId }), ...(agentId && { agentId }) };
  }

  const runner = createRunner({ name, tier: "remote", labels, scope });

  // The connect blob carries everything the remote needs (url + token + name).
  const blob = Buffer.from(
    JSON.stringify({ url: publicBaseUrl(req), token: runner.token, name: runner.name }),
    "utf-8",
  ).toString("base64");

  // Minted for the standalone remote runner (harbour-agent), which mirrors this
  // server's CLI form: `npm run harbour-agent -- connect <blob>`. A bundled
  // runner from a Harbour checkout swaps `harbour-agent` -> `harbour`.
  return NextResponse.json(
    { ...runner, connect: `npm run harbour-agent -- connect ${blob}` },
    { status: 201 },
  );
});

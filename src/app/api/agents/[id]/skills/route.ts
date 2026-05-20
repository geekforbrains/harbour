import { NextResponse } from "next/server";
import { withUserAuth } from "@/lib/auth";
import { getAgentById, getAgentSkillOverrides, setAgentSkillOverrides } from "@/lib/db/queries";

type OverrideInput = {
  skillId?: unknown;
  skill_id?: unknown;
  mode?: unknown;
};

export const GET = withUserAuth(async (_req, _auth, { params }) => {
  const { id } = await params;
  if (!getAgentById(id)) return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  return NextResponse.json(getAgentSkillOverrides(id));
});

export const PUT = withUserAuth(async (req, _auth, { params }) => {
  const { id } = await params;
  if (!getAgentById(id)) return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  const body = await req.json();
  const overrides = Array.isArray(body.overrides) ? body.overrides : [];
  const normalized = overrides
    .map((o: OverrideInput) => ({ skillId: String(o.skillId || o.skill_id || ""), mode: o.mode }))
    .filter((o: { skillId: string; mode: string }) => o.skillId && (o.mode === "include" || o.mode === "exclude"));
  return NextResponse.json(setAgentSkillOverrides(id, normalized));
});

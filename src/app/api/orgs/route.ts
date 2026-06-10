import { NextResponse } from "next/server";
import { withInstanceAdmin, withOrgAuth } from "@/lib/auth";
import { createOrg, getOrgById, getOrgSettings, updateOrg } from "@/lib/db/queries";

// Create an org. Only instance admins create orgs (they manage the instance).
// An optional `timezone` is folded into the org's `settings` JSON so a freshly
// created org carries its schedule timezone from the start.
export const POST = withInstanceAdmin(async (req) => {
  const body = await req.json().catch(() => ({}));
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }
  const settings: Record<string, unknown> = {};
  if (typeof body.timezone === "string" && body.timezone.trim()) {
    settings.timezone = body.timezone.trim();
  }
  const org = createOrg(name, settings);
  return NextResponse.json(org, { status: 201 });
});

// Org settings (e.g. timezone) live in the org's `settings` JSON. The target
// org comes from the `orgId` query param (matching the active-org scope used
// everywhere else); editor role on that org is required. Settings are merged so
// a partial update doesn't clobber unrelated keys.
export const PUT = withOrgAuth(
  async (req, auth) => {
    const body = await req.json();
    const data: { name?: string; settings?: Record<string, unknown> } = {};
    if (typeof body.name === "string") data.name = body.name;
    if (body.settings && typeof body.settings === "object") {
      data.settings = { ...getOrgSettings(auth.orgId), ...body.settings };
    }
    const org = updateOrg(auth.orgId, data) ?? getOrgById(auth.orgId);
    if (!org) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json(org);
  },
  { role: "editor" },
);

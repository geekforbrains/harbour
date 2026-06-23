import { NextResponse } from "next/server";
import { withInstanceAdmin, withOrgAuth } from "@/lib/auth";
import { createOrg, getOrgById, getOrgSettings, updateOrg } from "@/lib/db/queries";
import { optionalString, readJson, requireNonEmptyString } from "@/lib/http";
import { InvalidNameError, NameCollisionError } from "@/lib/slug";

// Create an org. Only instance admins create orgs (they manage the instance).
// An optional `timezone` is folded into the org's `settings` JSON so a freshly
// created org carries its schedule timezone from the start.
export const POST = withInstanceAdmin(async (req) => {
  const body = await readJson(req);
  const name = requireNonEmptyString(body.name, "name");
  const settings: Record<string, unknown> = {};
  const timezone = optionalString(body.timezone, "timezone");
  if (timezone?.trim()) {
    settings.timezone = timezone.trim();
  }
  try {
    const org = createOrg(name, settings);
    return NextResponse.json(org, { status: 201 });
  } catch (err) {
    if (err instanceof NameCollisionError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    if (err instanceof InvalidNameError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }
});

// Org settings (e.g. timezone) live in the org's `settings` JSON. The target
// org comes from the `orgId` query param (matching the active-org scope used
// everywhere else); editor role on that org is required. Settings are merged so
// a partial update doesn't clobber unrelated keys.
export const PUT = withOrgAuth(
  async (req, auth) => {
    const body = await readJson(req);
    const data: { name?: string; settings?: Record<string, unknown> } = {};
    const name = optionalString(body.name, "name");
    if (name !== undefined) data.name = name;
    if (body.settings !== undefined && body.settings !== null) {
      if (typeof body.settings !== "object" || Array.isArray(body.settings)) {
        return NextResponse.json({ error: "settings must be an object" }, { status: 400 });
      }
      data.settings = { ...getOrgSettings(auth.orgId), ...body.settings };
    }
    const org = updateOrg(auth.orgId, data) ?? getOrgById(auth.orgId);
    if (!org) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json(org);
  },
  { role: "editor" },
);

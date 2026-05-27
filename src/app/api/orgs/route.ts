import { NextResponse } from "next/server";
import { withOrgAuth } from "@/lib/auth";
import { getOrgById, updateOrg, getOrgSettings } from "@/lib/db/queries";

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
  { role: "editor" }
);

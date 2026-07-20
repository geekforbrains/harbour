import { NextResponse } from "next/server";
import { withAgentOrUser } from "@/lib/auth";
import { getJobById, getTableById, linkTableToJob } from "@/lib/db/queries";
import { readJson, requireNonEmptyString } from "@/lib/http";

export const POST = withAgentOrUser(async (req, _auth, { params }) => {
  const { id } = await params;
  const job = getJobById(id);
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });

  const body = await readJson(req);
  const tableId = requireNonEmptyString(body.tableId, "tableId");
  if (!getTableById(tableId)) {
    return NextResponse.json({ error: "Table not found" }, { status: 404 });
  }

  linkTableToJob(id, tableId);
  return NextResponse.json({ ok: true }, { status: 201 });
});

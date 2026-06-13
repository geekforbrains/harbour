import { NextResponse } from "next/server";
import { withAgentOrUser } from "@/lib/auth";
import { orgIdForResource } from "@/lib/db/access";
import { getJobById, triggerJobRun } from "@/lib/db/queries";
import { optionalString, readJson } from "@/lib/http";

export const POST = withAgentOrUser(
  async (req, auth, { params }) => {
    const { id } = await params;
    const job = getJobById(id);
    if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });

    // Agents may only trigger their own jobs (GUIDE: agents act on their own
    // work). Users are already authorized at org scope by the wrapper.
    if (auth.type === "agent" && job.agent_id !== auth.agentId) {
      return NextResponse.json({ error: "Job not found" }, { status: 404 });
    }

    // Empty body is fine — trigger without extra instructions.
    const body = await readJson(req);
    const extraInstructions = optionalString(body.instructions, "instructions");

    const result = triggerJobRun(id, extraInstructions);
    if (!result) return NextResponse.json({ error: "Failed to create run" }, { status: 500 });

    return NextResponse.json(result, { status: 201 });
  },
  {
    role: "editor",
    orgFromParams: (p) => orgIdForResource("job", p.id),
  },
);

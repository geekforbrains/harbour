import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { withAgentOrUser } from "@/lib/auth";
import { orgIdForResource } from "@/lib/db/access";
import { getProcessingByAttachment, getRunById } from "@/lib/db/queries";
import { uploadsDir } from "@/lib/paths";
import { publicBaseUrl } from "@/lib/request-url";

export const runtime = "nodejs";

export const GET = withAgentOrUser(
  async (req, auth, { params }) => {
    const { id, aid } = await params;
    const run = getRunById(id);
    if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });

    if (auth.type === "agent" && run.agent_id !== auth.agentId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const processing = getProcessingByAttachment(aid);
    if (!processing?.screenshots_dir) {
      return NextResponse.json({ error: "No screenshots available" }, { status: 404 });
    }

    const dir = path.join(uploadsDir(), processing.screenshots_dir);
    if (!fs.existsSync(dir)) {
      return NextResponse.json({ error: "Screenshots directory missing" }, { status: 404 });
    }

    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".jpg"))
      .sort();
    const total = files.length;

    const page = Math.max(1, parseInt(req.nextUrl.searchParams.get("page") || "1", 10) || 1);
    const limit = Math.max(1, parseInt(req.nextUrl.searchParams.get("limit") || "20", 10) || 20);
    const pages = Math.ceil(total / limit);
    const start = (page - 1) * limit;
    const slice = files.slice(start, start + limit);

    const base = publicBaseUrl(req);
    const interval = processing.screenshot_interval || 5;

    const screenshots = slice.map((_file, i) => {
      const globalIndex = start + i;
      return {
        index: globalIndex,
        timestamp: globalIndex * interval,
        url: `${base}/api/runs/${id}/attachments/${aid}/screenshots/${globalIndex}/file`,
      };
    });

    return NextResponse.json({ screenshots, total, page, pages, limit });
  },
  { role: "viewer", orgFromParams: (p) => orgIdForResource("run", p.id) },
);

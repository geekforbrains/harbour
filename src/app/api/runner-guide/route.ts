import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";

// The Runner Protocol wire contract, served live so a third-party runner can
// read exactly what the bundled runner implements. Public (like /api/guide):
// it documents how to authenticate, not a way in.
export async function GET() {
  const guidePath = path.join(process.cwd(), "docs", "runner-guide.md");
  try {
    const content = fs.readFileSync(guidePath, "utf-8");
    return new NextResponse(content, {
      headers: { "Content-Type": "text/markdown; charset=utf-8" },
    });
  } catch {
    return NextResponse.json({ error: "Runner guide not found" }, { status: 404 });
  }
}

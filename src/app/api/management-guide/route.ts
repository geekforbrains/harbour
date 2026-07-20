import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { withAuthenticatedUser } from "@/lib/auth";

export const GET = withAuthenticatedUser(async () => {
  const guidePath = path.join(process.cwd(), "docs", "management-guide.md");
  try {
    const content = fs.readFileSync(guidePath, "utf-8");
    return new NextResponse(content, {
      headers: { "Content-Type": "text/markdown; charset=utf-8" },
    });
  } catch {
    return NextResponse.json({ error: "Management guide not found" }, { status: 404 });
  }
});

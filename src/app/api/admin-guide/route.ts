import { NextResponse } from "next/server";
import { withAuthenticatedUser } from "@/lib/auth";
import fs from "fs";
import path from "path";

export const GET = withAuthenticatedUser(async () => {
  const guidePath = path.join(process.cwd(), "ADMIN_GUIDE.md");
  try {
    const content = fs.readFileSync(guidePath, "utf-8");
    return new NextResponse(content, {
      headers: { "Content-Type": "text/markdown; charset=utf-8" },
    });
  } catch {
    return NextResponse.json({ error: "Admin guide not found" }, { status: 404 });
  }
});

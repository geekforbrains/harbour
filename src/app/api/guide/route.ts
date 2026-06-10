import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";

export async function GET() {
  const guidePath = path.join(process.cwd(), "docs", "guide.md");
  try {
    const content = fs.readFileSync(guidePath, "utf-8");
    return new NextResponse(content, {
      headers: { "Content-Type": "text/markdown; charset=utf-8" },
    });
  } catch {
    return NextResponse.json({ error: "Guide not found" }, { status: 404 });
  }
}

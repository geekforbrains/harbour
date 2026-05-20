import { NextResponse } from "next/server";
import { withUserAuth } from "@/lib/auth";
import { importSkillsFromFilesystem } from "@/lib/db/queries";

export const POST = withUserAuth(async () => {
  const imported = importSkillsFromFilesystem();
  return NextResponse.json({ imported: imported.length, skills: imported });
});

import { NextResponse } from "next/server";
import { withUserAuth } from "@/lib/auth";
import { importSkillContent } from "@/lib/db/queries";
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { v4 as uuid } from "uuid";

function readSkillFromZip(file: File) {
  return file.arrayBuffer().then((buffer) => {
    const tmp = path.join(os.tmpdir(), `harbour-skill-${uuid()}.zip`);
    fs.writeFileSync(tmp, Buffer.from(buffer));
    try {
      const listing = execFileSync("unzip", ["-Z1", tmp], { encoding: "utf-8" });
      const skillPath = listing.split(/\r?\n/).find((entry) => entry.endsWith("SKILL.md"));
      if (!skillPath) {
        throw new Error("zip does not contain a SKILL.md file");
      }
      const content = execFileSync("unzip", ["-p", tmp, skillPath], { encoding: "utf-8", maxBuffer: 5 * 1024 * 1024 });
      return { content, sourcePath: skillPath };
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  });
}

export const POST = withUserAuth(async (req) => {
  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "file is required" }, { status: 400 });
  }
  const uploaded = file.name.endsWith(".zip")
    ? await readSkillFromZip(file)
    : { content: await file.text(), sourcePath: file.name };
  const { content, sourcePath } = uploaded;
  if (!content.includes("#") && !content.includes("name:")) {
    return NextResponse.json({ error: "uploaded file does not look like a skill" }, { status: 400 });
  }
  const skill = importSkillContent(content, sourcePath);
  return NextResponse.json(skill, { status: 201 });
});

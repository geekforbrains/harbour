import { NextResponse } from "next/server";
import { withAuthenticatedUser } from "@/lib/auth";
import { getAllSettings, isSettingKey, type SettingKey, setSetting } from "@/lib/db/queries";
import { readJson } from "@/lib/http";

export const GET = withAuthenticatedUser(async () => {
  return NextResponse.json(getAllSettings());
});

export const PUT = withAuthenticatedUser(async (req) => {
  const body = await readJson(req);
  const updates: [key: SettingKey, value: string][] = [];
  for (const [key, value] of Object.entries(body)) {
    if (!isSettingKey(key)) {
      return NextResponse.json({ error: `Unknown setting: ${key}` }, { status: 400 });
    }
    if (typeof value !== "string") {
      return NextResponse.json({ error: `${key} must be a string` }, { status: 400 });
    }
    updates.push([key, value]);
  }

  for (const [key, value] of updates) {
    setSetting(key, value);
  }

  return NextResponse.json(getAllSettings());
});

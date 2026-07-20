import { NextResponse } from "next/server";
import { withAuthenticatedUser } from "@/lib/auth";
import { getAllSettings, isSensitiveSetting, maskSettingValue, setSetting } from "@/lib/db/queries";
import { readJson } from "@/lib/http";

export const GET = withAuthenticatedUser(async () => {
  const settings = getAllSettings();
  for (const key of Object.keys(settings)) {
    if (isSensitiveSetting(key)) {
      settings[key] = maskSettingValue(settings[key]);
    }
  }
  return NextResponse.json(settings);
});

export const PUT = withAuthenticatedUser(async (req) => {
  const body = await readJson(req);
  for (const [key, value] of Object.entries(body)) {
    if (typeof value === "string") {
      setSetting(key, value);
    }
  }

  const settings = getAllSettings();
  for (const key of Object.keys(settings)) {
    if (isSensitiveSetting(key)) {
      settings[key] = maskSettingValue(settings[key]);
    }
  }
  return NextResponse.json(settings);
});

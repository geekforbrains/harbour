import { NextResponse } from "next/server";
import { withInstanceAdmin } from "@/lib/auth";
import { getAllSettings, setSetting, isSensitiveSetting, maskSettingValue } from "@/lib/db/queries";

export const GET = withInstanceAdmin(async () => {
  const settings = getAllSettings();
  for (const key of Object.keys(settings)) {
    if (isSensitiveSetting(key)) {
      settings[key] = maskSettingValue(settings[key]);
    }
  }
  return NextResponse.json(settings);
});

export const PUT = withInstanceAdmin(async (req) => {
  const body = await req.json();
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

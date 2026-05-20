import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth";

export const GET = withAuth(async () => {
  const timezones = Intl.supportedValuesOf("timeZone");
  return NextResponse.json(timezones);
});

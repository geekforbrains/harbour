import { NextResponse } from "next/server";
import { withAuthenticatedUser } from "@/lib/auth";

export const GET = withAuthenticatedUser(async () => {
  const timezones = Intl.supportedValuesOf("timeZone");
  return NextResponse.json(timezones);
});

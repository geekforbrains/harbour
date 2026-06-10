import { NextResponse } from "next/server";
import { withAuthenticatedUser } from "@/lib/auth";
import { maxUploadBytes, maxUploadMb } from "@/lib/paths";

export const GET = withAuthenticatedUser(async () => {
  return NextResponse.json({
    max_upload_mb: maxUploadMb(),
    max_upload_bytes: maxUploadBytes(),
  });
});

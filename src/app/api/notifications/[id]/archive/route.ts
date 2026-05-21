import { NextResponse } from "next/server";
import { withUserAuth } from "@/lib/auth";
import { archiveNotification } from "@/lib/db/queries";

export const POST = withUserAuth(async (_req, _auth, { params }) => {
  const { id } = await params;
  const notification = archiveNotification(id);
  if (!notification) return NextResponse.json({ error: "Notification not found" }, { status: 404 });
  return NextResponse.json(notification);
});

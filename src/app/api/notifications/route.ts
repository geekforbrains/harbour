import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth";
import { getUnreadNotificationCount, listNotifications } from "@/lib/db/queries";

export const GET = withAuth(async (req) => {
  const filter = req.nextUrl.searchParams.get("filter");
  if (filter === "unread-count") {
    return NextResponse.json({ count: getUnreadNotificationCount() });
  }
  if (filter === "archived") {
    return NextResponse.json(listNotifications("archived"));
  }
  if (filter === "unread") {
    return NextResponse.json(listNotifications("unread"));
  }
  return NextResponse.json(listNotifications("inbox"));
});

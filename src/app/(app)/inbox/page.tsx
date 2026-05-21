"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, Brain, ChevronDown, ChevronRight, Inbox, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { EmptyState } from "@/components/app/empty-state";
import { SectionHeader } from "@/components/app/section-header";
import { timeAgo } from "@/lib/time";
import { cn } from "@/lib/utils";

type Notification = {
  id: string;
  title: string;
  summary: string | null;
  status: "unread" | "read" | "archived";
  analysis_status: "not_started" | "analysis_pending" | "analyzed" | "failed";
  analysis_summary: string | null;
  analysis_score: number | null;
  analysis_category: "adopt" | "watch" | "ignore" | "research" | "action" | null;
  analysis_output_path: string | null;
  repo_count: number | null;
  top_score: number | null;
  keywords_json: string | null;
  categories_json: string | null;
  payload_json: string | null;
  source_run_id: string | null;
  created_at: number;
};

type Category = {
  name?: string;
  title?: string;
  keywords?: string[];
  items?: Array<{
    title?: string;
    name?: string;
    description?: string;
    keywords?: string[];
    windows?: string[];
    score?: number;
    source?: string;
    url?: string;
  }>;
};

type NotificationPayload = {
  items?: Category["items"];
};

function safeJson<T>(value: string | null): T | null {
  if (!value) return null;
  try { return JSON.parse(value) as T; } catch { return null; }
}

function analysisLabel(notification: Notification) {
  if (notification.analysis_status === "analysis_pending") return "Analysis pending";
  if (notification.analysis_status === "analyzed") {
    const score = notification.analysis_score ?? "n/a";
    const category = notification.analysis_category || "reviewed";
    return `${category} / ${score}`;
  }
  if (notification.analysis_status === "failed") return "Analysis failed";
  return "Not analyzed";
}

function NotificationCard({ notification }: { notification: Notification }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const categories = safeJson<Category[]>(notification.categories_json) || [];
  const payload = safeJson<NotificationPayload>(notification.payload_json);
  const fallbackItems = Array.isArray(payload?.items) ? payload.items : [];
  const keywords = safeJson<string[]>(notification.keywords_json) || [];

  async function markRead() {
    if (notification.status !== "unread") return;
    await fetch(`/api/notifications/${notification.id}/read`, { method: "POST" });
    queryClient.invalidateQueries({ queryKey: ["notifications"] });
    queryClient.invalidateQueries({ queryKey: ["notifications", "unread-count"] });
  }

  async function toggleOpen() {
    const next = !open;
    setOpen(next);
    if (next) await markRead();
  }

  async function archiveNotification() {
    setArchiving(true);
    try {
      await fetch(`/api/notifications/${notification.id}/archive`, { method: "POST" });
      queryClient.invalidateQueries({ queryKey: ["notifications"] });
      queryClient.invalidateQueries({ queryKey: ["notifications", "unread-count"] });
    } finally {
      setArchiving(false);
    }
  }

  return (
    <div className={cn(
      "rounded-lg border bg-card transition-colors",
      notification.status === "unread" ? "border-primary/30 bg-primary/[0.03]" : "border-border"
    )}>
      <button
        type="button"
        onClick={toggleOpen}
        className="flex w-full items-start gap-3 p-3 text-left"
      >
        <div className="mt-0.5 text-muted-foreground">
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="truncate text-sm font-medium">{notification.title}</h2>
            {notification.status === "unread" && <Badge>Unread</Badge>}
            <Badge variant="outline">{analysisLabel(notification)}</Badge>
          </div>
          <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{notification.summary || "No summary emitted."}</p>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            {notification.repo_count !== null && <span>{notification.repo_count} repos</span>}
            {notification.top_score !== null && <span>top score {notification.top_score}</span>}
            {keywords.slice(0, 6).map(keyword => <span key={keyword}>#{keyword}</span>)}
            <span>{timeAgo(notification.created_at)}</span>
          </div>
        </div>
      </button>

      {open && (
        <div className="space-y-4 border-t px-3 pb-3 pt-3">
          {categories.length > 0 ? (
            categories.map((category, index) => (
              <section key={`${category.name || category.title || "category"}-${index}`} className="space-y-2">
                <div>
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    {category.name || category.title || "Uncategorized"}
                  </h3>
                  {!!category.keywords?.length && (
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      Keywords: {category.keywords.join(", ")}
                    </p>
                  )}
                </div>
                <div className="space-y-1.5">
                  {(category.items || []).map((item, itemIndex) => (
                    <p key={`${item.title || item.name || "item"}-${itemIndex}`} className="text-sm">
                      <span className="font-medium">{item.title || item.name || "Untitled repo"}</span>
                      {" - "}
                      <span className="text-muted-foreground">{item.description || "No description."}</span>
                      <span className="text-xs text-muted-foreground">
                        {" "}keywords: {(item.keywords || []).join(", ") || "none"};
                        {" "}windows: {(item.windows || []).join(", ") || "n/a"};
                        {" "}score: {item.score ?? "n/a"};
                        {" "}source: {item.source || item.url || "n/a"}
                      </span>
                    </p>
                  ))}
                </div>
              </section>
            ))
          ) : fallbackItems.length > 0 ? (
            <div className="space-y-1.5">
              {fallbackItems.map((item, index: number) => (
                <p key={index} className="text-sm">
                  <span className="font-medium">{item.title || item.name || "Untitled"}</span>
                  {" - "}
                  <span className="text-muted-foreground">{item.description || "No description."}</span>
                </p>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No categorized one-liners were attached. Open the source run for raw output.</p>
          )}

          {notification.analysis_summary && (
            <div className="rounded-md border bg-muted/30 p-3">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Brain className="h-4 w-4" />
                BORG Synergy
              </div>
              <p className="mt-1 text-sm text-muted-foreground">{notification.analysis_summary}</p>
              {notification.analysis_output_path && (
                <p className="mt-1 text-xs text-muted-foreground">{notification.analysis_output_path}</p>
              )}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            {notification.source_run_id && (
              <Link
                href={`/runs/${notification.source_run_id}`}
                className={buttonVariants({ variant: "outline", size: "sm" })}
              >
                Open source run
              </Link>
            )}
            <Button size="sm" onClick={archiveNotification} disabled={archiving || notification.status === "archived"}>
              <Archive className="mr-1.5 h-4 w-4" />
              {archiving ? "Archiving..." : "Archive + analyze"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function InboxContent() {
  const searchParams = useSearchParams();
  const archivedView = searchParams.get("view") === "archived";
  const { data: notifications = [], isLoading } = useQuery<Notification[]>({
    queryKey: ["notifications", archivedView ? "archived" : "inbox"],
    queryFn: async () => {
      const res = await fetch(archivedView ? "/api/notifications?filter=archived" : "/api/notifications");
      return res.json();
    },
    refetchInterval: 10000,
  });

  if (isLoading) return <div className="py-12 text-center text-sm text-muted-foreground">Loading...</div>;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Inbox</h1>
        <p className="mt-1 text-sm text-muted-foreground">Notifications and intelligence briefs that need a look.</p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Link
            href="/inbox"
            className={buttonVariants({ variant: archivedView ? "outline" : "default", size: "sm" })}
          >
            Active
          </Link>
          <Link
            href="/inbox?view=archived"
            className={buttonVariants({ variant: archivedView ? "default" : "outline", size: "sm" })}
          >
            Archived
          </Link>
        </div>
      </div>

      <section>
        <SectionHeader count={notifications.length}>
          <span className="flex items-center gap-1.5">
            <Sparkles className="h-4 w-4" />
            Intelligence Briefs
          </span>
        </SectionHeader>
        {notifications.length === 0 ? (
          <EmptyState large icon={<Inbox className="h-10 w-10 text-muted-foreground/40" />}>
            {archivedView ? "No archived notifications yet." : "No notifications yet."}
          </EmptyState>
        ) : (
          <div className="space-y-2">
            {notifications.map(notification => (
              <NotificationCard key={notification.id} notification={notification} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

export default function InboxPage() {
  return (
    <Suspense fallback={<div className="py-12 text-center text-sm text-muted-foreground">Loading...</div>}>
      <InboxContent />
    </Suspense>
  );
}

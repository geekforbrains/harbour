"use client";

import { useState, useEffect, useRef } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { SectionHeader } from "@/components/app/section-header";
import { EmptyState } from "@/components/app/empty-state";
import { Textarea } from "@/components/ui/textarea";
import { BackLink } from "@/components/app/back-link";
import { Bot, User, Cog, Send, Play, CheckCheck, Terminal, RotateCcw, Ban, Film, Loader2, ChevronDown, ChevronRight, FileText, Image, Trash2, MoreVertical, Copy, Check } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { timeAgo } from "@/lib/time";
import { StatusBadge } from "@/components/app/run-status";
import { AttachmentComposer, type AttachmentComposerHandle } from "@/components/app/attachment-composer";
import { AttachmentList } from "@/components/app/attachment-display";
import type { SerializedAttachment } from "@/lib/attachments-serialize";
import { detectEmbedProvider } from "@/lib/upload-client";
import { cn } from "@/lib/utils";

const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".avi", ".mkv", ".webm", ".m4v", ".wmv", ".flv", ".ogv"]);
function isVideoAttachment(a: SerializedAttachment): boolean {
  if (a.kind !== "file") return false;
  if (a.mime_type?.startsWith("video/")) return true;
  if (!a.filename) return false;
  const ext = a.filename.slice(a.filename.lastIndexOf(".")).toLowerCase();
  return VIDEO_EXTENSIONS.has(ext);
}

type Activity = {
  id: string; run_id: string; author_type: string; author_id: string | null;
  author_name: string; content: string; created_at: number;
};

type Run = {
  id: string; job_id: string; agent_id: string | null; status: string;
  job_name: string; agent_name: string | null; agent_type: string | null; agent_cli: string | null;
  session_id: string | null; session_cwd: string | null; one_off: number; job_workflow_only: number;
  created_at: number; updated_at: number; completed_at: number | null;
  kill_requested_at: number | null;
  activity: Activity[];
  attachments: SerializedAttachment[];
};

type OutputEvent = {
  id: number;
  run_id: string;
  event_type: string;
  content: string | null;
  tool_name: string | null;
  created_at: number;
};

function AuthorIcon({ type }: { type: string }) {
  switch (type) {
    case "agent": return <Bot className="h-4 w-4" />;
    case "user": return <User className="h-4 w-4" />;
    default: return <Cog className="h-4 w-4" />;
  }
}

function LiveOutput({ runId, status, resumeCommand }: { runId: string; status: string; resumeCommand?: React.ReactNode }) {
  const [events, setEvents] = useState<OutputEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastIdRef = useRef(0);
  const isActive = status === "running" || status === "pending";

  // Load existing output events on mount, then connect SSE
  useEffect(() => {
    let cancelled = false;

    async function init() {
      // Fetch existing events first
      try {
        const res = await fetch(`/api/runs/${runId}/output`);
        if (res.ok && !cancelled) {
          const data = await res.json() as OutputEvent[];
          if (data.length > 0) {
            setEvents(data);
            lastIdRef.current = data[data.length - 1].id;
          }
        }
      } catch { /* ignore */ }

      // If run is active, connect SSE for new events
      if (!isActive || cancelled) return;

      const evtSource = new EventSource(`/api/runs/${runId}/output/stream?after=${lastIdRef.current}`);
      if (!cancelled) setConnected(true);

      evtSource.addEventListener("output", (e) => {
        if (cancelled) return;
        const evt = JSON.parse(e.data) as OutputEvent;
        // Deduplicate by ID
        if (evt.id <= lastIdRef.current) return;
        lastIdRef.current = evt.id;
        setEvents(prev => [...prev, evt]);
      });

      evtSource.addEventListener("done", () => {
        evtSource.close();
        if (!cancelled) setConnected(false);
      });

      evtSource.onerror = () => {
        evtSource.close();
        if (!cancelled) setConnected(false);
      };

      // Store cleanup ref
      cleanupRef = () => {
        evtSource.close();
        setConnected(false);
      };
    }

    let cleanupRef: (() => void) | null = null;
    init();

    return () => {
      cancelled = true;
      cleanupRef?.();
    };
  }, [runId, isActive]);

  // Auto-scroll to bottom
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [events]);

  if (events.length === 0 && !isActive && !resumeCommand) return null;

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <SectionHeader>
          <span className="flex items-center gap-1.5">
            <Terminal className="h-4 w-4" />
            Output
          </span>
        </SectionHeader>
        {connected && (
          <span className="flex items-center gap-1.5 text-xs text-emerald-500">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
            </span>
            Live
          </span>
        )}
      </div>
      {resumeCommand}
      <div
        ref={scrollRef}
        className="bg-zinc-950 rounded-lg border border-zinc-800 p-3 font-mono text-xs max-h-[500px] overflow-y-auto"
      >
        {events.length === 0 ? (
          <span className="text-zinc-500">Waiting for output...</span>
        ) : (
          events.map((evt) => (
            <OutputLine key={evt.id} event={evt} />
          ))
        )}
        {connected && (
          <span className="inline-block w-2 h-3.5 bg-emerald-500/70 animate-pulse ml-0.5" />
        )}
      </div>
    </div>
  );
}

function OutputLine({ event }: { event: OutputEvent }) {
  switch (event.event_type) {
    case "text_delta":
      return <span className="text-zinc-200 whitespace-pre-wrap">{event.content}</span>;
    case "thinking":
      return <span className="text-zinc-500 italic whitespace-pre-wrap">{event.content}</span>;
    case "tool_start":
      return (
        <div className="text-amber-400/80 mt-1.5 mb-0.5">
          <span className="text-amber-500">{">"}</span>{" "}
          {event.tool_name && <span className="font-semibold">{event.tool_name}</span>}
          {event.content && <span className="text-zinc-400 ml-1 whitespace-pre-wrap break-all">{event.content.length > 300 ? event.content.slice(0, 300) + "..." : event.content}</span>}
        </div>
      );
    case "tool_end":
      return (
        <div className="text-zinc-500 mb-1.5 pl-3 border-l border-zinc-800 whitespace-pre-wrap max-h-40 overflow-y-auto">
          {event.content ? (event.content.length > 500 ? event.content.slice(0, 500) + "..." : event.content) : "(done)"}
        </div>
      );
    case "info":
      return (
        <div className="text-blue-400/70 mb-1">
          {event.content}
        </div>
      );
    case "result":
      return (
        <div className="text-zinc-500 mt-2 pt-1.5 border-t border-zinc-800">
          {event.content}
        </div>
      );
    case "error":
      return (
        <div className="text-red-400 mt-1">
          {event.content}
        </div>
      );
    default:
      return <span className="text-zinc-400 whitespace-pre-wrap">{event.content}</span>;
  }
}

function getResumeCommand(cli: string, sessionId: string, cwd?: string | null): string {
  let resume: string;
  switch (cli) {
    case "claude": resume = `claude --resume ${sessionId}`; break;
    case "codex": resume = `codex exec resume ${sessionId}`; break;
    case "gemini": resume = `gemini --resume ${sessionId}`; break;
    default: resume = `${cli} --resume ${sessionId}`;
  }
  return cwd ? `cd ${cwd} && ${resume}` : resume;
}

function ResumeCommand({ cli, sessionId, cwd }: { cli: string; sessionId: string; cwd?: string | null }) {
  const [copied, setCopied] = useState(false);
  const command = getResumeCommand(cli, sessionId, cwd);

  function handleCopy() {
    navigator.clipboard.writeText(command);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="flex items-center gap-2 rounded-lg bg-muted px-3 py-2 font-mono text-xs">
      <Terminal className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
      <code className="flex-1 truncate text-muted-foreground select-all">{command}</code>
      <button
        onClick={handleCopy}
        className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
        title="Copy to clipboard"
      >
        {copied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
    </div>
  );
}

type ProcessingRecord = {
  id: string;
  attachment_id: string;
  run_id: string;
  status: "queued" | "processing" | "done" | "failed";
  transcript_path: string | null;
  screenshots_dir: string | null;
  screenshot_count: number;
  screenshot_interval: number | null;
  duration_seconds: number | null;
  error: string | null;
};

type Screenshot = {
  index: number;
  timestamp: number;
  url: string;
};

function VideoProcessingInfo({ runId, attachment }: { runId: string; attachment: SerializedAttachment }) {
  const [triggering, setTriggering] = useState(false);
  const [screenshotsOpen, setScreenshotsOpen] = useState(false);
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const queryClient = useQueryClient();

  const { data: processing, error: procError } = useQuery<ProcessingRecord | null>({
    queryKey: ["processing", attachment.id],
    queryFn: async () => {
      const res = await fetch(`/api/runs/${runId}/attachments/${attachment.id}/processing`);
      if (res.status === 404) return null;
      if (!res.ok) return null;
      return res.json();
    },
    refetchInterval: (query) => {
      const d = query.state.data;
      if (d && (d.status === "queued" || d.status === "processing")) return 3000;
      return false;
    },
  });

  const { data: screenshotsData } = useQuery<{ screenshots: Screenshot[]; total: number; pages: number }>({
    queryKey: ["screenshots", attachment.id],
    queryFn: async () => {
      const res = await fetch(`/api/runs/${runId}/attachments/${attachment.id}/screenshots?limit=20`);
      if (!res.ok) return { screenshots: [], total: 0, pages: 0 };
      return res.json();
    },
    enabled: processing?.status === "done" && screenshotsOpen,
  });

  const { data: transcript } = useQuery<string>({
    queryKey: ["transcript", attachment.id],
    queryFn: async () => {
      const res = await fetch(`/api/runs/${runId}/attachments/${attachment.id}/transcript`);
      if (!res.ok) return "";
      return res.text();
    },
    enabled: processing?.status === "done" && !!processing?.transcript_path && transcriptOpen,
  });

  async function handleProcess() {
    setTriggering(true);
    await fetch(`/api/runs/${runId}/attachments/${attachment.id}/processing`, { method: "POST" });
    queryClient.invalidateQueries({ queryKey: ["processing", attachment.id] });
    setTriggering(false);
  }

  if (processing === undefined && !procError) return null;

  if (!processing) {
    return (
      <div className="mt-1">
        <Button variant="outline" size="sm" onClick={handleProcess} disabled={triggering}>
          <Film className="h-3.5 w-3.5 mr-1.5" />
          {triggering ? "Queuing..." : "Process"}
        </Button>
      </div>
    );
  }

  if (processing.status === "queued" || processing.status === "processing") {
    return (
      <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Processing video...
      </div>
    );
  }

  if (processing.status === "failed") {
    return (
      <div className="mt-1 space-y-1">
        <p className="text-xs text-red-600 dark:text-red-400">Processing failed{processing.error ? `: ${processing.error}` : ""}</p>
        <Button variant="outline" size="sm" onClick={handleProcess} disabled={triggering}>
          <RotateCcw className="h-3.5 w-3.5 mr-1.5" />
          {triggering ? "Queuing..." : "Retry"}
        </Button>
      </div>
    );
  }

  return (
    <div className="mt-1 space-y-1">
      {processing.screenshot_count > 0 && (
        <div>
          <button
            onClick={() => setScreenshotsOpen(v => !v)}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            {screenshotsOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            <Image className="h-3 w-3" />
            {processing.screenshot_count} screenshot{processing.screenshot_count !== 1 ? "s" : ""}
          </button>
          {screenshotsOpen && screenshotsData && (
            <div className="flex gap-1.5 mt-1.5 overflow-x-auto pb-1">
              {screenshotsData.screenshots.map(s => (
                <a key={s.index} href={s.url} target="_blank" rel="noreferrer" className="shrink-0">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={s.url}
                    alt={`Screenshot at ${s.timestamp}s`}
                    className="h-16 w-auto rounded border hover:border-primary transition-colors"
                  />
                </a>
              ))}
              {screenshotsData.pages > 1 && (
                <span className="flex items-center text-xs text-muted-foreground px-2 shrink-0">
                  +{screenshotsData.total - screenshotsData.screenshots.length} more
                </span>
              )}
            </div>
          )}
        </div>
      )}
      {processing.transcript_path && (
        <div>
          <button
            onClick={() => setTranscriptOpen(v => !v)}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            {transcriptOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            <FileText className="h-3 w-3" />
            Transcript
          </button>
          {transcriptOpen && transcript !== undefined && (
            <pre className="mt-1.5 text-xs bg-muted rounded-md border p-3 max-h-64 overflow-y-auto whitespace-pre-wrap">{transcript || "No transcript content."}</pre>
          )}
        </div>
      )}
    </div>
  );
}

const MANAGEABLE_STATUSES = ["waiting", "done", "failed", "skipped", "killed"];
export default function RunDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [killing, setKilling] = useState(false);
  const [dragging, setDragging] = useState(false);
  const composerRef = useRef<AttachmentComposerHandle>(null);

  const { data: run = null, isLoading: loading } = useQuery<Run | null>({
    queryKey: ["runs", id],
    queryFn: async () => {
      const res = await fetch(`/api/runs/${id}`);
      if (!res.ok) return null;
      return res.json();
    },
    refetchInterval: 5000,
  });

  // Clear local killing state once the runner finalizes and the run is no
  // longer 'running' — keeps the button honest across refreshes.
  useEffect(() => {
    if (run && run.status !== "running") setKilling(false);
  }, [run?.status]);

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    const attachmentIds = composerRef.current?.drain() ?? [];
    const trimmed = message.trim();
    if (!trimmed && attachmentIds.length === 0) return;

    setSending(true);
    const res = await fetch(`/api/runs/${id}/activity`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: trimmed, attachment_ids: attachmentIds }),
    });
    if (res.ok) {
      setMessage("");
      queryClient.invalidateQueries({ queryKey: ["runs", id] });
    }
    setSending(false);
  }

  function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    // Pasted image → upload as attachment
    for (const item of Array.from(e.clipboardData.items)) {
      if (item.kind === "file" && item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file) {
          e.preventDefault();
          composerRef.current?.addFiles([file]);
          return;
        }
      }
    }
    // Pasted embed URL → convert to embed attachment
    const text = e.clipboardData.getData("text").trim();
    if (text && !text.includes("\n") && detectEmbedProvider(text)) {
      e.preventDefault();
      composerRef.current?.addEmbedUrl(text);
    }
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files.length > 0) {
      composerRef.current?.addFiles(e.dataTransfer.files);
    }
  }

  async function handleRetry() {
    setRetrying(true);
    const res = await fetch(`/api/runs/${id}/retry`, { method: "POST" });
    if (res.ok) queryClient.invalidateQueries({ queryKey: ["runs", id] });
    setRetrying(false);
  }

  async function handleKill() {
    if (!confirm("Kill this run? The CLI session will be saved so you can resume it with a comment.")) return;
    setKilling(true);
    const res = await fetch(`/api/runs/${id}/kill`, { method: "POST" });
    if (res.ok) {
      queryClient.invalidateQueries({ queryKey: ["runs", id] });
    } else {
      const body = await res.json().catch(() => ({ error: "Failed to kill run" }));
      alert(body.error || "Failed to kill run");
      setKilling(false);
    }
    // Leave `killing=true` while run.kill_requested_at is set — clears when
    // the runner finalizes and status flips to 'killed'.
  }

  async function handleChangeStatus(newStatus: string) {
    const res = await fetch(`/api/runs/${id}/status`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: newStatus }),
    });
    if (res.ok) queryClient.invalidateQueries({ queryKey: ["runs", id] });
  }

  async function handleDelete() {
    if (!confirm("Delete this run? This cannot be undone.")) return;
    const res = await fetch(`/api/runs/${id}`, { method: "DELETE" });
    if (res.ok) router.push("/");
  }

  if (loading) return <div className="text-sm text-muted-foreground py-12 text-center">Loading...</div>;
  if (!run) return <div className="text-sm text-muted-foreground py-12 text-center">Run not found.</div>;

  // Kill button should only be clickable once per run — derive the visible
  // "killing" state from the server flag so it survives page refreshes too.
  const killInFlight = killing || !!run.kill_requested_at;
  const canKill = run.status === "running" && run.agent_type === "harbour";

  return (
    <div className="space-y-6">
      <BackLink href="/" label="Runs" />

      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-2">
          <h1 className="text-xl font-semibold tracking-tight">{run.job_name}</h1>
          <StatusBadge status={run.status} />
        </div>
        <div className="flex items-center gap-2">
          {canKill && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleKill}
              disabled={killInFlight}
              className="text-orange-600 dark:text-orange-400 hover:text-orange-700"
            >
              <Ban className="h-3.5 w-3.5 mr-1.5" />
              {killInFlight ? "Killing..." : "Kill"}
            </Button>
          )}
          {(run.status === "failed" || run.status === "skipped" || run.status === "killed") && (
            <Button variant="outline" size="sm" onClick={handleRetry} disabled={retrying}>
              <RotateCcw className="h-3.5 w-3.5 mr-1.5" /> {retrying ? "Retrying..." : "Retry"}
            </Button>
          )}
          {run.job_id && (
            <Link href={`/jobs/${run.job_id}`}>
              <Button variant="outline" size="sm">View Job</Button>
            </Link>
          )}
          {MANAGEABLE_STATUSES.includes(run.status) && (
            <DropdownMenu>
              <DropdownMenuTrigger className="inline-flex items-center justify-center rounded-md border border-input bg-background px-2.5 py-1.5 text-sm font-medium hover:bg-accent hover:text-accent-foreground transition-colors">
                <MoreVertical className="h-3.5 w-3.5" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {MANAGEABLE_STATUSES.filter(s => s !== run.status).map(s => (
                  <DropdownMenuItem key={s} onClick={() => handleChangeStatus(s)}>
                    Mark as {s}
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={handleDelete} className="text-red-600 dark:text-red-400">
                  <Trash2 className="h-3.5 w-3.5 mr-1.5" />
                  Delete run
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-y-3 gap-x-4 rounded-lg border p-3">
        <div className="flex items-center gap-2 text-sm">
          {run.agent_id && run.agent_name ? (
            <>
              <Bot className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <Link href={`/agents/${run.agent_id}`} className="text-muted-foreground hover:text-foreground transition-colors truncate">{run.agent_name}</Link>
            </>
          ) : (
            <>
              <Terminal className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <span className="text-muted-foreground truncate">Workflow</span>
            </>
          )}
        </div>
        <div className="flex items-center gap-2 text-sm">
          <Play className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <span className="text-muted-foreground truncate">{timeAgo(run.created_at)}</span>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <CheckCheck className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <span className="text-muted-foreground truncate">{run.completed_at ? timeAgo(run.completed_at) : "\u2014"}</span>
        </div>
      </div>

      {/* Activity Log */}
      <div className="space-y-1">
        <SectionHeader>Activity</SectionHeader>
        <div className="space-y-3">
          {run.activity.length === 0 ? (
            <EmptyState>No activity yet.</EmptyState>
          ) : (
            run.activity.map(entry => {
              const entryAttachments = (run.attachments ?? []).filter(a => a.activity_id === entry.id);
              return (
                <div key={entry.id} className={`flex gap-3 ${entry.author_type === "system" ? "opacity-60" : ""}`}>
                  <div className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full mt-0.5 ${
                    entry.author_type === "agent" ? "bg-primary/10 text-primary" :
                    entry.author_type === "user" ? "bg-blue-500/10 text-blue-600 dark:text-blue-400" :
                    "bg-muted text-muted-foreground"
                  }`}>
                    <AuthorIcon type={entry.author_type} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{entry.author_name}</span>
                      <span className="text-xs text-muted-foreground">{timeAgo(entry.created_at)}</span>
                    </div>
                    {entry.content && (
                      <div className="prose prose-sm dark:prose-invert max-w-none mt-0.5 text-sm">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{entry.content}</ReactMarkdown>
                      </div>
                    )}
                    <AttachmentList items={entryAttachments} />
                    {entryAttachments.filter(a => isVideoAttachment(a)).map(a => (
                      <VideoProcessingInfo key={`proc-${a.id}`} runId={id} attachment={a} />
                    ))}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* Agent-uploaded attachments (no activity_id) */}
      {(() => {
        const orphaned = (run.attachments ?? []).filter(a => a.activity_id === null);
        if (!orphaned.length) return null;
        return (
          <div className="space-y-1">
            <SectionHeader>Attachments</SectionHeader>
            <AttachmentList items={orphaned} />
            {orphaned.filter(a => isVideoAttachment(a)).map(a => (
              <VideoProcessingInfo key={`proc-${a.id}`} runId={id} attachment={a} />
            ))}
          </div>
        );
      })()}

      {/* Reply Form (waiting, pending, done, failed — but not running) */}
      {(run.status !== "running" && run.status !== "scheduled" && run.status !== "skipped") && (
        <form
          onSubmit={handleSend}
          className={cn(
            "space-y-2 rounded-lg border border-transparent transition-colors",
            dragging && "border-primary/60 bg-primary/5",
          )}
          onDragOver={e => { e.preventDefault(); setDragging(true); }}
          onDragLeave={e => {
            // Only clear when leaving the form entirely, not crossing child nodes
            if (e.currentTarget === e.target) setDragging(false);
          }}
          onDrop={handleDrop}
        >
          <Textarea
            value={message}
            onChange={e => setMessage(e.target.value)}
            onPaste={handlePaste}
            placeholder="Type a response — or drop / paste files & embed URLs..."
            rows={3}
            onKeyDown={e => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                handleSend(e);
              }
            }}
          />
          <AttachmentComposer ref={composerRef} runId={id} />
          <div className="flex justify-end">
            <Button type="submit" size="sm" disabled={sending}>
              <Send className="h-3.5 w-3.5 mr-1.5" /> Send
            </Button>
          </div>
        </form>
      )}

      {/* Live Output (harbour agents only, not workflow-only runs) */}
      {run.agent_type === "harbour" && !run.job_workflow_only && (
        <LiveOutput
          runId={run.id}
          status={run.status}
          resumeCommand={run.session_id && run.agent_cli ? (
            <ResumeCommand cli={run.agent_cli} sessionId={run.session_id} cwd={run.session_cwd} />
          ) : undefined}
        />
      )}
    </div>
  );
}

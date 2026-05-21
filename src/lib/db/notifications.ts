import { getDb } from "./schema";
import { createOneOffRun } from "./jobs";
import { v4 as uuid } from "uuid";

const GITHUB_AGENT_ID = "github-trend-intelligence";
const GITHUB_JOB_ID = "github-trend-intelligence-daily";
const SYNERGY_AGENT_ID = "borg-synergy-analyst";

type RunSourceRow = {
  id: string;
  job_id: string;
  agent_id: string | null;
  job_name: string | null;
  agent_name: string | null;
};

type NotificationPayload = {
  sourceType?: string;
  type?: string;
  title?: string;
  summary?: string;
  repoCount?: number;
  topScore?: number;
  keywords?: string[];
  categories?: unknown[];
  items?: unknown[];
};

type SynergyPayload = {
  notificationId?: string;
  summary?: string;
  score?: number;
  category?: "adopt" | "watch" | "ignore" | "research" | "action";
  outputPath?: string;
};

type NotificationRow = {
  id: string;
  source_type: string;
  source_agent_id: string | null;
  source_job_id: string | null;
  source_run_id: string | null;
  title: string;
  summary: string | null;
  status: "unread" | "read" | "archived";
  analysis_status: "not_started" | "analysis_pending" | "analyzed" | "failed";
  analysis_run_id: string | null;
  analysis_summary: string | null;
  analysis_score: number | null;
  analysis_category: "adopt" | "watch" | "ignore" | "research" | "action" | null;
  analysis_output_path: string | null;
  repo_count: number | null;
  top_score: number | null;
  keywords_json: string | null;
  categories_json: string | null;
  payload_json: string | null;
};

export function listNotifications(filter: "inbox" | "archived" | "unread" = "inbox") {
  const db = getDb();
  const where = filter === "archived"
    ? "status = 'archived'"
    : filter === "unread"
      ? "status = 'unread'"
      : "status != 'archived'";
  return db.prepare(`
    SELECT *
    FROM notifications
    WHERE ${where}
    ORDER BY created_at DESC
  `).all();
}

export function getUnreadNotificationCount() {
  const db = getDb();
  const row = db.prepare(`SELECT COUNT(*) as n FROM notifications WHERE status = 'unread'`).get() as { n: number } | undefined;
  return row?.n ?? 0;
}

export function getNotificationById(id: string) {
  const db = getDb();
  return db.prepare(`SELECT * FROM notifications WHERE id = ?`).get(id) as NotificationRow | undefined || null;
}

export function markNotificationRead(id: string) {
  const db = getDb();
  db.prepare(`
    UPDATE notifications
    SET status = CASE WHEN status = 'unread' THEN 'read' ELSE status END,
        read_at = COALESCE(read_at, unixepoch()),
        updated_at = unixepoch()
    WHERE id = ?
  `).run(id);
  return getNotificationById(id);
}

export function archiveNotification(id: string) {
  const db = getDb();
  const notification = getNotificationById(id);
  if (!notification) return null;

  if (
    notification.status === "archived"
    && (notification.analysis_status === "analysis_pending" || notification.analysis_status === "analyzed")
  ) {
    return notification;
  }

  const analyst = db.prepare(`SELECT id FROM agents WHERE id = ?`).get(SYNERGY_AGENT_ID) as { id: string } | undefined;
  if (!analyst) {
    db.prepare(`
      UPDATE notifications
      SET status = 'archived',
          read_at = COALESCE(read_at, unixepoch()),
          archived_at = COALESCE(archived_at, unixepoch()),
          analysis_status = 'failed',
          analysis_summary = ?,
          updated_at = unixepoch()
      WHERE id = ?
    `).run("BORG Synergy Analyst is not synced into Harbour yet.", id);
    return getNotificationById(id);
  }

  const instructions = buildSynergyInstructions(notification);
  const run = createOneOffRun(SYNERGY_AGENT_ID, {
    name: `BORG synergy analysis - ${notification.title}`,
    instructions,
  });

  db.prepare(`
    UPDATE notifications
    SET status = 'archived',
        read_at = COALESCE(read_at, unixepoch()),
        archived_at = COALESCE(archived_at, unixepoch()),
        analysis_status = 'analysis_pending',
        analysis_run_id = ?,
        updated_at = unixepoch()
    WHERE id = ?
  `).run(run.runId, id);

  return getNotificationById(id);
}

export function ingestNotificationsForRun(runId: string, terminalStatus: string) {
  if (terminalStatus !== "done" && terminalStatus !== "failed" && terminalStatus !== "skipped") return;
  ingestGitHubBriefNotification(runId, terminalStatus);
  ingestSynergyAnalysis(runId, terminalStatus);
}

function ingestGitHubBriefNotification(runId: string, terminalStatus: string) {
  const db = getDb();
  const run = getRunSource(runId);
  if (!run) return;
  if (run.agent_id !== GITHUB_AGENT_ID && run.job_id !== GITHUB_JOB_ID) return;

  const payload = parsePayload<NotificationPayload>(collectRunText(runId), [
    "harbour-notification-json",
    "notification-json",
  ]);
  const sourceType = payload?.sourceType || payload?.type || "github_trend_intelligence";
  const existing = db.prepare(`SELECT id FROM notifications WHERE source_run_id = ? AND source_type = ?`).get(runId, sourceType);
  if (existing) return;

  const fallbackSummary = terminalStatus === "done"
    ? "GitHub trend intelligence run completed. Open the run for full output if no structured brief was emitted."
    : `GitHub trend intelligence run finished with status ${terminalStatus}.`;
  const repoCount = numberOrNull(payload?.repoCount);
  const topScore = numberOrNull(payload?.topScore);
  const title = payload?.title || `GitHub Intelligence Brief${repoCount ? ` - ${repoCount} high-signal repos` : ""}`;

  db.prepare(`
    INSERT INTO notifications (
      id, source_type, source_agent_id, source_job_id, source_run_id, title, summary,
      repo_count, top_score, keywords_json, categories_json, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    uuid(),
    sourceType,
    run.agent_id,
    run.job_id,
    runId,
    title,
    payload?.summary || fallbackSummary,
    repoCount,
    topScore,
    stringify(payload?.keywords),
    stringify(payload?.categories || payload?.items),
    payload ? JSON.stringify(payload) : null,
  );
}

function ingestSynergyAnalysis(runId: string, terminalStatus: string) {
  const db = getDb();
  const run = getRunSource(runId);
  if (!run || run.agent_id !== SYNERGY_AGENT_ID) return;

  const notification = db.prepare(`SELECT id FROM notifications WHERE analysis_run_id = ?`).get(runId) as { id: string } | undefined;
  if (!notification) return;

  const payload = parsePayload<SynergyPayload>(collectRunText(runId), [
    "harbour-synergy-analysis-json",
    "synergy-analysis-json",
  ]);

  if (!payload || terminalStatus !== "done") {
    db.prepare(`
      UPDATE notifications
      SET analysis_status = 'failed',
          analysis_summary = ?,
          updated_at = unixepoch()
      WHERE id = ?
    `).run(`Synergy analysis run finished with status ${terminalStatus} and did not emit structured analysis.`, notification.id);
    return;
  }

  db.prepare(`
    UPDATE notifications
    SET analysis_status = 'analyzed',
        analysis_summary = ?,
        analysis_score = ?,
        analysis_category = ?,
        analysis_output_path = ?,
        updated_at = unixepoch()
    WHERE id = ?
  `).run(
    payload.summary || null,
    numberOrNull(payload.score),
    validSynergyCategory(payload.category) ? payload.category : null,
    payload.outputPath || null,
    notification.id,
  );
}

function getRunSource(runId: string): RunSourceRow | null {
  const db = getDb();
  return db.prepare(`
    SELECT r.id, r.job_id, r.agent_id, j.name as job_name, a.name as agent_name
    FROM runs r
    JOIN jobs j ON j.id = r.job_id
    LEFT JOIN agents a ON a.id = r.agent_id
    WHERE r.id = ?
  `).get(runId) as RunSourceRow | undefined || null;
}

function collectRunText(runId: string) {
  const db = getDb();
  const output = db.prepare(`SELECT content FROM run_output WHERE run_id = ? AND content IS NOT NULL ORDER BY id ASC`).all(runId) as { content: string }[];
  const activity = db.prepare(`SELECT content FROM run_activity WHERE run_id = ? AND content IS NOT NULL ORDER BY created_at ASC`).all(runId) as { content: string }[];
  return [...output, ...activity].map(row => row.content).join("\n");
}

function parsePayload<T>(text: string, fenceNames: string[]): T | null {
  for (const name of fenceNames) {
    const fence = new RegExp("```" + name + "\\s*([\\s\\S]*?)```", "gi");
    let match: RegExpExecArray | null;
    while ((match = fence.exec(text))) {
      const parsed = safeJson<T>(match[1]);
      if (parsed) return parsed;
    }
  }

  const line = text.split(/\r?\n/).find(part => part.trim().startsWith("HARBOUR_NOTIFICATION_JSON:"));
  if (line) return safeJson<T>(line.replace(/^.*?HARBOUR_NOTIFICATION_JSON:\s*/, ""));
  const analysisLine = text.split(/\r?\n/).find(part => part.trim().startsWith("HARBOUR_SYNERGY_ANALYSIS_JSON:"));
  if (analysisLine) return safeJson<T>(analysisLine.replace(/^.*?HARBOUR_SYNERGY_ANALYSIS_JSON:\s*/, ""));

  return null;
}

function safeJson<T>(value: string): T | null {
  try {
    return JSON.parse(value.trim()) as T;
  } catch {
    return null;
  }
}

function numberOrNull(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringify(value: unknown) {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

function validSynergyCategory(value: unknown) {
  return value === "adopt" || value === "watch" || value === "ignore" || value === "research" || value === "action";
}

function buildSynergyInstructions(notification: NotificationRow) {
  return [
    "Analyze the archived Harbour notification for BORG/TRON synergy.",
    "",
    "Score 0-100 and choose exactly one category: adopt, watch, ignore, research, action.",
    "Evaluate fit with BORG Interface, Harbour, AgentOps, TRON BRAIN, SKILLS/toolkit libraries, Orgo VM provisioning, Graphify, local agents, and active business/project tracks.",
    "Write the durable synthesis to TRON BRAIN/research/github/synergy/ or another clearly appropriate TRON BRAIN path.",
    "",
    "Notification:",
    JSON.stringify({
      id: notification.id,
      title: notification.title,
      summary: notification.summary,
      sourceRunId: notification.source_run_id,
      repoCount: notification.repo_count,
      topScore: notification.top_score,
      keywords: parseJson(notification.keywords_json),
      categories: parseJson(notification.categories_json),
      payload: parseJson(notification.payload_json),
    }, null, 2),
    "",
    "When complete, emit this exact fenced JSON block so Harbour can update the notification:",
    "```harbour-synergy-analysis-json",
    JSON.stringify({
      notificationId: notification.id,
      summary: "One-sentence synthesis.",
      score: 0,
      category: "research",
      outputPath: "TRON BRAIN/research/github/synergy/YYYY-MM-DD-title.md",
    }, null, 2),
    "```",
  ].join("\n");
}

function parseJson(value: string | null) {
  if (!value) return null;
  try { return JSON.parse(value); } catch { return null; }
}

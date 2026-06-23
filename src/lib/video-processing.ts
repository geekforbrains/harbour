import { execFile, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { getAttachmentById } from "./db/attachments";
import { addRunActivity } from "./db/runs";
import {
  getVideoScreenshotInterval,
  getVideoTranscriptApiKey,
  getVideoTranscriptProvider,
} from "./db/settings";
import {
  createProcessingRecord,
  getProcessingByAttachment,
  updateProcessingStatus,
} from "./db/video-processing";
import { ensureDir, processedDir, uploadsDir } from "./paths";

const execFileAsync = promisify(execFile);

const TRANSCRIPT_CAP = 5000; // chars inlined in the runner claim payload

// ── Availability checks ─────────────────────────────────────────────

export function isFfmpegAvailable(): boolean {
  try {
    execSync("which ffmpeg", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function isWhisperAvailable(): boolean {
  try {
    execSync("which whisper", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function isTranscriptProviderAvailable(provider: string): {
  available: boolean;
  reason?: string;
} {
  switch (provider) {
    case "whisper":
      return isWhisperAvailable()
        ? { available: true }
        : {
            available: false,
            reason: "whisper CLI not found — install with: pip install openai-whisper",
          };
    case "openai": {
      const key = getVideoTranscriptApiKey("openai");
      return key
        ? { available: true }
        : { available: false, reason: "OpenAI API key not configured" };
    }
    case "gemini": {
      const key = getVideoTranscriptApiKey("gemini");
      return key
        ? { available: true }
        : { available: false, reason: "Gemini API key not configured" };
    }
    case "off":
      return { available: true };
    default:
      return { available: false, reason: "Unknown provider" };
  }
}

// ── Processing pipeline ─────────────────────────────────────────────

const VIDEO_EXTENSIONS = new Set([
  ".mp4",
  ".mov",
  ".avi",
  ".mkv",
  ".webm",
  ".m4v",
  ".wmv",
  ".flv",
  ".ogv",
]);

export function isVideoMimeType(mimeType: string | null): boolean {
  return !!mimeType && mimeType.startsWith("video/");
}

export function isVideoFile(mimeType: string | null, filename: string | null): boolean {
  if (isVideoMimeType(mimeType)) return true;
  if (!filename) return false;
  const ext = filename.slice(filename.lastIndexOf(".")).toLowerCase();
  return VIDEO_EXTENSIONS.has(ext);
}

/**
 * Trigger video processing for an attachment. Fire-and-forget — caller
 * should not await this unless they want to block.
 */
export async function processVideoAttachment(attachmentId: string, runId: string): Promise<void> {
  const att = getAttachmentById(attachmentId);
  if (att?.kind !== "file" || !isVideoFile(att.mime_type, att.filename)) return;

  // Don't double-process
  const existing = getProcessingByAttachment(attachmentId);
  if (existing) return;

  if (!isFfmpegAvailable()) {
    addRunActivity(
      runId,
      "system",
      null,
      "System",
      `Video processing skipped for **${att.filename}** — ffmpeg not found.`,
    );
    return;
  }

  // Clean up any leftover processed files from a previous attempt
  const outDir = processedDir(runId, attachmentId);
  try {
    fs.rmSync(outDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }

  const interval = getVideoScreenshotInterval();
  const record = createProcessingRecord(attachmentId, runId, interval);

  // Post system activity
  addRunActivity(runId, "system", null, "System", `Processing video **${att.filename}**...`);

  try {
    updateProcessingStatus(record.id, "processing");

    const videoPath = path.join(uploadsDir(), att.storage_path!);
    const outDir = processedDir(runId, attachmentId);
    const screenshotsDir = path.join(outDir, "screenshots");
    ensureDir(screenshotsDir);

    // Get video duration
    const duration = await getVideoDuration(videoPath);

    // Extract screenshots
    const screenshotCount = await extractScreenshots(videoPath, screenshotsDir, interval);

    // Extract transcript
    let transcriptPath: string | null = null;
    const provider = getVideoTranscriptProvider();
    if (provider !== "off") {
      const check = isTranscriptProviderAvailable(provider);
      if (check.available) {
        transcriptPath = await extractTranscript(videoPath, outDir, provider);
      }
    }

    // Generate storyboard (interleaved screenshots + transcript)
    const segmentsPath = path.join(outDir, "segments.json");
    // We need a base URL placeholder — the actual URL is resolved at serve time
    const screenshotsUrlPlaceholder = `{{base}}/api/runs/${runId}/attachments/${attachmentId}/screenshots`;
    if (screenshotCount > 0) {
      const storyboard = buildStoryboard(
        segmentsPath,
        screenshotCount,
        interval,
        screenshotsUrlPlaceholder,
      );
      fs.writeFileSync(path.join(outDir, "storyboard.txt"), storyboard);
    }

    // Write metadata
    const metadata = {
      duration_seconds: duration,
      screenshot_count: screenshotCount,
      screenshot_interval: interval,
      transcript_provider: provider !== "off" ? provider : null,
      processed_at: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(outDir, "metadata.json"), JSON.stringify(metadata, null, 2));

    // Update DB
    updateProcessingStatus(record.id, "done", {
      transcript_path: transcriptPath ? path.relative(uploadsDir(), transcriptPath) : undefined,
      screenshots_dir: path.relative(uploadsDir(), screenshotsDir),
      screenshot_count: screenshotCount,
      duration_seconds: duration,
    });

    // Format duration for activity message
    const durationStr = formatDuration(duration);
    const parts = [`${screenshotCount} screenshots`];
    if (transcriptPath) parts.push("transcript ready");
    addRunActivity(
      runId,
      "system",
      null,
      "System",
      `Video processed: ${parts.join(", ")} (${durationStr})`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    updateProcessingStatus(record.id, "failed", { error: message });
    addRunActivity(
      runId,
      "system",
      null,
      "System",
      `Video processing failed for **${att.filename}**: ${message}`,
    );
  }
}

// ── ffmpeg helpers ───────────────────────────────────────────────────

async function getVideoDuration(videoPath: string): Promise<number> {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v",
    "quiet",
    "-print_format",
    "json",
    "-show_format",
    videoPath,
  ]);
  const info = JSON.parse(stdout);
  return parseFloat(info.format?.duration || "0");
}

async function extractScreenshots(
  videoPath: string,
  outDir: string,
  intervalSec: number,
): Promise<number> {
  await execFileAsync(
    "ffmpeg",
    [
      "-i",
      videoPath,
      "-vf",
      `fps=1/${intervalSec}`,
      "-q:v",
      "3",
      "-frames:v",
      "500", // safety cap
      path.join(outDir, "%04d.jpg"),
    ],
    { timeout: 300000 },
  ); // 5 min timeout

  const files = fs.readdirSync(outDir).filter((f) => f.endsWith(".jpg"));
  return files.length;
}

// ── Transcript types ────────────────────────────────────────────────

type TranscriptSegment = { start: number; end: number; text: string };

function normalizeSegments(
  raw: { start?: unknown; end?: unknown; text?: unknown }[],
): TranscriptSegment[] {
  return raw.map((s) => ({
    start: Number(s.start) || 0,
    end: Number(s.end) || 0,
    text: (typeof s.text === "string" ? s.text : "").trim(),
  }));
}

// ── Transcript providers ────────────────────────────────────────────

async function extractTranscript(
  videoPath: string,
  outDir: string,
  provider: string,
): Promise<string> {
  // First extract audio with ffmpeg (all providers work with audio)
  const audioPath = path.join(outDir, "audio.mp3");
  await execFileAsync(
    "ffmpeg",
    ["-i", videoPath, "-vn", "-acodec", "libmp3lame", "-q:a", "4", "-y", audioPath],
    { timeout: 300000 },
  );

  let segments: TranscriptSegment[];

  switch (provider) {
    case "whisper":
      segments = await transcribeWithWhisper(audioPath, outDir);
      break;
    case "openai":
      segments = await transcribeWithOpenAI(audioPath);
      break;
    case "gemini":
      segments = await transcribeWithGemini(audioPath);
      break;
    default:
      throw new Error(`Unknown transcript provider: ${provider}`);
  }

  // Save plain transcript
  const plainText = segments.map((s) => s.text).join(" ");
  const transcriptPath = path.join(outDir, "transcript.txt");
  fs.writeFileSync(transcriptPath, plainText);

  // Save timestamped segments for storyboard generation
  fs.writeFileSync(path.join(outDir, "segments.json"), JSON.stringify(segments));

  // Clean up audio file
  try {
    fs.unlinkSync(audioPath);
  } catch {
    /* ignore */
  }

  return transcriptPath;
}

async function transcribeWithWhisper(
  audioPath: string,
  outDir: string,
): Promise<TranscriptSegment[]> {
  await execFileAsync("whisper", [audioPath, "--output_format", "json", "--output_dir", outDir], {
    timeout: 600000,
  }); // 10 min timeout

  // Whisper outputs <basename>.json
  const basename = path.basename(audioPath, path.extname(audioPath));
  const outputPath = path.join(outDir, `${basename}.json`);
  const raw = JSON.parse(fs.readFileSync(outputPath, "utf-8"));

  // Clean up whisper's output file
  try {
    fs.unlinkSync(outputPath);
  } catch {
    /* ignore */
  }

  return normalizeSegments(raw.segments || []);
}

async function transcribeWithOpenAI(audioPath: string): Promise<TranscriptSegment[]> {
  const apiKey = getVideoTranscriptApiKey("openai");
  if (!apiKey) throw new Error("OpenAI API key not configured");

  const audioData = fs.readFileSync(audioPath);
  const formData = new FormData();
  formData.append("model", "whisper-1");
  formData.append("file", new Blob([audioData], { type: "audio/mpeg" }), "audio.mp3");
  formData.append("response_format", "verbose_json");

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: formData,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenAI API error (${res.status}): ${err}`);
  }

  const data = await res.json();

  return normalizeSegments(data.segments || []);
}

async function transcribeWithGemini(audioPath: string): Promise<TranscriptSegment[]> {
  const apiKey = getVideoTranscriptApiKey("gemini");
  if (!apiKey) throw new Error("Gemini API key not configured");

  const audioData = fs.readFileSync(audioPath);
  const base64Audio = audioData.toString("base64");

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { inline_data: { mime_type: "audio/mpeg", data: base64Audio } },
              {
                text: `Transcribe this audio with timestamps. Return ONLY a JSON array of segments, no markdown fences or other text. Format: [{"start": 0.0, "end": 2.5, "text": "words spoken"}, ...]`,
              },
            ],
          },
        ],
      }),
    },
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini API error (${res.status}): ${err}`);
  }

  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Gemini returned no transcript text");

  // Gemini may wrap in markdown fences — strip them
  const cleaned = text
    .replace(/^```(?:json)?\s*\n?/m, "")
    .replace(/\n?```\s*$/m, "")
    .trim();
  try {
    return normalizeSegments(JSON.parse(cleaned));
  } catch {
    // Fallback: treat entire response as a single untimed segment
    return [{ start: 0, end: 0, text: text.trim() }];
  }
}

// ── Storyboard generation ──────────────────────────────────────────

function buildStoryboard(
  segmentsPath: string,
  screenshotCount: number,
  interval: number,
  screenshotsUrl: string,
): string {
  let segments: TranscriptSegment[] = [];
  try {
    segments = JSON.parse(fs.readFileSync(segmentsPath, "utf-8"));
  } catch {
    /* no segments available */
  }

  const lines: string[] = [];

  for (let i = 0; i < screenshotCount; i++) {
    const windowStart = i * interval;
    const windowEnd = (i + 1) * interval;
    const ts = formatDuration(windowStart);

    lines.push(`[Screenshot ${i + 1} — ${ts} — ${screenshotsUrl}/${i}/file]`);

    // Collect transcript segments that overlap this window
    const windowText = segments
      .filter((s) => s.end > windowStart && s.start < windowEnd)
      .map((s) => s.text)
      .join(" ")
      .trim();

    if (windowText) {
      lines.push(windowText);
    }

    lines.push(""); // blank line between entries
  }

  // Any transcript after the last screenshot
  if (screenshotCount > 0) {
    const lastWindowEnd = screenshotCount * interval;
    const trailing = segments
      .filter((s) => s.start >= lastWindowEnd)
      .map((s) => s.text)
      .join(" ")
      .trim();
    if (trailing) {
      lines.push(trailing);
      lines.push("");
    }
  }

  return lines.join("\n").trim();
}

// ── Helpers ─────────────────────────────────────────────────────────

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/**
 * Read a transcript file and optionally cap it for inline use in the runner claim payload.
 */
export function readTranscript(transcriptPath: string, cap?: number): string {
  const abs = path.join(uploadsDir(), transcriptPath);
  if (!fs.existsSync(abs)) return "";
  const text = fs.readFileSync(abs, "utf-8");
  if (cap && text.length > cap) {
    return (
      text.slice(0, cap) +
      `\n\n[Transcript truncated at ${cap} characters — fetch full transcript via the API]`
    );
  }
  return text;
}

/**
 * Read the storyboard file (interleaved screenshots + transcript).
 * Resolves the {{base}} placeholder with the actual base URL.
 * Falls back to plain transcript if no storyboard exists.
 */
export function readStoryboard(
  screenshotsDir: string,
  baseUrl: string,
  cap?: number,
): string | null {
  // storyboard.txt lives one level up from the screenshots dir
  const parentDir = path.join(uploadsDir(), screenshotsDir, "..");
  const storyboardPath = path.join(parentDir, "storyboard.txt");
  if (!fs.existsSync(storyboardPath)) return null;

  let text = fs.readFileSync(storyboardPath, "utf-8");
  text = text.replace(/\{\{base\}\}/g, baseUrl);

  if (cap && text.length > cap) {
    return (
      text.slice(0, cap) +
      `\n\n[Storyboard truncated at ${cap} characters — fetch full version via the API]`
    );
  }
  return text;
}

export { TRANSCRIPT_CAP };

import fs from "fs";
import path from "path";
import os from "os";

/**
 * Centralized paths for Harbour's local state.
 *
 * Defaults: everything lives under ~/.harbour so a single backup of that
 * directory captures the DB, uploads, encryption key, and runner config.
 *
 * Overrides:
 *   HARBOUR_HOME           — root dir (default ~/.harbour)
 *   HARBOUR_DB_PATH        — explicit DB file (default <home>/harbour.db)
 *   HARBOUR_UPLOADS_DIR    — explicit uploads dir (default <home>/uploads)
 *   HARBOUR_ENCRYPTION_KEY — encryption key value (otherwise read from <home>/encryption.key)
 *   HARBOUR_MAX_UPLOAD_MB  — per-file upload cap in MB (default 500)
 */

export function harbourHome(): string {
  return process.env.HARBOUR_HOME || path.join(os.homedir(), ".harbour");
}

export function dbPath(): string {
  return process.env.HARBOUR_DB_PATH || path.join(harbourHome(), "harbour.db");
}

export function uploadsDir(): string {
  return process.env.HARBOUR_UPLOADS_DIR || path.join(harbourHome(), "uploads");
}

export function runUploadsDir(runId: string): string {
  return path.join(uploadsDir(), "runs", runId);
}

export function encryptionKeyPath(): string {
  return path.join(harbourHome(), "encryption.key");
}

export function runnersFile(): string {
  return path.join(harbourHome(), "runners.json");
}

export function maxUploadMb(): number {
  const raw = parseInt(process.env.HARBOUR_MAX_UPLOAD_MB || "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 500;
}

export function maxUploadBytes(): number {
  return maxUploadMb() * 1024 * 1024;
}

export function processedDir(runId: string, attachmentId: string): string {
  return path.join(runUploadsDir(runId), "processed", attachmentId);
}

export function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

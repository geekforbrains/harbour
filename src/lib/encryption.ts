import crypto from "node:crypto";
import fs from "node:fs";
import { encryptionKeyPath, ensureDir, harbourHome } from "./paths";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

let _key: Buffer | null = null;

function loadOrCreateKey(): Buffer {
  if (_key) return _key;

  // Check env var first
  const envKey = process.env.HARBOUR_ENCRYPTION_KEY;
  if (envKey) {
    _key = Buffer.from(envKey, "hex");
    if (_key.length !== 32)
      throw new Error("HARBOUR_ENCRYPTION_KEY must be 64 hex chars (32 bytes)");
    return _key;
  }

  // Check key file
  const keyFile = encryptionKeyPath();
  if (fs.existsSync(keyFile)) {
    _key = Buffer.from(fs.readFileSync(keyFile, "utf-8").trim(), "hex");
    return _key;
  }

  // Generate new key
  ensureDir(harbourHome());
  _key = crypto.randomBytes(32);
  fs.writeFileSync(keyFile, _key.toString("hex"), { mode: 0o600 });
  return _key;
}

export function encrypt(plaintext: string): string {
  const key = loadOrCreateKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted.toString("hex")}`;
}

export function decrypt(ciphertext: string): string {
  const key = loadOrCreateKey();
  const [ivHex, authTagHex, encryptedHex] = ciphertext.split(":");
  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");
  const encrypted = Buffer.from(encryptedHex, "hex");
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf-8");
}

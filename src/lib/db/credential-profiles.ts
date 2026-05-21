import { v4 as uuid } from "uuid";
import { decrypt } from "../encryption";
import { getDb } from "./schema";
import { createEnvVar, updateEnvVar } from "./env-vars";

export const PROVIDER_ORDER = [
  "google-ai-studio",
  "openrouter",
  "github-models",
  "cerebras",
  "groq",
  "mistral",
  "cloudflare",
  "zai",
] as const;

export const PROVIDER_ENV_NAMES: Record<string, string[]> = {
  "google-ai-studio": ["GOOGLE_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  "github-models": ["GITHUB_MODELS_API_KEY"],
  cerebras: ["CEREBRAS_API_KEY"],
  groq: ["GROQ_API_KEY"],
  mistral: ["MISTRAL_API_KEY"],
  cloudflare: ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"],
  zai: ["ZAI_API_KEY"],
};

type CredentialProfileRow = {
  id: string;
  email: string;
  display_name: string | null;
  notes: string | null;
  created_by_user_id: string | null;
  created_at: number;
  updated_at: number;
};

type ProviderCredentialRow = {
  id: string;
  profile_id: string;
  provider: string;
  env_name: string;
  env_var_id: string;
  account_email: string | null;
  status: string;
  metadata: string | null;
  created_at: number;
  updated_at: number;
};

type SecretValueRow = { encrypted_value: string };
type JobProfileRow = { credential_profile_id: string | null };

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

function normalizeProvider(provider: string) {
  return provider.trim().toLowerCase().replace(/_/g, "-");
}

function normalizeEnvName(envName: string) {
  return envName.trim().toUpperCase();
}

function internalEnvVarName(credentialId: string, envName: string) {
  return `CRED_${credentialId.replace(/-/g, "").slice(0, 12)}_${normalizeEnvName(envName)}`;
}

function encodeMetadata(metadata: unknown) {
  if (metadata === undefined || metadata === null || metadata === "") return null;
  return typeof metadata === "string" ? metadata : JSON.stringify(metadata);
}

function decodeMetadata(value: string | null) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function serializeProviderCredential(row: ProviderCredentialRow & { env_var_name?: string | null }) {
  return {
    ...row,
    metadata: decodeMetadata(row.metadata),
  };
}

export function upsertCredentialProfile(data: {
  email: string;
  displayName?: string | null;
  notes?: string | null;
  createdByUserId?: string | null;
}): CredentialProfileRow | null {
  const email = normalizeEmail(data.email || "");
  if (!email) throw new Error("email is required");

  const db = getDb();
  const existing = getCredentialProfileByEmail(email);
  if (existing) {
    db.prepare(`
      UPDATE credential_profiles
      SET display_name = COALESCE(?, display_name),
          notes = COALESCE(?, notes),
          updated_at = unixepoch()
      WHERE id = ?
    `).run(data.displayName || null, data.notes || null, existing.id);
    return getCredentialProfileById(existing.id);
  }

  const id = uuid();
  db.prepare(`
    INSERT INTO credential_profiles (id, email, display_name, notes, created_by_user_id)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, email, data.displayName || null, data.notes || null, data.createdByUserId || null);
  return getCredentialProfileById(id);
}

export function getCredentialProfileById(id: string): CredentialProfileRow | null {
  const db = getDb();
  return db.prepare(`SELECT * FROM credential_profiles WHERE id = ?`).get(id) as CredentialProfileRow | undefined || null;
}

export function getCredentialProfileByEmail(email: string): CredentialProfileRow | null {
  const db = getDb();
  return db.prepare(`SELECT * FROM credential_profiles WHERE email = ?`).get(normalizeEmail(email)) as CredentialProfileRow | undefined || null;
}

export function listCredentialProfiles(): CredentialProfileRow[] {
  const db = getDb();
  return db.prepare(`SELECT * FROM credential_profiles ORDER BY email ASC`).all() as CredentialProfileRow[];
}

export function upsertProviderCredential(data: {
  profileId: string;
  provider: string;
  envName: string;
  value: string;
  accountEmail?: string | null;
  status?: string | null;
  metadata?: unknown;
}) {
  const db = getDb();
  const profile = getCredentialProfileById(data.profileId);
  if (!profile) throw new Error("credential profile not found");

  const provider = normalizeProvider(data.provider);
  const envName = normalizeEnvName(data.envName);
  if (!provider) throw new Error("provider is required");
  if (!envName) throw new Error("envName is required");
  if (!data.value) throw new Error("value is required");
  const allowedEnvNames = PROVIDER_ENV_NAMES[provider];
  if (!allowedEnvNames) throw new Error(`unsupported provider: ${provider}`);
  if (!allowedEnvNames.includes(envName)) {
    throw new Error(`envName ${envName} is not valid for provider ${provider}`);
  }

  const existing = db.prepare(`
    SELECT * FROM provider_credentials
    WHERE profile_id = ? AND provider = ? AND env_name = ?
  `).get(profile.id, provider, envName) as ProviderCredentialRow | undefined;

  if (existing) {
    updateEnvVar(existing.env_var_id, { value: data.value });
    db.prepare(`
      UPDATE provider_credentials
      SET account_email = COALESCE(?, account_email),
          status = COALESCE(?, status),
          metadata = COALESCE(?, metadata),
          updated_at = unixepoch()
      WHERE id = ?
    `).run(
      data.accountEmail || null,
      data.status || null,
      encodeMetadata(data.metadata),
      existing.id,
    );
    return getProviderCredentialById(existing.id);
  }

  const id = uuid();
  const envVar = createEnvVar(internalEnvVarName(id, envName), data.value);
  db.prepare(`
    INSERT INTO provider_credentials (
      id, profile_id, provider, env_name, env_var_id, account_email, status, metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    profile.id,
    provider,
    envName,
    envVar.id,
    data.accountEmail || null,
    data.status || "active",
    encodeMetadata(data.metadata),
  );

  return getProviderCredentialById(id);
}

export function getProviderCredentialById(id: string) {
  const db = getDb();
  const row = db.prepare(`
    SELECT pc.*, ev.name as env_var_name
    FROM provider_credentials pc
    JOIN env_vars ev ON ev.id = pc.env_var_id
    WHERE pc.id = ?
  `).get(id) as (ProviderCredentialRow & { env_var_name: string }) | undefined;
  return row ? serializeProviderCredential(row) : null;
}

export function listProviderCredentials(profileId: string) {
  const db = getDb();
  const rows = db.prepare(`
    SELECT pc.*, ev.name as env_var_name
    FROM provider_credentials pc
    JOIN env_vars ev ON ev.id = pc.env_var_id
    WHERE pc.profile_id = ?
    ORDER BY
      CASE pc.provider
        WHEN 'google-ai-studio' THEN 1
        WHEN 'openrouter' THEN 2
        WHEN 'github-models' THEN 3
        WHEN 'cerebras' THEN 4
        WHEN 'groq' THEN 5
        WHEN 'mistral' THEN 6
        WHEN 'cloudflare' THEN 7
        WHEN 'zai' THEN 8
        ELSE 99
      END,
      pc.env_name ASC
  `).all(profileId) as (ProviderCredentialRow & { env_var_name: string })[];
  return rows.map(serializeProviderCredential);
}

export function getCredentialProfileWithCredentials(id: string) {
  const profile = getCredentialProfileById(id);
  if (!profile) return null;
  return { ...profile, credentials: listProviderCredentials(id) };
}

export function getCredentialBrokerEnvForProfile(profileId: string): Record<string, string> {
  const db = getDb();
  const rows = db.prepare(`
    SELECT pc.env_name, ev.encrypted_value
    FROM provider_credentials pc
    JOIN env_vars ev ON ev.id = pc.env_var_id
    WHERE pc.profile_id = ? AND pc.status = 'active'
    ORDER BY pc.env_name ASC
  `).all(profileId) as { env_name: string; encrypted_value: string }[];

  const env: Record<string, string> = {};
  for (const row of rows) {
    env[row.env_name] = decrypt(row.encrypted_value);
  }
  return env;
}

export function getCredentialBrokerEnvForJob(jobId: string): Record<string, string> {
  const db = getDb();
  const job = db.prepare(`SELECT credential_profile_id FROM jobs WHERE id = ?`).get(jobId) as JobProfileRow | undefined;
  if (!job?.credential_profile_id) return {};
  return getCredentialBrokerEnvForProfile(job.credential_profile_id);
}

export function runHasCredentialProfile(runId: string): boolean {
  const db = getDb();
  const row = db.prepare(`
    SELECT j.credential_profile_id
    FROM runs r
    JOIN jobs j ON j.id = r.job_id
    WHERE r.id = ?
  `).get(runId) as JobProfileRow | undefined;
  return !!row?.credential_profile_id;
}

export function getSecretValuesForRun(runId: string): string[] {
  const db = getDb();
  const linkedRows = db.prepare(`
    SELECT ev.encrypted_value
    FROM runs r
    JOIN job_env_vars jev ON jev.job_id = r.job_id
    JOIN env_vars ev ON ev.id = jev.env_var_id
    WHERE r.id = ?
  `).all(runId) as SecretValueRow[];

  const values = linkedRows.map(row => decrypt(row.encrypted_value));
  const run = db.prepare(`SELECT job_id FROM runs WHERE id = ?`).get(runId) as { job_id: string } | undefined;
  if (run?.job_id) {
    values.push(...Object.values(getCredentialBrokerEnvForJob(run.job_id)));
  }

  return values.filter(value => value && value.length >= 8);
}

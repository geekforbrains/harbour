import { v4 as uuid } from "uuid";
import { decrypt } from "../encryption";
import { createEnvVar, getEnvVarById } from "./env-vars";
import { getDb } from "./schema";

export const LLM_CONNECTION_KINDS = [
  "openai",
  "anthropic",
  "openrouter",
  "ollama",
  "openai-compatible",
] as const;

export const LLM_PROTOCOLS = ["native", "chat-completions", "responses"] as const;

export type LlmConnectionKind = (typeof LLM_CONNECTION_KINDS)[number];
export type LlmProtocol = (typeof LLM_PROTOCOLS)[number];

export type LlmConnectionMetadata = {
  id: string;
  project_id: string;
  name: string;
  kind: LlmConnectionKind;
  provider_id: string;
  base_url: string | null;
  protocol: LlmProtocol;
  created_at: number;
  updated_at: number;
  credential: { id: string; name: string } | null;
};

export type LlmConnectionListItem = LlmConnectionMetadata & {
  project_name: string;
  agent_count: number;
};

export type LlmCredentialInput = { name: string; value: string };

export type CreateLlmConnectionInput = {
  name: string;
  kind: LlmConnectionKind;
  providerId: string;
  baseUrl?: string | null;
  protocol?: LlmProtocol;
  credentialId?: string | null;
  credential?: LlmCredentialInput;
};

export type UpdateLlmConnectionInput = {
  name?: string;
  kind?: LlmConnectionKind;
  providerId?: string;
  baseUrl?: string | null;
  protocol?: LlmProtocol;
  credentialId?: string | null;
  credential?: LlmCredentialInput;
};

type ConnectionRow = Omit<LlmConnectionMetadata, "credential"> & {
  credential_id: string | null;
  credential_name: string | null;
};

type ValidatedConfig = {
  name: string;
  kind: LlmConnectionKind;
  providerId: string;
  baseUrl: string | null;
  protocol: LlmProtocol;
};

const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9._-]*$/;
const FIXED_PROVIDER_IDS: Partial<Record<LlmConnectionKind, string>> = {
  openai: "openai",
  anthropic: "anthropic",
  openrouter: "openrouter",
  ollama: "ollama",
};
const REQUIRED_CREDENTIAL_KINDS = new Set<LlmConnectionKind>(["openai", "anthropic", "openrouter"]);

export class LlmConnectionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmConnectionValidationError";
  }
}

export class LlmConnectionInUseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmConnectionInUseError";
  }
}

export class LlmConnectionNameCollisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmConnectionNameCollisionError";
  }
}

function assertNameAvailable(projectId: string, name: string, excludeId?: string) {
  const params: string[] = [projectId, name];
  let sql = `SELECT id FROM llm_connections
             WHERE project_id = ? AND name = ? COLLATE NOCASE`;
  if (excludeId) {
    sql += " AND id != ?";
    params.push(excludeId);
  }
  if (
    getDb()
      .prepare(sql)
      .get(...params)
  ) {
    throw new LlmConnectionNameCollisionError(
      `An LLM connection named "${name}" already exists in this project`,
    );
  }
}

function defaultProtocol(kind: LlmConnectionKind): LlmProtocol {
  return kind === "ollama" || kind === "openai-compatible" ? "chat-completions" : "native";
}

function normalizeBaseUrl(value: string | null | undefined): string | null {
  if (value === undefined || value === null || value.trim() === "") return null;
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new LlmConnectionValidationError("base_url must be a valid http:// or https:// URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new LlmConnectionValidationError("base_url must be a valid http:// or https:// URL");
  }
  if (parsed.username || parsed.password) {
    throw new LlmConnectionValidationError("base_url must not contain credentials");
  }
  if (parsed.search) {
    throw new LlmConnectionValidationError("base_url must not contain a query string");
  }
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

function validateConfig(
  input: {
    name: unknown;
    kind: unknown;
    providerId: unknown;
    baseUrl?: unknown;
    protocol?: unknown;
  },
  hasCredential: boolean,
): ValidatedConfig {
  if (typeof input.name !== "string" || input.name.trim() === "") {
    throw new LlmConnectionValidationError("name is required and must be a non-empty string");
  }
  if (
    typeof input.kind !== "string" ||
    !LLM_CONNECTION_KINDS.includes(input.kind as LlmConnectionKind)
  ) {
    throw new LlmConnectionValidationError(
      `kind must be one of: ${LLM_CONNECTION_KINDS.join(", ")}`,
    );
  }
  const kind = input.kind as LlmConnectionKind;
  if (typeof input.providerId !== "string" || !PROVIDER_ID_RE.test(input.providerId)) {
    throw new LlmConnectionValidationError(
      "provider_id must start with a lowercase letter or number and contain only lowercase letters, numbers, dots, underscores, or hyphens",
    );
  }
  const fixedProviderId = FIXED_PROVIDER_IDS[kind];
  if (fixedProviderId && input.providerId !== fixedProviderId) {
    throw new LlmConnectionValidationError(
      `${kind} connections must use provider_id "${fixedProviderId}"`,
    );
  }

  const protocol = input.protocol ?? defaultProtocol(kind);
  if (typeof protocol !== "string" || !LLM_PROTOCOLS.includes(protocol as LlmProtocol)) {
    throw new LlmConnectionValidationError(`protocol must be one of: ${LLM_PROTOCOLS.join(", ")}`);
  }
  if (kind !== "openai-compatible" && kind !== "ollama" && protocol !== "native") {
    throw new LlmConnectionValidationError(`${kind} connections must use protocol "native"`);
  }
  if (kind === "ollama" && protocol !== "chat-completions") {
    throw new LlmConnectionValidationError(
      'ollama connections must use protocol "chat-completions"',
    );
  }
  if (kind === "openai-compatible" && protocol === "native") {
    throw new LlmConnectionValidationError(
      "openai-compatible connections must use chat-completions or responses protocol",
    );
  }

  const baseUrl = normalizeBaseUrl(input.baseUrl as string | null | undefined);
  if (kind === "openai-compatible" && !baseUrl) {
    throw new LlmConnectionValidationError("openai-compatible connections require base_url");
  }
  if (REQUIRED_CREDENTIAL_KINDS.has(kind) && !hasCredential) {
    throw new LlmConnectionValidationError(`${kind} connections require an API key Secret`);
  }

  return {
    name: input.name.trim(),
    kind,
    providerId: input.providerId,
    baseUrl,
    protocol: protocol as LlmProtocol,
  };
}

function validateCredentialInput(credential: LlmCredentialInput) {
  if (typeof credential.name !== "string" || credential.name.trim() === "") {
    throw new LlmConnectionValidationError(
      "credential.name is required and must be a non-empty string",
    );
  }
  if (typeof credential.value !== "string" || credential.value.trim() === "") {
    throw new LlmConnectionValidationError(
      "credential.value is required and must be a non-empty string",
    );
  }
}

function createCredentialSecret(projectId: string, credential: LlmCredentialInput) {
  try {
    return createEnvVar(projectId, credential.name.trim(), credential.value)!;
  } catch (error) {
    if (error instanceof Error && error.message.includes("already exists in this project")) {
      throw new LlmConnectionValidationError(error.message);
    }
    throw error;
  }
}

function assertCredentialBelongsToProject(projectId: string, credentialId: string) {
  const credential = getEnvVarById(credentialId);
  if (!credential) {
    throw new LlmConnectionValidationError("Credential Secret not found");
  }
  if (credential.project_id !== projectId) {
    throw new LlmConnectionValidationError(
      "The credential Secret and LLM connection must belong to the same project",
    );
  }
}

function metadataFromRow(row: ConnectionRow): LlmConnectionMetadata {
  const { credential_id: credentialId, credential_name: credentialName, ...connection } = row;
  return {
    ...connection,
    credential: credentialId && credentialName ? { id: credentialId, name: credentialName } : null,
  };
}

const METADATA_SELECT = `
  SELECT lc.id, lc.project_id, lc.name, lc.kind, lc.provider_id, lc.base_url,
         lc.protocol, lc.created_at, lc.updated_at,
         ev.id AS credential_id, ev.name AS credential_name
  FROM llm_connections lc
  LEFT JOIN llm_connection_secrets lcs
    ON lcs.connection_id = lc.id AND lcs.role = 'api_key'
  LEFT JOIN env_vars ev ON ev.id = lcs.env_var_id
`;

export function getLlmConnectionById(id: string): LlmConnectionMetadata | null {
  const row = getDb().prepare(`${METADATA_SELECT} WHERE lc.id = ?`).get(id) as
    | ConnectionRow
    | undefined;
  return row ? metadataFromRow(row) : null;
}

/** List one project's reusable connections, or every project's when omitted. */
export function listLlmConnections(projectId?: string): LlmConnectionListItem[] {
  const rows = getDb()
    .prepare(
      `SELECT lc.id, lc.project_id, lc.name, lc.kind, lc.provider_id, lc.base_url,
              lc.protocol, lc.created_at, lc.updated_at,
              ev.id AS credential_id, ev.name AS credential_name,
              p.name AS project_name,
              (SELECT COUNT(*) FROM agent_llm_connections alc
               WHERE alc.connection_id = lc.id) AS agent_count
       FROM llm_connections lc
       JOIN projects p ON p.id = lc.project_id
       LEFT JOIN llm_connection_secrets lcs
         ON lcs.connection_id = lc.id AND lcs.role = 'api_key'
       LEFT JOIN env_vars ev ON ev.id = lcs.env_var_id
       ${projectId ? "WHERE lc.project_id = ?" : ""}
       ORDER BY lc.name COLLATE NOCASE, lc.id`,
    )
    .all(...(projectId ? [projectId] : [])) as (ConnectionRow & {
    project_name: string;
    agent_count: number;
  })[];
  return rows.map(metadataFromRow) as LlmConnectionListItem[];
}

export function createLlmConnection(
  projectId: string,
  input: CreateLlmConnectionInput,
): LlmConnectionMetadata {
  if (input.credentialId && input.credential) {
    throw new LlmConnectionValidationError("credential_id and credential are mutually exclusive");
  }
  if (input.credential) validateCredentialInput(input.credential);
  if (input.credentialId) assertCredentialBelongsToProject(projectId, input.credentialId);

  const config = validateConfig(input, !!input.credentialId || !!input.credential);
  assertNameAvailable(projectId, config.name);
  const db = getDb();
  const id = uuid();
  const create = db.transaction(() => {
    db.prepare(
      `INSERT INTO llm_connections
        (id, project_id, name, kind, provider_id, base_url, protocol)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      projectId,
      config.name,
      config.kind,
      config.providerId,
      config.baseUrl,
      config.protocol,
    );

    let credentialId = input.credentialId ?? null;
    if (input.credential) {
      credentialId = createCredentialSecret(projectId, input.credential).id;
    }
    if (credentialId) {
      db.prepare(
        `INSERT INTO llm_connection_secrets (connection_id, role, env_var_id)
         VALUES (?, 'api_key', ?)`,
      ).run(id, credentialId);
    }
  });
  create();
  return getLlmConnectionById(id)!;
}

export function updateLlmConnection(
  id: string,
  input: UpdateLlmConnectionInput,
): LlmConnectionMetadata | null {
  const existing = getLlmConnectionById(id);
  if (!existing) return null;
  if (input.credentialId !== undefined && input.credential) {
    throw new LlmConnectionValidationError("credential_id and credential are mutually exclusive");
  }
  if (input.credential) validateCredentialInput(input.credential);
  if (input.credentialId) {
    assertCredentialBelongsToProject(existing.project_id, input.credentialId);
  }

  const credentialWillExist =
    input.credential !== undefined
      ? true
      : input.credentialId !== undefined
        ? input.credentialId !== null && input.credentialId !== ""
        : existing.credential !== null;
  const config = validateConfig(
    {
      name: input.name ?? existing.name,
      kind: input.kind ?? existing.kind,
      providerId: input.providerId ?? existing.provider_id,
      baseUrl: input.baseUrl === undefined ? existing.base_url : input.baseUrl,
      protocol: input.protocol ?? existing.protocol,
    },
    credentialWillExist,
  );
  assertNameAvailable(existing.project_id, config.name, id);

  if (
    isLlmConnectionInUse(id) &&
    (config.kind !== existing.kind || config.providerId !== existing.provider_id)
  ) {
    throw new LlmConnectionInUseError(
      "Cannot change the provider identity while this LLM connection is in use by an agent",
    );
  }

  const db = getDb();
  const update = db.transaction(() => {
    db.prepare(
      `UPDATE llm_connections
       SET name = ?, kind = ?, provider_id = ?, base_url = ?, protocol = ?, updated_at = unixepoch()
       WHERE id = ?`,
    ).run(config.name, config.kind, config.providerId, config.baseUrl, config.protocol, id);

    if (input.credential !== undefined || input.credentialId !== undefined) {
      let credentialId = input.credentialId || null;
      if (input.credential) {
        credentialId = createCredentialSecret(existing.project_id, input.credential).id;
      }
      db.prepare(
        `DELETE FROM llm_connection_secrets WHERE connection_id = ? AND role = 'api_key'`,
      ).run(id);
      if (credentialId) {
        db.prepare(
          `INSERT INTO llm_connection_secrets (connection_id, role, env_var_id)
           VALUES (?, 'api_key', ?)`,
        ).run(id, credentialId);
      }
    }
  });
  update();
  return getLlmConnectionById(id)!;
}

export function isLlmConnectionInUse(id: string): boolean {
  return !!getDb()
    .prepare(`SELECT 1 FROM agent_llm_connections WHERE connection_id = ? LIMIT 1`)
    .get(id);
}

export function deleteLlmConnection(id: string): boolean {
  if (isLlmConnectionInUse(id)) {
    throw new LlmConnectionInUseError(
      "Cannot delete an LLM connection while it is in use by an agent",
    );
  }
  return getDb().prepare(`DELETE FROM llm_connections WHERE id = ?`).run(id).changes > 0;
}

export function bindAgentToLlmConnection(agentId: string, connectionId: string) {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT a.project_id AS agent_project_id, lc.project_id AS connection_project_id
       FROM agents a
       JOIN llm_connections lc ON lc.id = ?
       WHERE a.id = ?`,
    )
    .get(connectionId, agentId) as
    | { agent_project_id: string; connection_project_id: string }
    | undefined;
  if (!row) {
    throw new LlmConnectionValidationError("Agent or LLM connection not found");
  }
  if (row.agent_project_id !== row.connection_project_id) {
    throw new LlmConnectionValidationError(
      "The agent and LLM connection must belong to the same project",
    );
  }
  db.prepare(
    `INSERT INTO agent_llm_connections (agent_id, connection_id) VALUES (?, ?)
     ON CONFLICT(agent_id) DO UPDATE SET connection_id = excluded.connection_id`,
  ).run(agentId, connectionId);
  return getLlmConnectionForAgent(agentId);
}

export function unbindAgentFromLlmConnection(agentId: string): boolean {
  return (
    getDb().prepare(`DELETE FROM agent_llm_connections WHERE agent_id = ?`).run(agentId).changes > 0
  );
}

export function getLlmConnectionForAgent(agentId: string): LlmConnectionMetadata | null {
  const row = getDb()
    .prepare(
      `${METADATA_SELECT}
       JOIN agent_llm_connections alc ON alc.connection_id = lc.id
       WHERE alc.agent_id = ?`,
    )
    .get(agentId) as ConnectionRow | undefined;
  return row ? metadataFromRow(row) : null;
}

/** Internal runner-only read. Never return this object from a normal CRUD API. */
export function getLlmConnectionRuntimeForAgent(agentId: string):
  | (Omit<
      LlmConnectionMetadata,
      "credential" | "project_id" | "name" | "created_at" | "updated_at"
    > & {
      api_key: string | null;
      credential_id: string | null;
    })
  | null {
  const row = getDb()
    .prepare(
      `SELECT lc.id, lc.kind, lc.provider_id, lc.base_url, lc.protocol,
              ev.id AS credential_id, ev.encrypted_value
       FROM agent_llm_connections alc
       JOIN llm_connections lc ON lc.id = alc.connection_id
       LEFT JOIN llm_connection_secrets lcs
         ON lcs.connection_id = lc.id AND lcs.role = 'api_key'
       LEFT JOIN env_vars ev ON ev.id = lcs.env_var_id
       WHERE alc.agent_id = ?`,
    )
    .get(agentId) as
    | {
        id: string;
        kind: LlmConnectionKind;
        provider_id: string;
        base_url: string | null;
        protocol: LlmProtocol;
        credential_id: string | null;
        encrypted_value: string | null;
      }
    | undefined;
  if (!row) return null;
  const { encrypted_value: encryptedValue, ...connection } = row;
  return { ...connection, api_key: encryptedValue ? decrypt(encryptedValue) : null };
}

export function getLlmConnectionsUsingEnvVar(envVarId: string): LlmConnectionMetadata[] {
  const rows = getDb()
    .prepare(
      `${METADATA_SELECT}
       WHERE lc.id IN (
         SELECT connection_id FROM llm_connection_secrets WHERE env_var_id = ?
       )
       ORDER BY lc.name COLLATE NOCASE, lc.id`,
    )
    .all(envVarId) as ConnectionRow[];
  return rows.map(metadataFromRow);
}

/** Validate OpenCode's canonical provider/model identifier without exposing config internals. */
export function validateLlmModelForProvider(providerId: string, model: unknown): string | null {
  if (typeof model !== "string" || model.trim() === "") {
    return "OpenCode requires a model in provider/model form";
  }
  const value = model.trim();
  if (/\s/.test(value)) {
    return "OpenCode requires a model in provider/model form";
  }
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) {
    return "OpenCode requires a model in provider/model form";
  }
  if (
    value
      .slice(slash + 1)
      .split("/")
      .some((segment) => segment.length === 0)
  ) {
    return "OpenCode requires a model in provider/model form";
  }
  if (value.slice(0, slash) !== providerId) {
    return `OpenCode model "${value}" must use provider "${providerId}"`;
  }
  return null;
}

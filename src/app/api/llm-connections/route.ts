import { NextResponse } from "next/server";
import { withAuthenticatedUser } from "@/lib/auth";
import {
  createLlmConnection,
  LLM_CONNECTION_KINDS,
  LLM_PROTOCOLS,
  LlmConnectionNameCollisionError,
  LlmConnectionValidationError,
  type LlmCredentialInput,
  listLlmConnections,
} from "@/lib/db/queries";
import {
  assertOneOf,
  badRequest,
  optionalString,
  readJson,
  requireNonEmptyString,
  resolveProjectId,
} from "@/lib/http";

function parseCredential(value: unknown): LlmCredentialInput | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    badRequest("credential must be an object with a name and value");
  }
  const input = value as Record<string, unknown>;
  const name = requireNonEmptyString(input.name, "credential.name");
  if (typeof input.value !== "string" || input.value.trim() === "") {
    badRequest("credential.value is required and must be a non-empty string");
  }
  return { name, value: input.value as string };
}

export function parseLlmConnectionCreateBody(body: Record<string, unknown>) {
  const credentialId =
    body.credential_id === undefined || body.credential_id === null
      ? undefined
      : requireNonEmptyString(body.credential_id, "credential_id");
  const credential = parseCredential(body.credential);
  if (credentialId && credential) {
    badRequest("credential_id and credential are mutually exclusive");
  }
  return {
    name: requireNonEmptyString(body.name, "name"),
    kind: assertOneOf(body.kind, LLM_CONNECTION_KINDS, "kind"),
    providerId: requireNonEmptyString(body.provider_id, "provider_id"),
    baseUrl: optionalString(body.base_url, "base_url"),
    protocol:
      body.protocol === undefined
        ? undefined
        : assertOneOf(body.protocol, LLM_PROTOCOLS, "protocol"),
    credentialId,
    credential,
  };
}

export const GET = withAuthenticatedUser(async (req) => {
  const projectId = req.nextUrl.searchParams.get("projectId") ?? undefined;
  return NextResponse.json(listLlmConnections(projectId));
});

export const POST = withAuthenticatedUser(async (req, auth) => {
  const body = await readJson(req);
  const projectId = resolveProjectId(req, body, auth);
  try {
    const connection = createLlmConnection(projectId, parseLlmConnectionCreateBody(body));
    return NextResponse.json(connection, { status: 201 });
  } catch (error) {
    if (error instanceof LlmConnectionNameCollisionError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof LlmConnectionValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }
});

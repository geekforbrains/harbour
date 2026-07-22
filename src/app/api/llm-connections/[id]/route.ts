import { NextResponse } from "next/server";
import { withAuthenticatedUser } from "@/lib/auth";
import {
  deleteLlmConnection,
  getLlmConnectionById,
  LLM_CONNECTION_KINDS,
  LLM_PROTOCOLS,
  LlmConnectionInUseError,
  LlmConnectionNameCollisionError,
  LlmConnectionValidationError,
  type LlmCredentialInput,
  updateLlmConnection,
} from "@/lib/db/queries";
import {
  assertOneOf,
  badRequest,
  optionalString,
  readJson,
  requireNonEmptyString,
} from "@/lib/http";

function parseCredential(value: unknown): LlmCredentialInput | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    badRequest("credential must be an object with a name and value");
  }
  const input = value as Record<string, unknown>;
  if (typeof input.name !== "string" || input.name.trim() === "") {
    badRequest("credential.name is required and must be a non-empty string");
  }
  if (typeof input.value !== "string" || input.value.trim() === "") {
    badRequest("credential.value is required and must be a non-empty string");
  }
  return { name: input.name.trim(), value: input.value };
}

function parseUpdateBody(body: Record<string, unknown>) {
  let credentialId: string | null | undefined;
  if (body.credential_id === null) credentialId = null;
  else if (body.credential_id !== undefined) {
    credentialId = requireNonEmptyString(body.credential_id, "credential_id");
  }
  const credential = parseCredential(body.credential);
  if (credentialId !== undefined && credential) {
    badRequest("credential_id and credential are mutually exclusive");
  }

  return {
    name: optionalString(body.name, "name"),
    kind:
      body.kind === undefined ? undefined : assertOneOf(body.kind, LLM_CONNECTION_KINDS, "kind"),
    providerId: optionalString(body.provider_id, "provider_id"),
    baseUrl: body.base_url === null ? null : optionalString(body.base_url, "base_url"),
    protocol:
      body.protocol === undefined
        ? undefined
        : assertOneOf(body.protocol, LLM_PROTOCOLS, "protocol"),
    credentialId,
    credential,
  };
}

export const GET = withAuthenticatedUser(async (_req, _auth, { params }) => {
  const { id } = await params;
  const connection = getLlmConnectionById(id);
  if (!connection) {
    return NextResponse.json({ error: "LLM connection not found" }, { status: 404 });
  }
  return NextResponse.json(connection);
});

export const PUT = withAuthenticatedUser(async (req, _auth, { params }) => {
  const { id } = await params;
  if (!getLlmConnectionById(id)) {
    return NextResponse.json({ error: "LLM connection not found" }, { status: 404 });
  }
  const body = await readJson(req);
  try {
    return NextResponse.json(updateLlmConnection(id, parseUpdateBody(body)));
  } catch (error) {
    if (error instanceof LlmConnectionInUseError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof LlmConnectionNameCollisionError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof LlmConnectionValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }
});

export const DELETE = withAuthenticatedUser(async (_req, _auth, { params }) => {
  const { id } = await params;
  if (!getLlmConnectionById(id)) {
    return NextResponse.json({ error: "LLM connection not found" }, { status: 404 });
  }
  try {
    deleteLlmConnection(id);
  } catch (error) {
    if (error instanceof LlmConnectionInUseError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    throw error;
  }
  return NextResponse.json({ ok: true });
});

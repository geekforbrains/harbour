import { type NextRequest, NextResponse } from "next/server";
import {
  authenticateApiKey,
  authenticateRunner,
  getRunByExecToken,
  getSession,
} from "./db/queries";
import type { RunnerScope, RunnerTier } from "./db/runners";
import { HttpError } from "./http";

// ── Session cookie ───────────────────────────────────────────────────────────

/**
 * Whether the session cookie should carry the `Secure` attribute. Keyed to the
 * browser-facing protocol, NOT NODE_ENV: behind a TLS-terminating proxy (Caddy)
 * that protocol arrives via X-Forwarded-Proto; on a direct connection it's the
 * request's own protocol.
 *
 * Tying `Secure` to `NODE_ENV === "production"` breaks local testing — a
 * production build served over http://localhost would mark the cookie Secure,
 * and browsers (notably Safari) refuse to store Secure cookies over http,
 * silently dropping the session and bouncing the user back to /login. Chrome
 * makes a localhost exception and accepts it, which is why it only fails in
 * Safari.
 */
export function isHttpsRequest(req: NextRequest): boolean {
  const forwarded = req.headers.get("x-forwarded-proto");
  if (forwarded) return forwarded.split(",")[0]?.trim() === "https";
  return req.nextUrl.protocol === "https:";
}

/**
 * Options for the `harbour_session` cookie. `maxAge` is required — callers pass
 * `sessionTtlSeconds()` so HARBOUR_SESSION_TTL_DAYS always wins (a hardcoded
 * default here would silently shadow it).
 */
export function sessionCookieOptions(req: NextRequest, maxAge: number) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: isHttpsRequest(req),
    path: "/",
    maxAge,
  };
}

// ── Identity ────────────────────────────────────────────────────────────────

/**
 * Identity established by authentication (who is calling). With a flat instance
 * — no tenants, no roles — authentication is the whole story: any user identity
 * is authorized for any user-facing route. User and runner identities pass
 * through to handlers unchanged, so they ARE the corresponding auth contexts
 * ({@link UserAuth}, {@link RunnerAuth}); only the executor pair differs
 * (identity carries `runStatus`, the auth context doesn't).
 */
type UserIdentity = UserAuth;
type RunnerIdentity = RunnerAuth;

/**
 * A single run's executor, authenticated by that run's exec token (`hbx_…`,
 * minted at claim). It's the credential the runner hands its spawned CLI, so the
 * high-value runner token never reaches the CLI. Scoped to exactly one run; for
 * agent runs it also carries the agent so it can act as that agent on resource
 * routes (docs/tables) the CLI calls.
 */
type ExecutorIdentity = {
  type: "executor";
  runId: string;
  runKind: string;
  runStatus: string;
  agentId: string | null;
  agentName: string | null;
  projectId: string;
};

export type Identity = UserIdentity | RunnerIdentity | ExecutorIdentity;

// ── Auth context handed to route handlers ────────────────────────────────────

/** What an authenticated user handler receives. */
export type UserAuth = {
  type: "user";
  userId: string;
  email: string;
  displayName: string;
};

/** What an authorized agent handler receives. */
export type AgentAuth = {
  type: "agent";
  agentId: string;
  agentName: string;
  projectId: string;
};

/**
 * What the claim handler receives — a runner authenticated by its bearer token
 * (`hbrn_…`), carrying only the registry facts. The runner's live capabilities
 * arrive in each claim body, so they aren't resolved here.
 */
export type RunnerAuth = {
  type: "runner";
  runnerId: string;
  runnerName: string;
  tier: RunnerTier;
  labels: string[];
  scope: RunnerScope;
};

/** What a run-lifecycle handler receives when the caller is the run's executor. */
export type ExecutorAuth = {
  type: "executor";
  runId: string;
  runKind: string;
  agentId: string | null;
  agentName: string | null;
  projectId: string;
};

export type AuthContext = UserAuth | AgentAuth | ExecutorAuth;

type RouteContext = { params: Promise<Record<string, string>> };

// ── Identity resolution (authentication) ─────────────────────────────────────

/**
 * Establish identity from a request. Bearer tokens dispatch by prefix:
 *  - `hbx_…`  exec token  → executor identity (one run; looked up by hash)
 *  - `hbrn_…` runner token → runner identity (the claim path)
 *  - `hbr_…`  API key → the creating user's identity
 *  - `harbour_session` cookie → user identity
 */
export function getIdentityFromRequest(req: NextRequest): Identity | null {
  const authHeader = req.headers.get("authorization");
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7);

    // Per-run executor token — the CLI's run-scoped callback credential.
    if (token.startsWith("hbx_")) {
      const run = getRunByExecToken(token);
      if (!run) return null;
      return {
        type: "executor",
        runId: run.id,
        runKind: run.job_kind,
        runStatus: run.status,
        agentId: run.agent_id,
        agentName: run.agent_name,
        projectId: run.project_id,
      };
    }

    // Runner token — authenticates the runner for the claim endpoint.
    if (token.startsWith("hbrn_")) {
      const runner = authenticateRunner(token);
      if (!runner) return null;
      return {
        type: "runner",
        runnerId: runner.id,
        runnerName: runner.name,
        tier: runner.tier,
        labels: runner.labels,
        scope: runner.scope,
      };
    }

    // API key (`hbr_…`) → resolves to the creating user's identity. Agents have
    // no standalone credential: a runner claims their work and the CLI
    // authenticates with the run's exec token (`hbx_…`), never an agent key.
    const apiKey = authenticateApiKey(token);
    if (apiKey) {
      return {
        type: "user",
        userId: apiKey.created_by_user_id,
        email: apiKey.email,
        displayName: apiKey.display_name,
      };
    }

    return null;
  }

  const sessionId = req.cookies.get("harbour_session")?.value;
  if (sessionId) {
    const session = getSession(sessionId);
    if (session) {
      return {
        type: "user",
        userId: session.userId,
        email: session.email,
        displayName: session.displayName,
      };
    }
  }

  return null;
}

const unauthorized = () => NextResponse.json({ error: "Unauthorized" }, { status: 401 });
const forbidden = () => NextResponse.json({ error: "Forbidden" }, { status: 403 });

/** Statuses past which a run is no longer executing — the executor goes inert. */
const TERMINAL_RUN_STATUSES = new Set(["done", "failed", "skipped", "killed"]);

// ── Wrappers ─────────────────────────────────────────────────────────────────

type Handler<A> = (req: NextRequest, auth: A, ctx: RouteContext) => Promise<Response> | Response;

/**
 * Invoke an authorized handler, turning any {@link HttpError} it throws (from
 * `readJson` or the `require*`/`optional*` validation helpers in ./http) into a
 * clean `{ error }` JSON response with the carried status. This is what lets a
 * handler validate input by throwing instead of hand-rolling a try/catch around
 * every check — a malformed body or wrong-typed field becomes a 4xx, never a
 * 500. Non-HttpError throws propagate unchanged (genuine 500s).
 */
async function runHandler<A>(
  handler: Handler<A>,
  req: NextRequest,
  auth: A,
  ctx: RouteContext,
): Promise<Response> {
  try {
    return await handler(req, auth, ctx);
  } catch (err) {
    if (err instanceof HttpError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}

/**
 * Authenticated-user routes — the standard wrapper for every dashboard/API
 * route. Any signed-in user (session or API key) passes; runners and executors
 * are rejected.
 */
export function withAuthenticatedUser(handler: Handler<UserAuth>) {
  return async (req: NextRequest, ctx: RouteContext) => {
    const identity = getIdentityFromRequest(req);
    if (!identity) return unauthorized();
    if (identity.type !== "user") return forbidden();
    return runHandler(handler, req, identity, ctx);
  };
}

/**
 * Runner Protocol auth — the claim endpoint only. Requires a runner token; the
 * handler receives the runner's tier/labels/scope so the claim path can gate
 * placement and capability.
 */
export function withRunnerAuth(handler: Handler<RunnerAuth>) {
  return async (req: NextRequest, ctx: RouteContext) => {
    const identity = getIdentityFromRequest(req);
    if (!identity) return unauthorized();
    if (identity.type !== "runner") return forbidden();
    return runHandler(handler, req, identity, ctx);
  };
}

/**
 * Authorization for a single run's lifecycle routes (status / activity / output
 * / kill / title / session / attachments). Accepts either:
 *  - the run's **executor** (exec token), bound to exactly this run id; or
 *  - any authenticated **user**.
 *
 * The run id comes from the `id` route param. An executor token presented for a
 * different run is rejected — the token grants no cross-run access.
 */
export function withRunExecutorOrUser(handler: Handler<UserAuth | ExecutorAuth>) {
  return async (req: NextRequest, ctx: RouteContext) => {
    const identity = getIdentityFromRequest(req);
    if (!identity) return unauthorized();

    const params = await ctx.params;
    const runId = params.id;
    if (!runId) return forbidden();

    if (identity.type === "executor") {
      if (identity.runId !== runId) return forbidden();
      return runHandler(handler, req, identity, ctx);
    }

    if (identity.type !== "user") return forbidden();
    return runHandler(handler, req, identity, ctx);
  };
}

/**
 * Dual-identity authorization for resource routes that BOTH dashboard users and
 * harbour agents call (docs create/update, tables create + rows + columns,
 * agents/jobs `data` helpers).
 *
 * The "agent" here is a run's executor token (the CLI's run-scoped credential) —
 * the executor acts as the run's agent. Only agent runs (non-null agent) can act
 * this way; a workflow run's executor has no agent identity and is rejected.
 */
export function withAgentOrUser(handler: Handler<AuthContext>) {
  return async (req: NextRequest, ctx: RouteContext) => {
    const identity = getIdentityFromRequest(req);
    if (!identity) return unauthorized();

    if (identity.type === "executor") {
      // Only agent-run executors carry an agent/project to act as.
      if (!identity.agentId || !identity.projectId) return forbidden();
      // The executor acts as its agent only while the run is executing. Once the
      // run is terminal, a lingering/leaked exec token must not keep writing the
      // agent's docs/tables — resource writes happen during the work turn.
      if (TERMINAL_RUN_STATUSES.has(identity.runStatus)) return forbidden();
      return runHandler(
        handler,
        req,
        {
          type: "agent",
          agentId: identity.agentId,
          agentName: identity.agentName ?? "Agent",
          projectId: identity.projectId,
        },
        ctx,
      );
    }

    if (identity.type !== "user") return forbidden();
    return runHandler(handler, req, identity, ctx);
  };
}

/** Map an auth context to an actor tuple for activity/authorship records. */
export function getActorFromAuth(auth: AuthContext): {
  actorType: string;
  actorId: string;
} {
  if (auth.type === "user") {
    return { actorType: "user", actorId: auth.userId };
  }
  if (auth.type === "executor") {
    // Workflow-run executors author as 'workflow'; agent-run executors as 'agent'.
    return auth.runKind === "workflow"
      ? { actorType: "workflow", actorId: auth.runId }
      : { actorType: "agent", actorId: auth.agentId ?? auth.runId };
  }
  return { actorType: "agent", actorId: auth.agentId };
}

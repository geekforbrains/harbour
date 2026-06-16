import { cookies } from "next/headers";
import { type NextRequest, NextResponse } from "next/server";
import {
  meets,
  orgIdForProject,
  orgIdForResource,
  type ResourceKind,
  type Role,
  resolveAccess,
} from "./db/access";
import {
  authenticateAdminApiKey,
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

/** Options for the `harbour_session` cookie. `maxAge` defaults to 30 days. */
export function sessionCookieOptions(req: NextRequest, maxAge: number = 60 * 60 * 24 * 30) {
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
 * Identity established by authentication (who is calling), before authorization
 * (what they're allowed to do). Agent keys carry the agent's home project so
 * `withAgentAuth` can scope ownership without an extra lookup.
 */
type UserIdentity = {
  type: "user";
  userId: string;
  email: string;
  displayName: string;
};

/**
 * A runner authenticated by its bearer token (`hbrn_…`). Carries only the
 * registry facts; the runner's live capabilities arrive in each claim body, so
 * they aren't resolved here. Used by the claim endpoint via {@link withRunnerAuth}.
 */
type RunnerIdentity = {
  type: "runner";
  runnerId: string;
  runnerName: string;
  tier: RunnerTier;
  labels: string[];
  scope: RunnerScope;
};

/**
 * A single run's executor, authenticated by that run's exec token (`hbx_…`,
 * minted at claim). It's the credential the runner hands its spawned CLI, so the
 * high-value runner token never reaches the CLI. Scoped to exactly one run; for
 * agent runs it also carries the agent/project so it can act as that agent on
 * resource routes (docs/tables) the CLI calls.
 */
type ExecutorIdentity = {
  type: "executor";
  runId: string;
  runKind: string;
  runStatus: string;
  agentId: string | null;
  agentName: string | null;
  projectId: string | null;
  orgId: string;
};

export type Identity = UserIdentity | RunnerIdentity | ExecutorIdentity;

// ── Authorized auth context handed to route handlers ─────────────────────────

/** What an authorized user handler receives. Role is resolved within `orgId`. */
export type UserAuth = {
  type: "user";
  userId: string;
  email: string;
  displayName: string;
  orgId: string;
  role: Role;
};

/** What an authorized agent handler receives. */
export type AgentAuth = {
  type: "agent";
  agentId: string;
  agentName: string;
  orgId: string;
  projectId: string;
};

/** What the claim handler receives — the runner plus its registry facts. */
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
  projectId: string | null;
  orgId: string;
};

export type AuthContext = UserAuth | AgentAuth | ExecutorAuth;

type RouteContext = { params: Promise<Record<string, string>> };

// ── Identity resolution (authentication) ─────────────────────────────────────

/**
 * Establish identity from a request. Bearer tokens dispatch by prefix:
 *  - `hbx_…`  exec token  → executor identity (one run; looked up by hash)
 *  - `hbrn_…` runner token → runner identity (the claim path)
 *  - `hbr_…`  admin API key → the creating user's identity
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
        orgId: run.org_id,
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

    // Admin API key (`hbr_…`) → resolves to the creating user's identity.
    // Agents have no standalone credential: a runner claims their work and the
    // CLI authenticates with the run's exec token (`hbx_…`), never an agent key.
    const adminKey = authenticateAdminApiKey(token);
    if (adminKey) {
      return {
        type: "user",
        userId: adminKey.created_by_user_id,
        email: adminKey.email,
        displayName: adminKey.display_name,
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

// ── Scope resolution helpers ─────────────────────────────────────────────────

/**
 * Resolve the org a request targets. Order of precedence:
 *  1. explicit `orgId` query param
 *  2. `harbour_org` active-org cookie (set by the org switcher)
 *  3. for a plain member, their single org (best-effort) — left to the caller.
 * Returns null when no org can be determined.
 */
function orgIdFromRequest(req: NextRequest, orgParam: string): string | null {
  const fromQuery = req.nextUrl.searchParams.get(orgParam);
  if (fromQuery) return fromQuery;
  const fromCookie = req.cookies.get("harbour_org")?.value;
  if (fromCookie) return fromCookie;
  return null;
}

function checkRole(identity: Identity, orgId: string, min: Role): Role | null {
  if (identity.type !== "user") return null;
  const role = resolveAccess(identity.userId, orgId);
  return meets(role, min) ? role : null;
}

function asUserAuth(identity: UserIdentity, orgId: string, role: Role): UserAuth {
  return {
    type: "user",
    userId: identity.userId,
    email: identity.email,
    displayName: identity.displayName,
    orgId,
    role,
  };
}

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
 * Org-scoped authorization. Target org comes from the `orgId` query param (or
 * the active-org cookie). `role` is the minimum required; instance_admin always
 * satisfies it.
 */
export function withOrgAuth(handler: Handler<UserAuth>, opts: { role: Role; orgParam?: string }) {
  const orgParam = opts.orgParam ?? "orgId";
  return async (req: NextRequest, ctx: RouteContext) => {
    const identity = getIdentityFromRequest(req);
    if (!identity) return unauthorized();
    if (identity.type !== "user") return forbidden();

    const orgId = orgIdFromRequest(req, orgParam);
    if (!orgId) return forbidden();

    const role = checkRole(identity, orgId, opts.role);
    if (!role) return forbidden();

    return runHandler(handler, req, asUserAuth(identity, orgId, role), ctx);
  };
}

/**
 * Project-scoped authorization. Target project comes from the `projectId` query
 * param; its owning org is resolved and the role is checked against that org.
 */
export function withProjectAuth(
  handler: Handler<UserAuth>,
  opts: { role: Role; projectParam?: string },
) {
  const projectParam = opts.projectParam ?? "projectId";
  return async (req: NextRequest, ctx: RouteContext) => {
    const identity = getIdentityFromRequest(req);
    if (!identity) return unauthorized();
    if (identity.type !== "user") return forbidden();

    const projectId = req.nextUrl.searchParams.get(projectParam);
    if (!projectId) return forbidden();

    const orgId = orgIdForProject(projectId);
    if (!orgId) return forbidden();

    const role = checkRole(identity, orgId, opts.role);
    if (!role) return forbidden();

    return runHandler(handler, req, asUserAuth(identity, orgId, role), ctx);
  };
}

/**
 * Resource-scoped authorization for `[id]` routes. Resolves the resource's
 * owning org via `orgIdForResource(kind, id)` and checks the role there.
 * Not-found resolves to 403 (don't leak existence across orgs).
 */
export function withResourceAuth(kind: ResourceKind, idParam: string, opts: { role: Role }) {
  return (handler: Handler<UserAuth>) => async (req: NextRequest, ctx: RouteContext) => {
    const identity = getIdentityFromRequest(req);
    if (!identity) return unauthorized();
    if (identity.type !== "user") return forbidden();

    const params = await ctx.params;
    const id = params[idParam];
    if (!id) return forbidden();

    const orgId = orgIdForResource(kind, id);
    if (!orgId) return forbidden();

    const role = checkRole(identity, orgId, opts.role);
    if (!role) return forbidden();

    return runHandler(handler, req, asUserAuth(identity, orgId, role), ctx);
  };
}

/**
 * Authenticated-user routes with no org scope: pure instance-global system info
 * that any signed-in user needs to render the dashboard (timezone list, CLI
 * tool detection, upload limits, video-tooling probe). Agents are rejected.
 * `auth.orgId`/`auth.role` are sentinel values — these handlers don't use them.
 */
export function withAuthenticatedUser(handler: Handler<UserAuth>) {
  return async (req: NextRequest, ctx: RouteContext) => {
    const identity = getIdentityFromRequest(req);
    if (!identity) return unauthorized();
    if (identity.type !== "user") return forbidden();
    return runHandler(handler, req, asUserAuth(identity, "*", "viewer"), ctx);
  };
}

/**
 * Instance-admin-only routes (users / orgs / admin-api-keys management). No org
 * scope — instance admins span all orgs.
 */
export function withInstanceAdmin(handler: Handler<UserAuth>) {
  return async (req: NextRequest, ctx: RouteContext) => {
    const identity = getIdentityFromRequest(req);
    if (!identity) return unauthorized();
    if (identity.type !== "user") return forbidden();

    // is_instance_admin everywhere → resolveAccess returns 'instance_admin' for
    // any org id. Use a sentinel org; membership lookup is skipped for admins.
    const role = resolveAccess(identity.userId, "*");
    if (role !== "instance_admin") return forbidden();

    return runHandler(handler, req, asUserAuth(identity, "*", role), ctx);
  };
}

/**
 * Runner Protocol auth — the claim endpoint only. Requires a runner token; the
 * handler receives the runner's tier/labels/scope so the claim path can gate
 * placement and capability. Viewer users never reach an execution path.
 */
export function withRunnerAuth(handler: Handler<RunnerAuth>) {
  return async (req: NextRequest, ctx: RouteContext) => {
    const identity = getIdentityFromRequest(req);
    if (!identity) return unauthorized();
    if (identity.type !== "runner") return forbidden();

    return runHandler(
      handler,
      req,
      {
        type: "runner",
        runnerId: identity.runnerId,
        runnerName: identity.runnerName,
        tier: identity.tier,
        labels: identity.labels,
        scope: identity.scope,
      },
      ctx,
    );
  };
}

/**
 * Authorization for a single run's lifecycle routes (status / activity / output
 * / kill / title / session / attachments). Accepts either:
 *  - the run's **executor** (exec token), bound to exactly this run id; or
 *  - a **user** meeting `opts.role` in the run's org.
 *
 * The run id comes from the `id` route param. An executor token presented for a
 * different run is rejected — the token grants no cross-run access.
 */
export function withRunExecutorOrUser(
  handler: Handler<UserAuth | ExecutorAuth>,
  opts: { role: Role },
) {
  return async (req: NextRequest, ctx: RouteContext) => {
    const identity = getIdentityFromRequest(req);
    if (!identity) return unauthorized();

    const params = await ctx.params;
    const runId = params.id;
    if (!runId) return forbidden();

    if (identity.type === "executor") {
      if (identity.runId !== runId) return forbidden();
      return runHandler(
        handler,
        req,
        {
          type: "executor",
          runId: identity.runId,
          runKind: identity.runKind,
          agentId: identity.agentId,
          agentName: identity.agentName,
          projectId: identity.projectId,
          orgId: identity.orgId,
        },
        ctx,
      );
    }

    if (identity.type === "user") {
      const orgId = orgIdForResource("run", runId);
      if (!orgId) return forbidden();
      const role = checkRole(identity, orgId, opts.role);
      if (!role) return forbidden();
      return runHandler(handler, req, asUserAuth(identity, orgId, role), ctx);
    }

    return forbidden();
  };
}

/**
 * Dual-identity authorization for resource routes that BOTH dashboard users and
 * harbour agents call (docs create/update, tables create + rows + columns,
 * agents/jobs `data` helpers). Users are checked against `opts.role` in the
 * resource's org; agents are scoped to their own project's org.
 *
 * The "agent" here is a run's executor token (the CLI's run-scoped credential) —
 * the executor acts as the run's agent, scoped to the run's project. Only agent
 * runs (non-null agent/project) can act this way; a workflow run's executor has
 * no agent identity and is rejected.
 *
 * - For `[id]` routes, pass a resolver that derives the target org from params
 *   (e.g. via `orgIdForResource`). For create routes with no resource id yet,
 *   the org is taken from the executor's run project (agents) or the
 *   `orgId`/`harbour_org` scope (users).
 */
export function withAgentOrUser(
  handler: Handler<AuthContext>,
  opts: {
    role: Role;
    /** Resolve the target org from route params; null if not yet known. */
    orgFromParams?: (params: Record<string, string>) => string | null;
  },
) {
  return async (req: NextRequest, ctx: RouteContext) => {
    const identity = getIdentityFromRequest(req);
    if (!identity) return unauthorized();

    const params = await ctx.params;
    const resolvedOrg = opts.orgFromParams ? opts.orgFromParams(params) : undefined;

    // Resolve an agent-shaped context from the run's executor token (agent runs
    // only) — agents have no standalone key; the CLI acts as its agent via the
    // exec token while the run executes.
    let agentCtx: AgentAuth | null = null;
    if (identity.type === "executor") {
      // Only agent-run executors carry an agent/project to act as.
      if (!identity.agentId || !identity.projectId) return forbidden();
      // The executor acts as its agent only while the run is executing. Once the
      // run is terminal, a lingering/leaked exec token must not keep writing the
      // agent's docs/tables — resource writes happen during the work turn.
      if (TERMINAL_RUN_STATUSES.has(identity.runStatus)) return forbidden();
      agentCtx = {
        type: "agent",
        agentId: identity.agentId,
        agentName: identity.agentName ?? "Agent",
        orgId: identity.orgId,
        projectId: identity.projectId,
      };
    }

    if (agentCtx) {
      // If the route targets a specific resource, it must live in the agent's org.
      if (resolvedOrg !== undefined) {
        if (resolvedOrg === null) return forbidden();
        if (resolvedOrg !== agentCtx.orgId) return forbidden();
      }
      return runHandler(handler, req, agentCtx, ctx);
    }

    if (identity.type !== "user") return forbidden();

    // User path
    let orgId = resolvedOrg ?? undefined;
    if (orgId === undefined) {
      orgId = orgIdFromRequest(req, "orgId") ?? undefined;
    }
    if (!orgId) return forbidden();
    const role = checkRole(identity, orgId, opts.role);
    if (!role) return forbidden();
    return runHandler(handler, req, asUserAuth(identity, orgId, role), ctx);
  };
}

// ── Misc helpers (preserved) ─────────────────────────────────────────────────

export async function getAuthFromCookies(): Promise<{
  userId: string;
  email: string;
  displayName: string;
  isInstanceAdmin: boolean;
} | null> {
  const cookieStore = await cookies();
  const sessionId = cookieStore.get("harbour_session")?.value;
  if (!sessionId) return null;
  const session = getSession(sessionId);
  if (!session) return null;
  return {
    userId: session.userId,
    email: session.email,
    displayName: session.displayName,
    isInstanceAdmin: session.isInstanceAdmin,
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

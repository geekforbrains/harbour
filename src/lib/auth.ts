import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import {
  getSession,
  authenticateAgent,
  authenticateWorkflowRunner,
  authenticateAdminApiKey,
} from "./db/queries";
import {
  resolveAccess,
  meets,
  orgIdForProject,
  orgIdForResource,
  type Role,
  type ResourceKind,
} from "./db/access";

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

type AgentIdentity = {
  type: "agent";
  agentId: string;
  agentName: string;
  projectId: string;
};

type WorkflowRunnerIdentity = {
  type: "workflow_runner";
  runnerId: string;
  runnerName: string;
  orgId: string;
};

export type Identity = UserIdentity | AgentIdentity | WorkflowRunnerIdentity;

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

export type WorkflowRunnerAuth = {
  type: "workflow_runner";
  runnerId: string;
  runnerName: string;
  orgId: string;
};

export type AuthContext = UserAuth | AgentAuth | WorkflowRunnerAuth;

type RouteContext = { params: Promise<Record<string, string>> };

// ── Identity resolution (authentication) ─────────────────────────────────────

/**
 * Establish identity from a request. Mechanics are preserved from v1:
 *  - Bearer agent API key  → agent identity (carries home project)
 *  - Bearer admin API key  → the creating user's identity
 *  - `harbour_session` cookie → user identity
 */
export function getIdentityFromRequest(req: NextRequest): Identity | null {
  const authHeader = req.headers.get("authorization");
  if (authHeader?.startsWith("Bearer ")) {
    const apiKey = authHeader.slice(7);

    const agent = authenticateAgent(apiKey);
    if (agent) {
      return {
        type: "agent",
        agentId: agent.id,
        agentName: agent.name,
        projectId: agent.project_id,
      };
    }

    const workflowRunner = authenticateWorkflowRunner(apiKey);
    if (workflowRunner) {
      return {
        type: "workflow_runner",
        runnerId: workflowRunner.id,
        runnerName: workflowRunner.name,
        orgId: workflowRunner.org_id,
      };
    }

    // Admin API keys resolve to the creating user's identity.
    const adminKey = authenticateAdminApiKey(apiKey);
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

const unauthorized = () =>
  NextResponse.json({ error: "Unauthorized" }, { status: 401 });
const forbidden = () =>
  NextResponse.json({ error: "Forbidden" }, { status: 403 });

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

type Handler<A> = (
  req: NextRequest,
  auth: A,
  ctx: RouteContext
) => Promise<Response> | Response;

/**
 * Org-scoped authorization. Target org comes from the `orgId` query param (or
 * the active-org cookie). `role` is the minimum required; instance_admin always
 * satisfies it.
 */
export function withOrgAuth(
  handler: Handler<UserAuth>,
  opts: { role: Role; orgParam?: string }
) {
  const orgParam = opts.orgParam ?? "orgId";
  return async (req: NextRequest, ctx: RouteContext) => {
    const identity = getIdentityFromRequest(req);
    if (!identity) return unauthorized();
    if (identity.type !== "user") return forbidden();

    const orgId = orgIdFromRequest(req, orgParam);
    if (!orgId) return forbidden();

    const role = checkRole(identity, orgId, opts.role);
    if (!role) return forbidden();

    return handler(req, asUserAuth(identity, orgId, role), ctx);
  };
}

/**
 * Project-scoped authorization. Target project comes from the `projectId` query
 * param; its owning org is resolved and the role is checked against that org.
 */
export function withProjectAuth(
  handler: Handler<UserAuth>,
  opts: { role: Role; projectParam?: string }
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

    return handler(req, asUserAuth(identity, orgId, role), ctx);
  };
}

/**
 * Resource-scoped authorization for `[id]` routes. Resolves the resource's
 * owning org via `orgIdForResource(kind, id)` and checks the role there.
 * Not-found resolves to 403 (don't leak existence across orgs).
 */
export function withResourceAuth(
  kind: ResourceKind,
  idParam: string,
  opts: { role: Role }
) {
  return (handler: Handler<UserAuth>) =>
    async (req: NextRequest, ctx: RouteContext) => {
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

      return handler(req, asUserAuth(identity, orgId, role), ctx);
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
    return handler(req, asUserAuth(identity, "*", "viewer"), ctx);
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

    return handler(req, asUserAuth(identity, "*", role), ctx);
  };
}

/**
 * Agent poll/report routes. Requires an agent API key. The handler receives the
 * agent's org and project so it can verify the target run/agent belongs to the
 * agent's project via {@link requireAgentProject}.
 */
export function withAgentAuth(handler: Handler<AgentAuth>) {
  return async (req: NextRequest, ctx: RouteContext) => {
    const identity = getIdentityFromRequest(req);
    if (!identity) return unauthorized();
    if (identity.type !== "agent") return forbidden();

    const orgId = orgIdForProject(identity.projectId);
    if (!orgId) return forbidden();

    return handler(
      req,
      {
        type: "agent",
        agentId: identity.agentId,
        agentName: identity.agentName,
        orgId,
        projectId: identity.projectId,
      },
      ctx
    );
  };
}

export function withWorkflowRunnerAuth(handler: Handler<WorkflowRunnerAuth>) {
  return async (req: NextRequest, ctx: RouteContext) => {
    const identity = getIdentityFromRequest(req);
    if (!identity) return unauthorized();
    if (identity.type !== "workflow_runner") return forbidden();

    return handler(
      req,
      {
        type: "workflow_runner",
        runnerId: identity.runnerId,
        runnerName: identity.runnerName,
        orgId: identity.orgId,
      },
      ctx
    );
  };
}

/**
 * Dual-identity authorization for resource routes that BOTH dashboard users and
 * harbour agents call (docs create/update, databases create + rows + columns,
 * agents/jobs `data` helpers). Users are checked against `opts.role` in the
 * resource's org; agents are scoped to their own project's org.
 *
 * - For `[id]` routes, pass a resolver that derives the target org from params
 *   (e.g. via `orgIdForResource`). For create routes with no resource id yet,
 *   the org is taken from the agent's project (agents) or the `orgId`/`harbour_org`
 *   scope (users).
 */
export function withAgentOrUser(
  handler: Handler<AuthContext>,
  opts: {
    role: Role;
    /** Permit workflow-runner credentials. Use only on workflow-run endpoints. */
    allowWorkflowRunner?: boolean;
    /** Resolve the target org from route params; null if not yet known. */
    orgFromParams?: (params: Record<string, string>) => string | null;
  }
) {
  return async (req: NextRequest, ctx: RouteContext) => {
    const identity = getIdentityFromRequest(req);
    if (!identity) return unauthorized();

    const params = await ctx.params;
    const resolvedOrg = opts.orgFromParams ? opts.orgFromParams(params) : undefined;

    if (identity.type === "agent") {
      const agentOrg = orgIdForProject(identity.projectId);
      if (!agentOrg) return forbidden();
      // If the route targets a specific resource, it must live in the agent's org.
      if (resolvedOrg !== undefined) {
        if (resolvedOrg === null) return forbidden();
        if (resolvedOrg !== agentOrg) return forbidden();
      }
      return handler(
        req,
        {
          type: "agent",
          agentId: identity.agentId,
          agentName: identity.agentName,
          orgId: agentOrg,
          projectId: identity.projectId,
        },
        ctx
      );
    }

    if (identity.type === "workflow_runner") {
      if (!opts.allowWorkflowRunner) return forbidden();
      if (resolvedOrg !== undefined) {
        if (resolvedOrg === null) return forbidden();
        if (resolvedOrg !== identity.orgId) return forbidden();
      }
      return handler(
        req,
        {
          type: "workflow_runner",
          runnerId: identity.runnerId,
          runnerName: identity.runnerName,
          orgId: identity.orgId,
        },
        ctx
      );
    }

    // User path
    let orgId = resolvedOrg ?? undefined;
    if (orgId === undefined) {
      orgId = orgIdFromRequest(req, "orgId") ?? undefined;
    }
    if (!orgId) return forbidden();
    const role = checkRole(identity, orgId, opts.role);
    if (!role) return forbidden();
    return handler(req, asUserAuth(identity, orgId, role), ctx);
  };
}

// ── Agent ownership checks (project-aware) ───────────────────────────────────

/**
 * Verify a resource's owning project matches the calling agent's project.
 * Returns a 403 response on mismatch, or null when access is allowed.
 * A null resource project (e.g. a workflow run with no agent) passes through.
 */
export function requireAgentProject(
  auth: AgentAuth,
  kind: ResourceKind,
  id: string
): NextResponse | null {
  const orgId = orgIdForResource(kind, id);
  if (orgId === null) {
    // Resource doesn't exist; let the handler return its own 404.
    return null;
  }
  if (orgId !== auth.orgId) return forbidden();
  return null;
}

/**
 * Verify the calling agent owns the given agent id (its own id). Used by the
 * `/agents/[id]/next` poll route.
 */
export function requireAgentSelf(
  auth: AgentAuth,
  agentId: string
): NextResponse | null {
  if (auth.agentId !== agentId) return forbidden();
  return null;
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
  if (auth.type === "workflow_runner") {
    return { actorType: "agent", actorId: auth.runnerId };
  }
  return { actorType: "agent", actorId: auth.agentId };
}

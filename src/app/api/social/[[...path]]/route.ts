import { NextRequest, NextResponse } from "next/server";

import { withAuth, withUserAuth } from "@/lib/auth";
import {
  DISTRIBUTION_PROVIDERS,
  SOCIAL_PLATFORMS,
  createLocalSocialExport,
  createLocalSocialBatch,
  getSocialDashboard,
  getSocialSignal,
  getSocialSignals,
  getSocialSourceConfigs,
  type SocialBatchRequest,
  type SocialPlatformId,
} from "@/lib/social-intelligence";

type SocialRouteParams = {
  path?: string[];
};

function normalizePath(params: Record<string, unknown>): string[] {
  const value = params.path;
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === "string") return [value];
  return [];
}

function platformFromPath(path: string[], fallback?: string | null): SocialPlatformId {
  const candidate = path[0] || fallback || "overview";
  if (SOCIAL_PLATFORMS.some(platform => platform.id === candidate)) {
    return candidate as SocialPlatformId;
  }
  return "overview";
}

async function proxyToEngine(req: NextRequest, path: string[]) {
  const engineUrl = process.env.SOCIAL_ENGINE_URL;
  if (!engineUrl) return null;

  const apiPath = path.length ? path.join("/") : "dashboard";
  const target = new URL(`/v1/social/${apiPath}`, engineUrl);
  req.nextUrl.searchParams.forEach((value, key) => target.searchParams.set(key, value));

  const headers = new Headers();
  const contentType = req.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);
  const apiKey = process.env.SOCIAL_ENGINE_API_KEY;
  if (apiKey) headers.set("authorization", `Bearer ${apiKey}`);
  headers.set("x-harbour-social-proxy", "true");

  const init: RequestInit = { method: req.method, headers };
  if (req.method !== "GET" && req.method !== "HEAD") {
    init.body = await req.text();
  }

  try {
    const response = await fetch(target, init);
    const body = await response.text();
    return new NextResponse(body, {
      status: response.status,
      headers: {
        "content-type": response.headers.get("content-type") || "application/json",
      },
    });
  } catch (error) {
    return NextResponse.json({
      error: "Social engine unavailable",
      detail: error instanceof Error ? error.message : "Unknown proxy failure",
      target: target.toString(),
    }, { status: 502 });
  }
}

export const GET = withAuth(async (req, _auth, ctx) => {
  const params = await ctx.params as unknown as SocialRouteParams;
  const path = normalizePath(params as Record<string, unknown>);

  const proxied = await proxyToEngine(req, path);
  if (proxied) return proxied;

  if (path[0] === "platforms") {
    return NextResponse.json(SOCIAL_PLATFORMS);
  }

  if (path[0] === "distribution" && path[1] === "providers") {
    return NextResponse.json(DISTRIBUTION_PROVIDERS);
  }

  if (path[0] === "distribution" && path[1] === "accounts") {
    return NextResponse.json({ accounts: [], status: "unconfigured", providers: DISTRIBUTION_PROVIDERS });
  }

  if (path[0] === "distribution" && path[1] === "jobs" && path[2]) {
    return NextResponse.json({
      id: path[2],
      status: "unknown",
      message: "Configure SOCIAL_ENGINE_URL to resolve live distribution jobs.",
    });
  }

  const platform = path[0] === "dashboard"
    ? req.nextUrl.searchParams.get("platform")
    : platformFromPath(path, req.nextUrl.searchParams.get("platform"));

  if (path[0] === "source-configs") {
    return NextResponse.json(getSocialSourceConfigs(req.nextUrl.searchParams.get("platform")));
  }

  if (path[1] === "source-configs") {
    return NextResponse.json(getSocialSourceConfigs(platform));
  }

  const detailId =
    path[0] === "videos" && path[1] ? path[1]
      : path[0] === "items" && path[1] ? path[1]
        : path[1] === "items" && path[2] ? path[2]
          : null;

  if (detailId) {
    const item = getSocialSignal(platform, detailId);
    if (!item) {
      return NextResponse.json({ error: "Social item not found", id: detailId, platform }, { status: 404 });
    }
    return NextResponse.json({ item, platform, status: "scaffold" });
  }

  if (path[0] === "videos" || path[0] === "items" || path[1] === "items") {
    return NextResponse.json({ items: getSocialSignals(platform), status: "scaffold" });
  }

  if (path[0] === "trends" || path[1] === "trends") {
    return NextResponse.json({ platform, trends: getSocialSignals(platform), status: "scaffold" });
  }

  if ((path[0] === "batches" && path[1]) || (path[1] === "batches" && path[2])) {
    return NextResponse.json({
      id: path[1] === "batches" ? path[2] : path[1],
      platform,
      status: "unknown",
      message: "Configure SOCIAL_ENGINE_URL to resolve live batch status.",
    });
  }

  return NextResponse.json(getSocialDashboard(platform));
});

export const POST = withUserAuth(async (req, _auth, ctx) => {
  const params = await ctx.params as unknown as SocialRouteParams;
  const path = normalizePath(params as Record<string, unknown>);

  const proxied = await proxyToEngine(req, path);
  if (proxied) return proxied;

  const body = await req.json().catch(() => ({})) as SocialBatchRequest;

  if (path.includes("drafts")) {
    return NextResponse.json({
      id: `social-draft-${Date.now()}`,
      status: "draft_ready",
      provider: body.provider || "blotato",
      sourceItemId: body.sourceItemId || null,
      message: "Draft accepted by Harbour fallback. Configure SOCIAL_ENGINE_URL for live Blotato/Ominsocial drafting.",
    }, { status: 202 });
  }

  if (path.includes("schedule") || path.includes("publish")) {
    return NextResponse.json({
      id: `distribution-job-${Date.now()}`,
      status: "approval_required",
      provider: body.provider || "blotato",
      draftId: body.draftId || null,
      message: "Publishing requires operator approval and live distribution credentials in the social engine.",
    }, { status: 202 });
  }

  if (path.includes("exports")) {
    const platform = platformFromPath(path, body.platform);
    return NextResponse.json(createLocalSocialExport({ ...body, platform }), { status: 202 });
  }

  if (path.includes("source-configs")) {
    const platform = platformFromPath(path, body.platform);
    return NextResponse.json({
      id: `source-config-${Date.now()}`,
      platform,
      status: "manual_review_required",
      policy_basis: "source_config_created_in_harbour_fallback",
      message: "Configure SOCIAL_ENGINE_URL to persist source configs in the social engine.",
    }, { status: 202 });
  }

  const platform = platformFromPath(path, body.platform);
  return NextResponse.json(createLocalSocialBatch({ ...body, platform }), { status: 202 });
});

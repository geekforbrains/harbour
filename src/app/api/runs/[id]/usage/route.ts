import { NextResponse } from "next/server";
import { withRunExecutorOrUser } from "@/lib/auth";
import { addRunUsage, getRunById } from "@/lib/db/queries";
import { badRequest, readJson, requireNonNegativeInt } from "@/lib/http";

// Per-post ceiling on each token delta. A single CLI turn is bounded by model
// context windows at a few million tokens; 1e10 is absurdly generous headroom
// while keeping the cumulative int64 columns unreachable from overflow even
// under sustained abuse (the exec token lives in the spawned CLI's env, so a
// misbehaving agent can hit this route).
const MAX_USAGE_DELTA = 10_000_000_000;

// The runner posts each CLI turn's token usage as a delta; the server folds it
// into the run's cumulative counters (addRunUsage), so resumed runs keep
// counting across attempts. Executor-only — users never write run usage.
export const POST = withRunExecutorOrUser(async (req, auth, { params }) => {
  const { id } = await params;
  const run = getRunById(id);
  if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });

  if (auth.type !== "executor") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await readJson(req);
  const inputTokens = requireNonNegativeInt(body.input_tokens, "input_tokens");
  const outputTokens = requireNonNegativeInt(body.output_tokens, "output_tokens");
  if (inputTokens > MAX_USAGE_DELTA || outputTokens > MAX_USAGE_DELTA) {
    badRequest(`token deltas must be at most ${MAX_USAGE_DELTA} per post`);
  }

  addRunUsage(id, { input_tokens: inputTokens, output_tokens: outputTokens });
  return NextResponse.json({ ok: true });
});

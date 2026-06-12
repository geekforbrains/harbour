/**
 * Next.js boot hook — runs once at server startup (dev and prod).
 *
 * Opening the DB here forces schema creation + verification at boot, so a
 * drifted database fails the server immediately with a precise diff instead
 * of 500ing per-request once traffic arrives (see verifySchema in
 * src/lib/db/schema.ts). Exit explicitly: a thrown error leaves the
 * standalone server alive-but-broken, which a process supervisor would
 * happily keep "running"; a hard exit surfaces the failure.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { getDb } = await import("@/lib/db/schema");
    try {
      getDb();
    } catch (err) {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    }
  }
}

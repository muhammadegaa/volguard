import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Constant-time secret comparison.
 *
 * Both sides are hashed first so the buffers are always the same length — `timingSafeEqual`
 * throws on a length mismatch, and returning early on length would itself leak the secret's
 * size. An empty or missing expected value never matches.
 */
export function secretMatches(expected: string | undefined, provided: string | null): boolean {
  if (!expected || !provided) return false;
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(expected), digest(provided));
}

/** Paper execution requires the VolGuard operator token. */
export function hasOperatorToken(request: Request): boolean {
  return secretMatches(process.env.VOLGUARD_OPERATOR_TOKEN, request.headers.get("x-volguard-token"));
}

/**
 * Scheduled runs accept the operator token, or a Vercel Cron invocation which arrives as
 * `Authorization: Bearer $CRON_SECRET`.
 */
export function hasScheduleAuthorization(request: Request): boolean {
  if (hasOperatorToken(request)) return true;
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return false;
  return secretMatches(process.env.CRON_SECRET, header.slice("Bearer ".length));
}

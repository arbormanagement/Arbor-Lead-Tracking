import { timingSafeEqual } from "node:crypto";

/**
 * Constant-time secret comparison for the header-gated admin/cron routes.
 * A plain `===` on secrets leaks match length/prefix through timing; this
 * compares byte-for-byte in constant time once lengths match. Missing/empty
 * values never match anything (fail closed).
 */
export function secretEquals(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

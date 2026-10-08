import "server-only";
import { timingSafeEqual } from "node:crypto";

// Constant-time comparison for shared secrets (bearer tokens, sweep secrets),
// so response timing can't leak the secret byte by byte. Length-guarded first
// because timingSafeEqual throws on unequal lengths (a negligible, intended leak).
export function secretMatches(provided: string | null | undefined, expected: string): boolean {
  if (provided == null) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// ─── Envelope encryption for secrets at rest ─────────────────────────────
//
// Third-party credentials (Slack bot token, Linear access token, Jira
// access/refresh tokens) live on the `workspaces` row. A read of that table
// would otherwise hand an attacker full control of every connected
// integration. This module seals those values with AES-256-GCM before they
// hit the database and opens them on the way out.
//
// Stored format — all parts base64url, so the whole thing is ASCII-safe for a
// `text` column:
//
//   enc:1:<keyId>:<iv>:<authTag>:<ciphertext>
//
// `open()` returns any value WITHOUT the `enc:` prefix unchanged. That keeps
// two things working:
//   1. Legacy plaintext rows written before this landed (until the backfill
//      script re-encrypts them — see packages/db/src/backfill-encrypt-secrets.ts).
//   2. Self-host deployments that never set an encryption key — seal() is a
//      no-op there, so the feature is opt-in and upgrades don't break.
//
// Key source: CRUMB_ENCRYPTION_KEY — 32 bytes, given as 64 hex chars or as
// base64/base64url. For key rotation, additional historical keys can be
// supplied as CRUMB_ENCRYPTION_KEY_<id> (e.g. CRUMB_ENCRYPTION_KEY_2); open()
// looks up the key named in the ciphertext, while seal() always writes under
// the current key id (CRUMB_ENCRYPTION_KEY_ID, default "1").

const PREFIX = "enc";
const VERSION = "1";
const ALGO = "aes-256-gcm";
const IV_BYTES = 12; // GCM standard nonce length

function parseKey(raw: string): Buffer | null {
  const s = raw.trim();
  if (!s) return null;
  // 64 hex chars → 32 bytes.
  if (/^[0-9a-fA-F]{64}$/.test(s)) return Buffer.from(s, "hex");
  // Otherwise treat as base64 / base64url.
  const buf = Buffer.from(s, "base64");
  return buf.length === 32 ? buf : null;
}

// Build the keyring once from the environment: { "1": <key>, "2": <oldKey>, … }.
// `null` if no key is configured at all.
let keyringCache: { current: string; keys: Map<string, Buffer> } | null | undefined;

function keyring(): { current: string; keys: Map<string, Buffer> } | null {
  if (keyringCache !== undefined) return keyringCache;
  const keys = new Map<string, Buffer>();

  const primary = process.env.CRUMB_ENCRYPTION_KEY && parseKey(process.env.CRUMB_ENCRYPTION_KEY);
  const currentId = process.env.CRUMB_ENCRYPTION_KEY_ID?.trim() || "1";
  if (primary) keys.set(currentId, primary);

  // Historical keys for rotation: CRUMB_ENCRYPTION_KEY_<id>.
  for (const [name, value] of Object.entries(process.env)) {
    const m = name.match(/^CRUMB_ENCRYPTION_KEY_(.+)$/);
    if (!m || m[1] === "ID" || !value) continue;
    const key = parseKey(value);
    if (key) keys.set(m[1], key);
  }

  keyringCache = keys.size > 0 ? { current: currentId, keys } : null;
  return keyringCache;
}

// Test-only: reset the memoized keyring so env changes take effect.
export function __resetKeyringForTests(): void {
  keyringCache = undefined;
}

export function isEncryptionConfigured(): boolean {
  return keyring() !== null;
}

let warnedMissingKey = false;

// Seal a plaintext secret for storage. No-op (returns the input) when no
// encryption key is configured, so self-host works without the key set.
export function seal(plaintext: string): string {
  const ring = keyring();
  if (!ring) {
    if (!warnedMissingKey) {
      warnedMissingKey = true;
      // eslint-disable-next-line no-console
      console.warn(
        "[crumb/crypto] CRUMB_ENCRYPTION_KEY not set — storing integration secrets in plaintext. " +
          "Set a 32-byte key (64 hex chars) to encrypt secrets at rest.",
      );
    }
    return plaintext;
  }
  const key = ring.keys.get(ring.current)!;
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    PREFIX,
    VERSION,
    ring.current,
    iv.toString("base64url"),
    tag.toString("base64url"),
    ct.toString("base64url"),
  ].join(":");
}

// Open a stored secret. Returns non-`enc:` values unchanged (legacy plaintext
// / no-key deployments). Throws if the value is sealed but the named key is
// unavailable — silently returning garbage would be worse than failing loud.
export function open(stored: string): string {
  if (!stored.startsWith(`${PREFIX}:`)) return stored;
  const parts = stored.split(":");
  if (parts.length !== 6 || parts[1] !== VERSION) {
    throw new Error("crypto_at_rest_bad_format");
  }
  const [, , keyId, ivB64, tagB64, ctB64] = parts;
  const ring = keyring();
  const key = ring?.keys.get(keyId);
  if (!key) throw new Error(`crypto_at_rest_missing_key:${keyId}`);
  const decipher = createDecipheriv(ALGO, key, Buffer.from(ivB64, "base64url"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
  const pt = Buffer.concat([decipher.update(Buffer.from(ctB64, "base64url")), decipher.final()]);
  return pt.toString("utf8");
}

export function sealNullable(plaintext: string | null | undefined): string | null {
  return plaintext == null ? null : seal(plaintext);
}

export function openNullable(stored: string | null | undefined): string | null {
  return stored == null ? null : open(stored);
}

// Secret-looking values come out of a URL (or a body) before it leaves the
// page: the widget's page URLs (submissions, crumb.track) and the recorder's
// page and network capture. Same names as the server's redactContextUrl in
// apps/dashboard/lib/validation.ts, which a unit test holds this to. Matched
// lowercased with separators stripped, so access_token, accessToken and
// X-Amz-Signature all hit.
// ponytail: name heuristic that errs toward redacting (author, zipcode); a
// secret under an innocent name still goes out.
const SECRET_KEY = /pass|pwd|secret|token|auth|key$|code$|credential|signature|session|cookie|jwt|csrf|xsrf|otp|verifier|cvv|cvc|ssn|cardnumber|^(sig|sid|pin)$/;

export function isSecretKey(k: string): boolean {
  let name = k;
  try { name = decodeURIComponent(k.replace(/\+/g, " ")); } catch { /* malformed escape: match it raw */ }
  return SECRET_KEY.test(name.toLowerCase().replace(/[^a-z0-9]/g, ""));
}

// key=value pairs in a query string, #fragment, ;matrix param or form body.
const PAIR = /(^|[?#&;])([^=&#;?]*)=([^&#;?]*)/g;
export function redactPairs(s: string): string {
  return s.replace(PAIR, (m, sep: string, k: string) => (isSecretKey(k) ? `${sep}${k}=[redacted]` : m));
}

export function redactUrl(url: string): string {
  return redactPairs(url.replace(/^([a-z][a-z\d+.-]*:\/\/)[^/?#@]*@/i, "$1")); // drops user:pass@ too
}

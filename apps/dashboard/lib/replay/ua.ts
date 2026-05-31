import "server-only";

// Tiny hand-rolled user-agent parser — enough to label a replay's device in
// the session-details panel (browser, OS, desktop/mobile/tablet). We avoid a
// dependency (cf. lib/jwt.ts hand-rolling HS256); UA strings are messy but the
// common cases are cheap to match. Returns nulls for anything unrecognized.

export type UaInfo = {
  deviceType: string | null; // "desktop" | "mobile" | "tablet"
  browserName: string | null;
  browserVersion: string | null;
  osName: string | null;
  osVersion: string | null;
};

const EMPTY: UaInfo = {
  deviceType: null, browserName: null, browserVersion: null, osName: null, osVersion: null,
};

function cap(s: string | null, n = 32): string | null {
  return s ? s.slice(0, n) : null;
}

function ver(re: RegExp, ua: string): string | null {
  const m = ua.match(re);
  return m && m[1] ? m[1].replace(/_/g, ".") : null;
}

export function parseUserAgent(ua: string | null | undefined): UaInfo {
  const s = (ua ?? "").trim();
  if (!s) return EMPTY;

  // ── OS ──
  let osName: string | null = null;
  let osVersion: string | null = null;
  if (/Windows NT/.test(s)) {
    osName = "Windows";
    const nt = ver(/Windows NT ([0-9.]+)/, s);
    osVersion = nt === "10.0" ? "10/11" : nt; // UA can't distinguish 10 from 11
  } else if (/iPhone|iPad|iPod/.test(s)) {
    osName = "iOS";
    osVersion = ver(/OS ([0-9_]+)/, s);
  } else if (/Mac OS X/.test(s)) {
    osName = "macOS";
    osVersion = ver(/Mac OS X ([0-9_]+)/, s);
  } else if (/Android/.test(s)) {
    osName = "Android";
    osVersion = ver(/Android ([0-9.]+)/, s);
  } else if (/CrOS/.test(s)) {
    osName = "ChromeOS";
  } else if (/Linux/.test(s)) {
    osName = "Linux";
  }

  // ── Browser (order matters: Edge/Opera/Samsung all carry "Chrome") ──
  let browserName: string | null = null;
  let browserVersion: string | null = null;
  if (/Edg\//.test(s)) { browserName = "Edge"; browserVersion = ver(/Edg\/([0-9.]+)/, s); }
  else if (/OPR\/|Opera/.test(s)) { browserName = "Opera"; browserVersion = ver(/(?:OPR|Opera)\/([0-9.]+)/, s); }
  else if (/SamsungBrowser\//.test(s)) { browserName = "Samsung Internet"; browserVersion = ver(/SamsungBrowser\/([0-9.]+)/, s); }
  else if (/Firefox\//.test(s)) { browserName = "Firefox"; browserVersion = ver(/Firefox\/([0-9.]+)/, s); }
  else if (/Chrome\//.test(s)) { browserName = "Chrome"; browserVersion = ver(/Chrome\/([0-9.]+)/, s); }
  else if (/Version\/[0-9.]+.*Safari/.test(s)) { browserName = "Safari"; browserVersion = ver(/Version\/([0-9.]+)/, s); }
  else if (/Safari\//.test(s)) { browserName = "Safari"; }

  // ── Device type ──
  let deviceType = "desktop";
  if (/iPad|Tablet|PlayBook/.test(s) || /Android(?!.*Mobile)/.test(s)) deviceType = "tablet";
  else if (/Mobi|iPhone|iPod|Windows Phone/.test(s)) deviceType = "mobile";

  return {
    deviceType,
    browserName: cap(browserName),
    browserVersion: cap(browserVersion),
    osName: cap(osName),
    osVersion: cap(osVersion),
  };
}

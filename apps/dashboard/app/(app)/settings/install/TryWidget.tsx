"use client";

import { useState, useTransition } from "react";
import { Btn } from "@crumb/ui";
import { errorMessage } from "@/lib/action-error";
import { mintTestToken } from "./actions";

// The real widget.js in a sandboxed srcdoc frame (opaque origin, like the
// Branding site preview), talking to this deployment's public API with a
// test-customer token. The token rides in the frame's HTML, never a URL.
// crumb.open() pops the panel so there's something to see straight away; a
// widget.js that won't load (bad CRUMB_APP_URL, unbuilt widget) says so
// instead of leaving a blank frame.
function previewDoc(origin: string, slug: string, token: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"></head><body>
<script src="${origin}/widget.js" data-workspace="${slug}" data-user-jwt="${token}" defer
  onerror="document.body.style.cssText='font:13px/1.5 system-ui,sans-serif;color:GrayText;margin:16px';document.body.textContent='Couldn’t load the widget from '+this.src"></script>
<script>addEventListener("DOMContentLoaded", function () { if (window.crumb) crumb.open(); });</script>
</body></html>`;
}

export function TryWidget({ origin, slug, canTry }: { origin: string; slug: string; canTry: boolean }) {
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (!canTry) {
    return <p className="text-sm muted note">Admins and PMs can load a preview here.</p>;
  }

  const start = () => {
    setError(null);
    startTransition(async () => {
      const r = await mintTestToken();
      if (r.ok) setToken(r.token);
      else setError(errorMessage(r.error));
    });
  };

  return (
    <div className="col gap-3">
      <div className="row gap-2 center" style={{ flexWrap: "wrap" }}>
        <Btn variant={token ? undefined : "primary"} sm={!!token} onClick={start} disabled={pending}>
          {pending ? "Loading…" : token ? "Restart preview" : "Try the widget"}
        </Btn>
        {token && <span className="text-xs muted">The test token expires after 15 minutes.</span>}
        {error && <span className="text-xs" role="alert" style={{ color: "var(--err-text)" }}>{error}</span>}
      </div>
      {token && (
        <iframe
          key={token}
          title="Widget preview"
          sandbox="allow-scripts allow-popups"
          srcDoc={previewDoc(origin, slug, token)}
          style={{ width: "100%", height: 600, border: "var(--border)", borderRadius: "var(--r-sm)" }}
        />
      )}
    </div>
  );
}

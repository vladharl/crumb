"use client";

import { useEffect, type CSSProperties } from "react";

// Last resort for whatever no error.tsx catches: the root layout, the app
// shell's own session lookup, and the pages outside it (sign-in, onboarding,
// QBR). It replaces <html>, so globals.css and the fonts may be gone: every
// style is inline and each token carries its DESIGN.md value as a fallback.
// Both ways out are full page loads, since the client router may be what broke.
// Logs only the digest, which matches the server's log line.
const button: CSSProperties = {
  font: "inherit",
  fontWeight: 500,
  lineHeight: 1.2,
  padding: "8px 14px",
  borderRadius: 4,
  border: "1px solid var(--text, #4A2E1F)",
  cursor: "pointer",
  textDecoration: "none",
};

export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  useEffect(() => {
    if (error.digest) console.error(`Crumb error, digest ${error.digest}`);
  }, [error.digest]);

  return (
    <html lang="en">
      <body style={{
        margin: 0,
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        padding: 16,
        boxSizing: "border-box",
        background: "var(--cream, #FBF7F0)",
        color: "var(--text, #4A2E1F)",
        fontFamily: "system-ui, sans-serif",
        fontSize: 14,
        lineHeight: 1.5,
      }}>
        <main style={{ maxWidth: 380 }}>
          <h1 style={{ fontSize: 22, fontWeight: 600, lineHeight: 1.2, margin: "0 0 8px" }}>Something went wrong</h1>
          <p style={{ margin: "0 0 20px" }}>Crumb couldn&apos;t load this page. Try again in a moment.</p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              type="button"
              onClick={() => window.location.reload()}
              style={{ ...button, background: "var(--text, #4A2E1F)", color: "var(--cream, #FBF7F0)" }}
            >
              Try again
            </button>
            <a href="/inbox" style={{ ...button, color: "var(--text, #4A2E1F)" }}>Back to inbox</a>
          </div>
        </main>
      </body>
    </html>
  );
}

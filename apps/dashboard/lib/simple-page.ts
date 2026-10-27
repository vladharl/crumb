import "server-only";
import { NextResponse } from "next/server";

// A one-card HTML page for links opened from email (unsubscribe, check-in):
// no app shell, no login.
export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// Crumb's paper tokens (app/globals.css), inlined: this page has no app shell.
const CSS =
  `:root{--bg:#FBF7F0;--surface:#FDFAF4;--text:#4A2E1F;--text-2:#6A4528;--mute:rgba(74,46,31,.74);` +
  `--hair:rgba(74,46,31,.10);--focus-ring:#9C4C17;--accent-soft:#FCE9D6}` +
  `*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:16px;` +
  `background:var(--bg);color:var(--text);font:13px/1.5 Inter,system-ui,sans-serif;-webkit-font-smoothing:antialiased}` +
  `main{width:380px;max-width:100%;background:var(--surface);border:1px solid var(--hair);border-radius:6px;padding:28px}` +
  `.eyebrow{margin:0 0 8px;font-size:10px;font-weight:500;letter-spacing:.14em;text-transform:uppercase;color:var(--mute)}` +
  `h1{margin:0 0 6px;font:600 20px/1.2 "General Sans",system-ui,sans-serif;letter-spacing:-.015em}p{margin:0}` +
  `form{margin-top:20px}.note{margin-top:16px;font-size:12px;color:var(--mute)}` +
  `button{font:500 12px/1.2 Inter,system-ui,sans-serif;padding:8px 14px;border-radius:4px;cursor:pointer;` +
  `border:1px solid var(--text);background:transparent;color:var(--text)}button:hover{background:var(--text);color:var(--bg)}` +
  `button.primary{background:var(--text);color:var(--bg)}button.primary:hover{background:var(--text-2)}` +
  `:focus-visible{outline:2px solid var(--focus-ring);outline-offset:0;box-shadow:0 0 0 5px var(--accent-soft)}`;

// Every string here is HTML: callers escape what they interpolate (esc).
export function page(o: { ws?: string; title: string; text: string; extra?: string }, status = 200) {
  const body = `<!doctype html><html lang=en><head><meta charset=utf-8>` +
    `<meta name=viewport content="width=device-width,initial-scale=1"><title>${o.title}</title>` +
    `<style>${CSS}</style></head><body><main>` +
    (o.ws ? `<p class=eyebrow>${o.ws}</p>` : "") +
    `<h1>${o.title}</h1><p>${o.text}</p>${o.extra ?? ""}</main></body></html>`;
  return new NextResponse(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

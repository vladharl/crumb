import { NextResponse } from "next/server";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const HEX = /^#[0-9a-f]{6}$/i;

// Crumb's paper tokens (app/globals.css), inlined: a route handler's page has
// no app shell. Same card as the customer unsubscribe page (api/v1/unsubscribe).
const CSS =
  `:root{--bg:#FBF7F0;--surface:#FDFAF4;--text:#4A2E1F;--text-2:#6A4528;--mute:rgba(74,46,31,.74);` +
  `--hair:rgba(74,46,31,.10);--focus-ring:#9C4C17;--accent-soft:#FCE9D6}` +
  `*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:16px;` +
  `background:var(--bg);color:var(--text);font:13px/1.5 Inter,system-ui,sans-serif;-webkit-font-smoothing:antialiased}` +
  `main{width:380px;max-width:100%;background:var(--surface);border:1px solid var(--hair);border-radius:6px;padding:28px}` +
  `.eyebrow{margin:0 0 8px;font-size:10px;font-weight:500;letter-spacing:.14em;text-transform:uppercase;color:var(--mute)}` +
  `h1{margin:0 0 6px;font:600 20px/1.2 "General Sans",system-ui,sans-serif;letter-spacing:-.015em}p{margin:0}` +
  `form{margin-top:20px}.note{margin-top:16px;font-size:12px;color:var(--mute)}a{color:var(--text)}` +
  `button{font:500 12px/1.2 Inter,system-ui,sans-serif;padding:8px 14px;border-radius:4px;cursor:pointer;` +
  `border:1px solid var(--text);background:var(--text);color:var(--bg)}button:hover{background:var(--text-2)}` +
  `:focus-visible{outline:2px solid var(--focus-ring);outline-offset:0;box-shadow:0 0 0 5px var(--accent-soft)}`;

// The small page a public follow's confirm and unsubscribe links land on, under
// the vendor's name and Branding dot. Text in, escaped here; `button` posts
// back to the same URL, `link` points somewhere on this origin.
export function followPage(o: {
  ws?: { name: string; accent: string };
  title: string;
  text: string;
  button?: string;
  link?: { href: string; label: string };
}, status = 200): NextResponse {
  const dot = o.ws && HEX.test(o.ws.accent) ? `<span aria-hidden=true style="color:${o.ws.accent}">&#9679;</span> ` : "";
  const body = `<!doctype html><html lang=en><head><meta charset=utf-8>` +
    `<meta name=viewport content="width=device-width,initial-scale=1">` +
    // The URL is a capability: keep it out of search results and Referer headers.
    `<meta name=robots content=noindex><meta name=referrer content=no-referrer>` +
    `<title>${esc(o.title)}</title><style>${CSS}</style></head><body><main>` +
    (o.ws ? `<p class=eyebrow>${dot}${esc(o.ws.name)}</p>` : "") +
    `<h1>${esc(o.title)}</h1><p>${esc(o.text)}</p>` +
    (o.button ? `<form method=post><button>${esc(o.button)}</button></form>` : "") +
    (o.link ? `<p class=note><a href="${esc(o.link.href)}">${esc(o.link.label)}</a></p>` : "") +
    `</main></body></html>`;
  return new NextResponse(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

export const invalidLink = () => followPage({
  title: "This link doesn’t work",
  text: "It may be incomplete or out of date.",
}, 400);

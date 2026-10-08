import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, type Page } from "@playwright/test";
import { mintWidgetJwt } from "./mint";

export const SLUG = "southbeam";

// A customer's app with the widget embedded as Settings → Install says: one
// <script src="…/widget.js" data-…> tag, on another origin than Crumb's (so
// every call is a real cross-origin one, with no dashboard cookie). Any path
// serves the page; its query becomes the tag's data-* attributes
// (?user-jwt=…&app-version=4.2.1). A search box and a "Give feedback" button
// give focus specs a place on the host page to start from.
export async function startWidgetHost(crumbOrigin: string) {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  const server = createServer((req, res) => {
    const query = new URL(req.url ?? "/", "http://host").searchParams;
    const attrs = [...query].map(([k, v]) => ` data-${esc(k)}="${esc(v)}"`).join("");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Acme Reports</title></head>
<body>
  <h1>Acme Reports</h1>
  <input id="host-search" aria-label="Search reports">
  <button id="host-feedback" onclick="crumb.open()">Give feedback</button>
  <script src="${esc(crumbOrigin)}/widget.js" data-workspace="${SLUG}"${attrs} defer></script>
</body>
</html>`);
  });
  await new Promise<void>((done) => server.listen(0, done));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://localhost:${port}`,
    url: (path: string, attrs: Record<string, string> = {}) => `http://localhost:${port}${path}?${new URLSearchParams(attrs)}`,
    close: () => new Promise<void>((done) => { server.close(() => done()); server.closeAllConnections(); }),
  };
}

// A new customer per call, so their list holds only what the spec made. `jwt`
// lasts an hour; `token()` signs the same customer with other times.
export function widgetCustomer(name: string, extra: { account_name?: string; role?: "admin" | "member" } = {}) {
  const email = `widget-${name.toLowerCase().replace(/\W+/g, "-")}+${Date.now()}${Math.random().toString(36).slice(2, 6)}@example.com`;
  const claims = { sub: email, name, account_name: `${name} Co`, ...extra };
  const jwt = mintWidgetJwt(SLUG, claims);
  return {
    email,
    jwt,
    headers: { authorization: `Bearer ${jwt}` },
    token: (times: { iat: number; exp: number }) => mintWidgetJwt(SLUG, { ...claims, ...times }),
  };
}

// The edge tab: "Feedback", or "Feedback, 2 updates" with loop news.
export const launcher = (page: Page) => page.getByRole("button", { name: /^Feedback/ });

export async function openPanel(page: Page) {
  await launcher(page).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  return dialog;
}

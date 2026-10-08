import { NextResponse } from "next/server";
import { followFromUnsubscribeLink, unsubscribePublicFollows } from "@/lib/public-follows";
import { followPage, invalidLink } from "../follow-page";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const target = (req: Request) => {
  const q = new URL(req.url).searchParams;
  return followFromUnsubscribeLink(q.get("f") ?? "", q.get("s") ?? "");
};

// GET /<slug>/unsubscribe?f=<follow id>&s=<signature>: the link in every
// public follow update. It only asks: mail scanners open every link in a
// message, so a GET that wrote would silently unsubscribe people.
export async function GET(req: Request) {
  const f = await target(req);
  if (!f) return invalidLink();
  return followPage({
    ws: f.ws,
    title: `Stop emails from ${f.ws.name}?`,
    text: `You’ll stop getting roadmap and changelog updates from ${f.ws.name}.`,
    button: "Unsubscribe",
  });
}

// POST, same URL: the button above, or an RFC 8058 one-click from the inbox
// (body List-Unsubscribe=One-Click, what the List-Unsubscribe-Post header
// advertises), which gets no page.
export async function POST(req: Request) {
  const f = await target(req);
  if (!f) return invalidLink();
  await unsubscribePublicFollows(f);
  const form = await req.formData().catch(() => null);
  if (form?.get("List-Unsubscribe") === "One-Click") return new NextResponse(null, { status: 200 });
  return followPage({
    ws: f.ws,
    title: "You’re unsubscribed",
    text: `${f.ws.name} won’t email you updates anymore. You can follow again from its public pages.`,
    link: f.ws.pagesOn ? { href: `/${f.ws.slug}/roadmap`, label: "Back to the roadmap" } : undefined,
  });
}

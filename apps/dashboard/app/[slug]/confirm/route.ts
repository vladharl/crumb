import { confirmPublicFollow, followFromConfirmToken, type FollowTarget } from "@/lib/public-follows";
import { followPage, invalidLink } from "../follow-page";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const what = (f: FollowTarget) =>
  f.initiativeName ? `${f.initiativeName} moves on ${f.ws.name}'s roadmap` : `${f.ws.name} posts an update`;

const target = (req: Request) => followFromConfirmToken(new URL(req.url).searchParams.get("t") ?? "");

// GET /<slug>/confirm?t=<token>: the link in a public follow's confirmation
// email. It only asks: mail scanners open every link in a message, so a GET
// that confirmed would sign up people who never clicked.
export async function GET(req: Request) {
  const f = await target(req);
  if (!f) return invalidLink();
  return followPage({ ws: f.ws, title: "Confirm your email", text: `Get an email when ${what(f)}.`, button: "Confirm" });
}

// POST, same URL: the Confirm button above. Following again after an
// unsubscribe turns emails back on only here, on the click.
export async function POST(req: Request) {
  const f = await target(req);
  if (!f) return invalidLink();
  await confirmPublicFollow(f.id);
  const page = f.initiativeName ? "roadmap" : "changelog";
  return followPage({
    ws: f.ws,
    title: "You’re following",
    text: `You’ll get an email when ${what(f)}. Every email has a link to stop.`,
    link: f.ws.pagesOn ? { href: `/${f.ws.slug}/${page}`, label: `Back to the ${page}` } : undefined,
  });
}

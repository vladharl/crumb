import { cache, type ReactNode } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { originFromHeaders } from "@/lib/origin";
import { publicWorkspace } from "@/lib/public-follows";
import { formatDate } from "@/lib/timefmt";

// The public roadmap and changelog (/<slug>/roadmap, /<slug>/changelog): the
// vendor's pages for anyone with the link, no session and no dashboard chrome.
// They 404 until an admin turns them on (Settings, Branding).

type PublicWs = NonNullable<Awaited<ReturnType<typeof publicWorkspace>>>;
type PageKey = "roadmap" | "changelog";

// One query per request, shared by the page and its metadata.
export const loadPublicWorkspace = cache(publicWorkspace);

export function publicMetadata(ws: PublicWs, page: PageKey, description: string): Metadata {
  const origin = originFromHeaders(headers());
  const title = `${ws.name} ${page}`;
  const path = `/${ws.slug}/${page}`;
  return {
    title: { absolute: title },
    description,
    ...(origin ? { metadataBase: new URL(origin) } : {}),
    alternates: { canonical: path },
    openGraph: { title, description, url: path, siteName: ws.name, type: "website" },
    twitter: { card: "summary", title, description },
  };
}

const HEX = /^#[0-9a-f]{6}$/i;
const ACTIVE = { background: "var(--text)", color: "var(--cream)" };

export function PublicShell({ ws, page, title, lede, width, children }: {
  ws: PublicWs;
  page: PageKey;
  title: string;
  lede: string;
  width: number;
  children: ReactNode;
}) {
  const accent = HEX.test(ws.accent) ? ws.accent : null;
  return (
    <main style={{ minHeight: "100vh", padding: "40px 16px 64px" }}>
      <div className="col gap-6" style={{ maxWidth: width, margin: "0 auto" }}>
        <header className="col gap-5">
          <div className="row gap-3" style={{ justifyContent: "space-between", flexWrap: "wrap" }}>
            <span className="row gap-2 serif text-lg">
              {accent && <span aria-hidden style={{ color: accent }}>&#9679;</span>}
              {ws.name}
            </span>
            <nav aria-label={`${ws.name} updates`} className="seg">
              {(["roadmap", "changelog"] as const).map(p => (
                <Link key={p} href={`/${ws.slug}/${p}`} aria-current={p === page ? "page" : undefined} style={p === page ? ACTIVE : undefined}>
                  {p === "roadmap" ? "Roadmap" : "Changelog"}
                </Link>
              ))}
            </nav>
          </div>
          <div className="col gap-2">
            <h1 style={{ fontSize: "var(--fs-3xl)", lineHeight: 1.1 }}>{title}</h1>
            <p className="text-md muted note">{lede}</p>
          </div>
        </header>
        {children}
      </div>
      {/* The Follow disclosure's summary reads as a button, without the marker. */}
      <style dangerouslySetInnerHTML={{ __html: `
        .public-follow > summary { list-style: none; }
        .public-follow > summary::-webkit-details-marker { display: none; }
        .public-follow[open] > summary { margin-bottom: 12px; }
      ` }} />
    </main>
  );
}

export const dayLabel = (d: Date | string) => formatDate(d, { utc: true });

"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Ic } from "@crumb/ui";

type NavItem = { href: string; label: string; icon: (typeof Ic)[keyof typeof Ic]; cloudOnly?: boolean };
type NavGroup = { title: string | null; items: NavItem[] };

// Grouped by job, in journey order: first you set Crumb up, then you connect
// it to your tools, then you run the workspace; "You" holds the only per-user
// page so personal prefs read as personal. (Billing is cloud-only — Stripe;
// hidden on the community edition, where the page isn't wired and Stripe is
// stubbed at build.)
const GROUPS: NavGroup[] = [
  {
    title: null,
    items: [
      { href: "/settings", label: "Overview", icon: Ic.settings },
    ],
  },
  {
    title: "Set up",
    items: [
      { href: "/settings/install",  label: "Install widget", icon: Ic.doc },
      { href: "/settings/branding", label: "Branding",       icon: Ic.globe },
    ],
  },
  {
    title: "Connections",
    items: [
      { href: "/settings/integrations", label: "Integrations", icon: Ic.plug },
      { href: "/settings/webhooks",     label: "Webhooks",     icon: Ic.send },
    ],
  },
  {
    title: "Workspace",
    items: [
      { href: "/settings/team",            label: "Team & roles",    icon: Ic.users },
      { href: "/settings/account-mapping", label: "Account mapping", icon: Ic.building },
      { href: "/settings/audit",           label: "Audit log",       icon: Ic.lock },
      { href: "/settings/billing",         label: "Billing",         icon: Ic.settings, cloudOnly: true },
    ],
  },
  {
    title: "You",
    items: [
      { href: "/settings/notifications", label: "Notifications", icon: Ic.bell },
    ],
  },
];

const IS_CLOUD = process.env.NEXT_PUBLIC_CRUMB_EDITION === "cloud";
const DOCS_URL = "https://crumb.localhostlabs.net/docs";

export function SettingsNav() {
  const pathname = usePathname();
  return (
    <div className="col gap-1">
      {GROUPS.map((g, gi) => {
        const items = g.items.filter(n => !n.cloudOnly || IS_CLOUD);
        if (items.length === 0) return null;
        return (
          <div key={g.title ?? gi} className="col gap-1">
            {g.title && (
              <span className="eyebrow" style={{ marginTop: 12, padding: "0 10px" }}>{g.title}</span>
            )}
            {items.map(n => {
              const Icon = n.icon;
              const active = pathname === n.href;
              return (
                <Link key={n.href} href={n.href} className="nav-item" aria-selected={active}>
                  <Icon className="ic" />
                  <span>{n.label}</span>
                </Link>
              );
            })}
          </div>
        );
      })}
      {/* Outbound link to the docs — kept distinct from the in-app routes. */}
      <a
        href={DOCS_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="nav-item"
        style={{ marginTop: 8, paddingTop: 12, borderTop: "var(--border)", color: "var(--mute)" }}
      >
        <Ic.doc className="ic" />
        <span>Documentation ↗</span>
      </a>
    </div>
  );
}

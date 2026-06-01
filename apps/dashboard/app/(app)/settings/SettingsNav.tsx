"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Ic } from "@crumb/ui";

type NavItem = { href: string; label: string; icon: (typeof Ic)[keyof typeof Ic]; cloudOnly?: boolean };

// Alphabetical by label. (Billing is cloud-only — Stripe; hidden on the
// community edition, where the page isn't wired and Stripe is stubbed at build.)
const NAV: NavItem[] = [
  { href: "/settings/account-mapping", label: "Account mapping",  icon: Ic.building },
  { href: "/settings/audit",           label: "Audit log",        icon: Ic.lock },
  { href: "/settings/billing",         label: "Billing",          icon: Ic.settings, cloudOnly: true },
  { href: "/settings/branding",        label: "Branding",         icon: Ic.globe },
  { href: "/settings/install",         label: "Install",          icon: Ic.doc },
  { href: "/settings/integrations",    label: "Integrations",     icon: Ic.plug },
  { href: "/settings/notifications",   label: "Notifications",    icon: Ic.bell },
  { href: "/settings/team",            label: "Team & roles",     icon: Ic.users },
  { href: "/settings/webhooks",        label: "Webhooks",         icon: Ic.send },
];

const IS_CLOUD = process.env.NEXT_PUBLIC_CRUMB_EDITION === "cloud";
const DOCS_URL = "https://crumb.localhostlabs.net/docs";

export function SettingsNav() {
  const pathname = usePathname();
  const nav = NAV.filter(n => !n.cloudOnly || IS_CLOUD);
  return (
    <div className="col gap-1">
      {nav.map(n => {
        const Icon = n.icon;
        const active = pathname === n.href;
        return (
          <Link key={n.href} href={n.href} className="nav-item" aria-selected={active}>
            <Icon className="ic" />
            <span>{n.label}</span>
          </Link>
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

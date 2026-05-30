"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Ic } from "@crumb/ui";

type NavItem = { href: string; label: string; icon: (typeof Ic)[keyof typeof Ic]; cloudOnly?: boolean };

const NAV: NavItem[] = [
  { href: "/settings/team",            label: "Team & roles",     icon: Ic.users },
  { href: "/settings/integrations",    label: "Integrations",     icon: Ic.plug },
  { href: "/settings/webhooks",        label: "Webhooks",         icon: Ic.send },
  { href: "/settings/account-mapping", label: "Account mapping",  icon: Ic.building },
  { href: "/settings/branding",        label: "Branding",         icon: Ic.globe },
  { href: "/settings/install",         label: "Install",          icon: Ic.doc },
  { href: "/settings/audit",           label: "Audit log",        icon: Ic.lock },
  // Billing is a cloud-only surface (Stripe). Hidden on the community edition,
  // where the page isn't wired and Stripe is stubbed out at build time.
  { href: "/settings/billing",         label: "Billing",          icon: Ic.settings, cloudOnly: true },
];

const IS_CLOUD = process.env.NEXT_PUBLIC_CRUMB_EDITION === "cloud";

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
    </div>
  );
}

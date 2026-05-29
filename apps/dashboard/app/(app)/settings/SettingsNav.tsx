"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Ic } from "@crumb/ui";

const NAV: Array<{ href: string; label: string; icon: (typeof Ic)[keyof typeof Ic] }> = [
  { href: "/settings/team",            label: "Team & roles",     icon: Ic.users },
  { href: "/settings/integrations",    label: "Integrations",     icon: Ic.plug },
  { href: "/settings/account-mapping", label: "Account mapping",  icon: Ic.building },
  { href: "/settings/branding",        label: "Branding",         icon: Ic.globe },
  { href: "/settings/install",         label: "Install",          icon: Ic.doc },
  { href: "/settings/audit",           label: "Audit log",        icon: Ic.lock },
  { href: "/settings/billing",         label: "Billing",          icon: Ic.settings },
];

export function SettingsNav() {
  const pathname = usePathname();
  return (
    <div className="col gap-1">
      {NAV.map(n => {
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

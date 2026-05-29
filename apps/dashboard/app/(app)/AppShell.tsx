"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { BrandMark, Ic } from "@crumb/ui";

type NavLink = {
  id: string;
  href: string;
  label: string;
  icon: (typeof Ic)[keyof typeof Ic];
  match?: (path: string) => boolean;
};

const PRIMARY: NavLink[] = [
  { id: "inbox",    href: "/inbox",         label: "Inbox",         icon: Ic.inbox,
    match: p => p === "/inbox" || p.startsWith("/thread") },
  { id: "accounts", href: "/accounts",      label: "Accounts",      icon: Ic.building,
    match: p => p.startsWith("/accounts") },
  { id: "initiatives", href: "/initiatives", label: "Initiatives",   icon: Ic.link,
    match: p => p.startsWith("/initiatives") },
  { id: "notifs",   href: "/notifications", label: "Notifications", icon: Ic.bell,
    match: p => p === "/notifications" },
  { id: "roadmap",  href: "/roadmap",       label: "Roadmap",       icon: Ic.road,
    match: p => p === "/roadmap" },
];

const SECONDARY: NavLink[] = [
  { id: "settings", href: "/settings", label: "Settings", icon: Ic.settings,
    match: p => p.startsWith("/settings") },
];

export type ShellUser = {
  name: string;
  email: string;
  initials: string;
  workspaceName: string;
};

export function AppShell({ user, children }: { user: ShellUser; children: ReactNode }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onResize = () => { if (window.innerWidth >= 768) setOpen(false); };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const all = [...PRIMARY, ...SECONDARY];
  const active = all.find(n => (n.match ?? (p => p === n.href))(pathname));
  const label = active?.label ?? "";

  return (
    <div className="app">
      <div className="nav-mobile-bar">
        <button className="menu-btn" onClick={() => setOpen(true)} aria-label="Open menu">
          <Ic.menu style={{ width: 14, height: 14 }} />
        </button>
        <BrandMark width={20} height={20} />
        <span className="brand">Crumb</span>
        <span className="crumb">{label}</span>
      </div>
      <div className={`scrim ${open ? "show" : ""}`} onClick={() => setOpen(false)} />

      <nav className={`nav ${open ? "open" : ""}`}>
        <div className="nav-brand">
          <div className="mark-row">
            <BrandMark width={28} height={28} />
            <span className="name">Crumb</span>
          </div>
          <span className="tag">{user.workspaceName} · follow the trail.</span>
        </div>

        {PRIMARY.map(n => {
          const Icon = n.icon;
          const isActive = (n.match ?? (p => p === n.href))(pathname);
          return (
            <Link
              key={n.id}
              href={n.href}
              className="nav-item"
              aria-selected={isActive}
              onClick={() => setOpen(false)}
            >
              <Icon className="ic" />
              <span>{n.label}</span>
            </Link>
          );
        })}

        <div style={{ flex: 1 }} />

        <div className="nav-section" style={{ marginTop: 12 }}>Workspace</div>
        {SECONDARY.map(n => {
          const Icon = n.icon;
          const isActive = (n.match ?? (p => p === n.href))(pathname);
          return (
            <Link
              key={n.id}
              href={n.href}
              className="nav-item"
              aria-selected={isActive}
              onClick={() => setOpen(false)}
            >
              <Icon className="ic" />
              <span>{n.label}</span>
            </Link>
          );
        })}

        <div className="nav-foot" style={{ flexDirection: "column", alignItems: "stretch", gap: 8 }}>
          <div className="row gap-2 center" style={{ minWidth: 0 }}>
            <span className="avatar sm ink" style={{ flexShrink: 0 }}>{user.initials}</span>
            <div className="col" style={{ minWidth: 0, flex: 1 }}>
              <span className="text-sm fw-med truncate" style={{ display: "block" }}>{user.name}</span>
              <span className="text-xs muted truncate" style={{ display: "block" }}>{user.email}</span>
            </div>
          </div>
          <div className="row between" style={{ gap: 8 }}>
            <span className="meta">MVP v0.1</span>
            <a className="link-back" href="/logout">Sign out →</a>
          </div>
        </div>
      </nav>

      <main className="content" data-screen-label={label}>
        {children}
      </main>
    </div>
  );
}

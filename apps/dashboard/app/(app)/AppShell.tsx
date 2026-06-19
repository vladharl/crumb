"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { BrandMark, Ic } from "@crumb/ui";
import { ConfirmProvider } from "@/components/confirm";
import { ToastProvider } from "@/components/toast";
import { TourProvider, TourLauncher, useTour } from "@/components/tour";
import { CommandProvider, CommandButton, type CommandItem } from "@/components/CommandPalette";
import { NotificationBell } from "@/components/NotificationBell";

type NavLink = {
  id: string;
  href: string;
  label: string;
  icon: (typeof Ic)[keyof typeof Ic];
  match?: (path: string) => boolean;
};

// Primary destinations as top-bar tabs. Captures merged into Inbox; Notifications
// moved to the bell — both removed here. Settings lives in the avatar menu.
const PRIMARY: NavLink[] = [
  { id: "inbox",    href: "/inbox",          label: "Inbox",       icon: Ic.inbox,
    match: p => p === "/inbox" || p.startsWith("/thread") },
  { id: "accounts", href: "/accounts",       label: "Accounts",    icon: Ic.building,
    match: p => p.startsWith("/accounts") },
  { id: "initiatives", href: "/initiatives", label: "Initiatives", icon: Ic.road,
    match: p => p.startsWith("/initiatives") },
  { id: "insights", href: "/insights",       label: "Insights",    icon: Ic.chart,
    match: p => p === "/insights" },
];

// AI-gated "Ask your feedback" (feature 5). Inserted after Insights when the
// workspace has the AI feature (Cloud + plan). On self-host it stays hidden.
const ASK_LINK: NavLink = {
  id: "ask", href: "/ask", label: "Ask", icon: Ic.sparkle,
  match: p => p === "/ask",
};

// Settings sub-pages surfaced in the ⌘K palette (journey order, matching SettingsNav).
const SETTINGS_ITEMS: CommandItem[] = [
  { label: "Settings → Overview", href: "/settings", keywords: "workspace setup checklist status" },
  { label: "Settings → Install widget", href: "/settings/install", keywords: "embed snippet" },
  { label: "Settings → Branding", href: "/settings/branding", keywords: "widget theme" },
  { label: "Settings → Integrations", href: "/settings/integrations", keywords: "slack github jira linear salesforce hubspot" },
  { label: "Settings → Webhooks", href: "/settings/webhooks", keywords: "api events" },
  { label: "Settings → Team & roles", href: "/settings/team", keywords: "members invite roles" },
  { label: "Settings → Account mapping", href: "/settings/account-mapping", keywords: "crm" },
  { label: "Settings → Notifications", href: "/settings/notifications", keywords: "preferences digest email slack" },
];

export type ShellUser = {
  name: string;
  email: string;
  initials: string;
  workspaceName: string;
};

// A quiet hello for anyone who opens devtools. Crumb is open source and
// self-hostable, so the curious developer poking around the console is exactly
// the person worth greeting — in the brand's own voice, tied to its thesis
// (follow-through), with no fabricated CTA. Once per load, client-only.
let consoleGreeted = false;
function greetTheConsole() {
  if (consoleGreeted || typeof window === "undefined") return;
  consoleGreeted = true;
  const ember = "color:#E27D3A;font:600 14px/1.5 ui-sans-serif,system-ui";
  const mute = "color:#8A8278;font:400 12px/1.6 ui-sans-serif,system-ui";
  const ink = "color:#6A4528;font:400 12px/1.6 ui-sans-serif,system-ui";
  console.log(
    "%cCrumb%c  ·  follow the trail.\n" +
      "%cReading the console? That's the kind of follow-through Crumb runs on.\n" +
      "It's open source. Self-host it, read the source, make it yours.",
    ember, mute, ink,
  );
}

export function AppShell({ user, aiEnabled = false, tourDone = true, children }: { user: ShellUser; aiEnabled?: boolean; tourDone?: boolean; children: ReactNode }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  // Greet anyone who opens the console — once, on first mount.
  useEffect(() => { greetTheConsole(); }, []);

  // Close the mobile sheet when we grow back to desktop.
  useEffect(() => {
    const onResize = () => { if (window.innerWidth >= 768) setOpen(false); };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  // Close it on navigation.
  useEffect(() => { setOpen(false); }, [pathname]);

  const tabs = aiEnabled ? [...PRIMARY, ASK_LINK] : PRIMARY;
  const active = tabs.find(n => (n.match ?? (p => p === n.href))(pathname));
  const label = active?.label ?? "";

  const paletteItems: CommandItem[] = [
    ...tabs.map(n => ({ label: n.label, href: n.href })),
    ...SETTINGS_ITEMS,
  ];

  return (
    <ConfirmProvider>
    <ToastProvider>
    <TourProvider autoStart={!tourDone}>
    <CommandProvider items={paletteItems}>
    <div className="app">
      <header className="topbar">
        <button className="topbar-burger" onClick={() => setOpen(o => !o)} aria-label="Menu">
          <Ic.menu style={{ width: 16, height: 16 }} />
        </button>

        <Link href="/inbox" className="topbar-brand">
          <BrandMark width={24} height={24} />
          <span className="topbar-name">Crumb</span>
          <span className="topbar-ws">{user.workspaceName}</span>
        </Link>

        <nav className="topnav">
          {tabs.map(n => (
            <Link
              key={n.id}
              href={n.href}
              data-tour={n.id}
              className="topnav-item"
              aria-selected={(n.match ?? (p => p === n.href))(pathname)}
            >
              {n.label}
            </Link>
          ))}
        </nav>

        <div className="topbar-right">
          <CommandButton />
          <NotificationBell />
          <UserMenu user={user} />
        </div>
      </header>

      {/* Mobile nav sheet */}
      <div className={`scrim ${open ? "show" : ""}`} onClick={() => setOpen(false)} />
      <nav className={`mobile-nav ${open ? "open" : ""}`} aria-label="Sections">
        {tabs.map(n => {
          const Icon = n.icon;
          return (
            <Link
              key={n.id}
              href={n.href}
              className="nav-item"
              aria-selected={(n.match ?? (p => p === n.href))(pathname)}
              onClick={() => setOpen(false)}
            >
              <Icon className="ic" />
              <span>{n.label}</span>
            </Link>
          );
        })}
        <Link href="/settings" className="nav-item" aria-selected={pathname.startsWith("/settings")} onClick={() => setOpen(false)}>
          <Ic.settings className="ic" />
          <span>Settings</span>
        </Link>
        <div className="row between" style={{ padding: "8px 6px", marginTop: 8, borderTop: "var(--border)" }}>
          <TourLauncher />
          <a className="link-back" href="/logout">Sign out →</a>
        </div>
      </nav>

      <main className="content" data-screen-label={label}>
        {children}
      </main>
    </div>
    </CommandProvider>
    </TourProvider>
    </ToastProvider>
    </ConfirmProvider>
  );
}

// Avatar dropdown: identity + Getting started (relaunch tour) + Settings + Sign out.
function UserMenu({ user }: { user: ShellUser }) {
  const { start } = useTour();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);

  return (
    <div className="usermenu" ref={ref}>
      <button
        type="button"
        className="topbar-icon-btn"
        data-tour="settings"
        aria-label="Account menu"
        aria-expanded={open}
        onClick={() => setOpen(o => !o)}
      >
        <span className="avatar sm ink">{user.initials}</span>
      </button>
      {open && (
        <div className="usermenu-pop" role="menu">
          <div className="usermenu-id">
            <span className="text-sm fw-med truncate" style={{ display: "block" }}>{user.name}</span>
            <span className="text-xs muted truncate" style={{ display: "block" }}>{user.email}</span>
            <span className="text-xs muted truncate" style={{ display: "block", marginTop: 2 }}>{user.workspaceName}</span>
          </div>
          <button type="button" className="usermenu-item" role="menuitem" onClick={() => { setOpen(false); start(); }}>
            Getting started
          </button>
          <Link href="/settings" className="usermenu-item" role="menuitem" onClick={() => setOpen(false)}>
            Settings
          </Link>
          <a href="/logout" className="usermenu-item" role="menuitem">Sign out</a>
        </div>
      )}
    </div>
  );
}

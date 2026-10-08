"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { BrandMark, Ic } from "@crumb/ui";
import { ConfirmProvider } from "@/components/confirm";
import { ToastProvider } from "@/components/toast";
import { TourProvider, TourLauncher, useTour } from "@/components/tour";
import { CommandProvider, CommandButton, type CommandGroup, type CommandItem } from "@/components/CommandPalette";
import { HelpProvider, HelpButton, useHelp } from "@/components/HelpPanel";
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
  { id: "changelog", href: "/changelog",     label: "Changelog",   icon: Ic.doc,
    match: p => p.startsWith("/changelog") },
  { id: "insights", href: "/insights",       label: "Insights",    icon: Ic.chart,
    match: p => p === "/insights" },
];

// "Ask your feedback" (feature 5), after Insights on Cloud. Workspaces without
// the AI plan see it too and land on its upgrade notice. Self-host hides it.
const ASK_LINK: NavLink = {
  id: "ask", href: "/ask", label: "Ask", icon: Ic.sparkle,
  match: p => p === "/ask",
};

// ⌘K actions. `roles` hides what a role can't do: viewers can't compose or
// create initiatives, and only admins invite. /inbox and /initiatives open
// their form when they see the param.
const ACTIONS: CommandItem[] = [
  { label: "Compose feedback", href: "/inbox?compose=1", keywords: "new create log on behalf customer email call", roles: ["admin", "pm"] },
  { label: "New initiative", href: "/initiatives?new=1", keywords: "create theme roadmap", roles: ["admin", "pm"] },
  { label: "Invite a teammate", href: "/settings/team", keywords: "member add user team", roles: ["admin"] },
  { label: "Install the widget", href: "/settings/install", keywords: "embed snippet script setup" },
];

// Settings sub-pages surfaced in the ⌘K palette (journey order, matching SettingsNav).
const SETTINGS_ITEMS: CommandItem[] = [
  { label: "Settings → Overview", href: "/settings", keywords: "workspace setup checklist status" },
  { label: "Settings → Install widget", href: "/settings/install", keywords: "embed snippet" },
  { label: "Settings → Branding", href: "/settings/branding", keywords: "widget theme" },
  { label: "Settings → Integrations", href: "/settings/integrations", keywords: "slack github jira linear salesforce hubspot" },
  { label: "Settings → Webhooks", href: "/settings/webhooks", keywords: "api events" },
  { label: "Settings → API keys", href: "/settings/api-keys", keywords: "mcp token claude cursor" },
  { label: "Settings → Team & roles", href: "/settings/team", keywords: "members invite roles" },
  { label: "Settings → Account mapping", href: "/settings/account-mapping", keywords: "crm" },
  { label: "Settings → Audit log", href: "/settings/audit", keywords: "history activity" },
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

export function AppShell({ user, showAsk = false, tourDone = true, supportEnabled = false, children }: { user: ShellUser; showAsk?: boolean; tourDone?: boolean; supportEnabled?: boolean; children: ReactNode }) {
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

  const tabs = showAsk ? [...PRIMARY, ASK_LINK] : PRIMARY;
  const active = tabs.find(n => (n.match ?? (p => p === n.href))(pathname));
  const label = active?.label ?? "";

  const paletteGroups: CommandGroup[] = [
    { label: "Actions", items: ACTIONS },
    { label: "Go to", items: [...tabs.map(n => ({ label: n.label, href: n.href })), ...SETTINGS_ITEMS] },
  ];

  return (
    <ConfirmProvider>
    <ToastProvider>
    <TourProvider autoStart={!tourDone}>
    <CommandProvider groups={paletteGroups}>
    <HelpProvider supportEnabled={supportEnabled} userEmail={user.email}>
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
          <HelpButton />
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
        <MobileHelpButton onSelect={() => setOpen(false)} />
        <div className="row between" style={{ padding: "8px 6px", marginTop: 8, borderTop: "var(--border)" }}>
          <TourLauncher />
          <a className="link-back" href="/logout">Sign out →</a>
        </div>
      </nav>

      <main className="content" data-screen-label={label}>
        {children}
      </main>
    </div>
    </HelpProvider>
    </CommandProvider>
    </TourProvider>
    </ToastProvider>
    </ConfirmProvider>
  );
}

// Mobile-sheet entry that opens the Help panel (and closes the sheet). Split out
// because useHelp() must run inside <HelpProvider>, below AppShell in the tree.
function MobileHelpButton({ onSelect }: { onSelect: () => void }) {
  const { open } = useHelp();
  return (
    <button type="button" className="nav-item" onClick={() => { onSelect(); open(); }}>
      <Ic.q className="ic" />
      <span>Help &amp; support</span>
    </button>
  );
}

// Avatar dropdown: identity + Getting started (relaunch tour) + Help + Settings + Sign out.
function UserMenu({ user }: { user: ShellUser }) {
  const { start } = useTour();
  const { open: openHelp } = useHelp();
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
          <button type="button" className="usermenu-item" role="menuitem" onClick={() => { setOpen(false); openHelp(); }}>
            Help &amp; support
          </button>
          <Link href="/settings" className="usermenu-item" role="menuitem" onClick={() => setOpen(false)}>
            Settings
          </Link>
          <a href="/logout" className="usermenu-item" role="menuitem">Sign out</a>
          <div className="text-xs muted" style={{ display: "flex", gap: 10, padding: "8px 12px", borderTop: "var(--border)" }}>
            <a href="https://crumb.localhostlabs.net/terms" target="_blank" rel="noopener noreferrer" style={{ color: "inherit" }}>Terms</a>
            <a href="https://crumb.localhostlabs.net/privacy" target="_blank" rel="noopener noreferrer" style={{ color: "inherit" }}>Privacy</a>
          </div>
        </div>
      )}
    </div>
  );
}

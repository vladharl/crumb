"use client";

import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import { PageHead } from "@crumb/ui";
import { SettingsNav } from "./SettingsNav";

// Each settings page's heading and one-line intro. They live in the layout,
// above the nav, so the heading switches the moment a page is picked (its
// loading.tsx skeleton then fills in below an already-right head). The pages'
// own `metadata` titles name the browser tab. Keep the titles in step with
// SettingsNav's labels.
const HEADS: Record<string, { title: string; lede: string }> = {
  "/settings":                 { title: "Overview",        lede: "What's set up in this workspace, and what's left to do." },
  "/settings/install":         { title: "Install widget",  lede: "Add the widget to your product so customers can reach you from it." },
  "/settings/branding":        { title: "Branding",        lede: "How the widget looks in your product, and your public roadmap and changelog." },
  "/settings/integrations":    { title: "Integrations",    lede: "Connect your issue trackers, CRM, chat tools and support inboxes." },
  "/settings/webhooks":        { title: "Webhooks",        lede: "Signed events to your own services whenever feedback moves." },
  "/settings/api-keys":        { title: "API keys",        lede: "Keys that let an AI assistant work in this workspace over MCP." },
  "/settings/team":            { title: "Team & roles",    lede: "Who's in this workspace, and what each person can do." },
  "/settings/account-mapping": { title: "Account mapping", lede: "Which company each customer belongs to: from the widget, by hand or from a CSV." },
  "/settings/audit":           { title: "Audit log",       lede: "Status changes, replies and notes across the workspace, newest first." },
  "/settings/billing":         { title: "Billing",         lede: "Your plan, what it includes, and this month's usage." },
  "/settings/notifications":   { title: "Notifications",   lede: "What reaches you by email or Slack, and how often your digest comes." },
};

export default function SettingsLayout({ children }: { children: ReactNode }) {
  const head = HEADS[usePathname()];
  return (
    <>
      <PageHead crumb="Settings" title={head?.title ?? "Settings"} lede={head?.lede} />
      <div className="cols-aside">
        <SettingsNav />
        <div className="col gap-5">{children}</div>
      </div>
    </>
  );
}

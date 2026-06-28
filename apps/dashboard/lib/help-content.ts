// FAQ content for the in-app Help panel. Authored here as plain data so it ships
// with the app (no CMS, no markdown pipeline). Each item is a question + a short
// answer, with optional keywords (to widen search) and a single deep link into
// the app or docs. Edit freely — the panel renders whatever's here.

export const DOCS_URL = "https://crumb.localhostlabs.net/docs";

export type HelpItem = {
  q: string;
  a: string;
  /** Extra search terms not already in the question/answer. */
  keywords?: string;
  /** Optional single "go there" link rendered under the answer. */
  link?: { href: string; label: string };
};

export type HelpGroup = { group: string; items: HelpItem[] };

export const HELP_GROUPS: HelpGroup[] = [
  {
    group: "Getting started",
    items: [
      {
        q: "What is an open loop?",
        a: "Every piece of feedback in Crumb is an open loop — a request, bug, or idea you've heard but haven't closed yet. The Inbox is the list of loops still open; closing one means you've replied and resolved it.",
        keywords: "loop concept thesis follow-through",
      },
      {
        q: "How do I finish setting up?",
        a: "Settings → Overview has a setup checklist: install the widget, set your branding, connect your tools, and invite your team. Work down the list and the workspace fills in.",
        keywords: "onboarding checklist setup start",
        link: { href: "/settings", label: "Open setup checklist" },
      },
      {
        q: "How do I jump around quickly?",
        a: "Press ⌘K (Ctrl-K on Windows/Linux) anywhere to open the command palette and jump to any section or settings page.",
        keywords: "command palette shortcut keyboard navigate cmdk",
      },
      {
        q: "How do I invite my team?",
        a: "Settings → Team & roles. Invite teammates by email and choose a role for each.",
        keywords: "members roles permissions invite",
        link: { href: "/settings/team", label: "Manage team & roles" },
      },
    ],
  },
  {
    group: "Inbox & loops",
    items: [
      {
        q: "How do statuses work?",
        a: "Each item moves from open through in-progress to shipped or closed. Changing the status is how you signal progress — customers following the item are notified when it ships.",
        keywords: "status state open shipped closed resolved progress",
      },
      {
        q: "Can I reply to feedback?",
        a: "Yes. Open a thread from the Inbox and reply inline — your reply reaches the customer who submitted it, and closing the loop marks it resolved.",
        keywords: "reply respond message thread conversation close",
      },
      {
        q: "What's the difference between the Inbox and Initiatives?",
        a: "The Inbox is the raw stream of incoming loops. Initiatives group related loops into something you're deciding on or building, so the roadmap reflects real demand.",
        keywords: "initiatives roadmap group cluster theme",
      },
    ],
  },
  {
    group: "Accounts",
    items: [
      {
        q: "What are Accounts?",
        a: "Accounts roll feedback up by company, so you can weigh loops by who's asking — and by revenue, once account mapping is connected.",
        keywords: "accounts company customer revenue weight prioritize",
      },
      {
        q: "How does revenue get attached to feedback?",
        a: "Connect your CRM or billing under Settings → Account mapping. Crumb maps incoming feedback to accounts and weighs the Inbox by account value.",
        keywords: "crm salesforce hubspot mrr arr mapping revenue",
        link: { href: "/settings/account-mapping", label: "Set up account mapping" },
      },
    ],
  },
  {
    group: "Widget & install",
    items: [
      {
        q: "How do I install the widget?",
        a: "Settings → Install widget gives you a snippet to drop into your product. It coexists with tools like Intercom or Zendesk.",
        keywords: "embed snippet script install widget code",
        link: { href: "/settings/install", label: "Get the install snippet" },
      },
      {
        q: "Can customers search existing feedback?",
        a: "Yes — before submitting, customers can search existing feedback and the public roadmap from the widget, so duplicates fold together instead of piling up.",
        keywords: "search duplicate roadmap public widget customer",
      },
      {
        q: "How do I change how the widget looks?",
        a: "Settings → Branding controls the widget's colors, edge position, and launcher visibility, with a live preview against your site.",
        keywords: "branding theme color position launcher appearance",
        link: { href: "/settings/branding", label: "Customize branding" },
      },
    ],
  },
  {
    group: "Billing",
    items: [
      {
        q: "Where do I manage billing?",
        a: "On Crumb Cloud, billing lives under Settings → Billing. Self-hosted deployments run without a billing page.",
        keywords: "billing plan subscription invoice stripe payment cloud",
        link: { href: "/settings/billing", label: "Go to billing" },
      },
    ],
  },
];

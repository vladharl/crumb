// FAQ content for the in-app Help panel. Authored here as plain data so it ships
// with the app (no CMS, no markdown pipeline). Each item is a question + a short
// answer, with optional keywords (to widen search) and a single deep link into
// the app or docs. Edit freely — the panel renders whatever's here. Answers say
// what the product does today (statuses, who gets emailed and when), so check
// the code before promising more.

export const DOCS_URL = "https://crumb.localhostlabs.net/docs";

// Billing is Crumb Cloud only: self-host has no billing page to link to.
const CLOUD = process.env.NEXT_PUBLIC_CRUMB_EDITION === "cloud";

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
        a: "Every request, bug or question in Crumb is a loop that stays open until the customer hears the outcome. It closes when you mark it Shipped, Won't ship or Duplicate, or when the customer closes it from the widget. The Inbox sorts open loops by whose turn it is.",
        keywords: "loop concept thesis follow-through close closed",
      },
      {
        q: "How do I finish setting up?",
        a: "Settings → Overview has a setup checklist: install the widget, set your Product URL, invite your team, set up email, connect a tool and publish your roadmap. A new workspace also shows it at the top of the Inbox until real feedback arrives.",
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
        a: "Requests move from Open and In review to Planned and In progress, and end as Shipped, Won't ship or Duplicate. Set aside keeps a request open for later. Resolved means the customer closed it themselves from the widget.",
        keywords: "status state open review planned progress shipped declined set aside deferred duplicate resolved closed",
      },
      {
        q: "Who hears about a status change?",
        a: "The customer who sent the request, if it came in through the widget. The widget shows them every change, and they're emailed when it moves to Planned, In progress, Shipped, Won't ship or Set aside, unless they've turned those emails off or email isn't set up yet. Customers whose requests were merged into it get the same emails. People following an initiative on your public roadmap are emailed when it moves to another column.",
        keywords: "notify notification email customer told follow follower merged duplicate",
      },
      {
        q: "Can I reply to feedback?",
        a: "Yes. Reply from the thread, or with Reply on any Inbox row. Customers who wrote in through the widget see your reply there and get it by email, unless they've turned reply emails off. Use Internal note for anything only your team should see.",
        keywords: "reply respond message thread conversation email internal note",
      },
      {
        q: "Can Slack size a request for me?",
        a: "On Crumb Cloud's Team and Growth plans, yes. @mention Crumb on a message in a Slack channel it's been added to, and it replies in the thread with the request restated, the account's ARR, similar open requests and the revenue behind them, and a rough T-shirt size read from your connected repo. It only reads (nothing gets filed), answers only your teammates, and says so when it can't size a request.",
        keywords: "slack mention sizing scope arr revenue estimate t-shirt bot app_mention",
        link: { href: "/settings/integrations", label: "Connect Slack" },
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
        a: "Accounts roll feedback up by company, so you can weigh loops by who's asking and by what they pay you. ARR comes from your CRM, or you can set it by hand on any account.",
        keywords: "accounts company customer revenue weight prioritize",
      },
      {
        q: "How does revenue get attached to feedback?",
        a: "Connect HubSpot or Salesforce in Settings → Integrations and choose the field that holds what each customer pays you. Crumb syncs your companies into Accounts with their ARR, and the Inbox can rank loops by the revenue waiting on an answer. You can also set ARR by hand on any account.",
        keywords: "crm salesforce hubspot mrr arr revenue sync",
        link: { href: "/settings/integrations", label: "Connect a CRM" },
      },
      {
        q: "How do customers get grouped into accounts?",
        a: "Accounts fill in on their own: the widget tells Crumb which company each customer belongs to. Settings → Account mapping is where you add, rename or delete accounts, move people between them, and import or export a CSV.",
        keywords: "account mapping csv import export move company",
        link: { href: "/settings/account-mapping", label: "Open account mapping" },
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
        a: "Customers can search their own feedback and your public roadmap from the widget. If what they want is already on the roadmap, they can follow it there instead of sending a new request.",
        keywords: "search duplicate roadmap public widget customer follow",
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
      CLOUD
        ? {
            q: "Where do I manage billing?",
            a: "Settings → Billing shows your plan, what it includes and this month's usage. Admins can change the plan or update payment details there.",
            keywords: "billing plan subscription invoice stripe payment upgrade",
            link: { href: "/settings/billing", label: "Go to billing" },
          }
        : {
            q: "Where do I manage billing?",
            a: "Self-hosted Crumb is free under the AGPL, so there's no plan or bill to manage.",
            keywords: "billing plan subscription invoice payment self-host license",
          },
    ],
  },
];

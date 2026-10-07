import Link from "next/link";
import { getActiveSession } from "@/lib/server";
import { PLAN_FEATURES, planDisplayName, type Feature, type Plan } from "@/lib/entitlements";

// Paywall and AI-budget notices: say what's locked or paused, and give admins
// the way through to billing. Server components (they read PLAN_FEATURES, and
// the session when no role is passed), so a client component takes one
// pre-rendered as a prop instead of importing it.

type NoticeCopy = { text: string; hint: string | null; href: string | null };

// Mid-sentence names for what each plan feature gets you, worded like the
// billing page's PLAN_FEATURES lines.
const FEATURE_NAME: Record<Feature, string> = {
  ai: "the AI suite: clustering, Ask, ticket and reply drafts",
  integrations: "one-click Slack, Linear, Jira and GitHub, plus CRM sync and feedback connectors",
  session_record: "session replay",
  usage_analytics: "product usage analytics",
};

const BILLING = "/settings/billing";

// Names the cheapest plan whose PLAN_FEATURES lines include `feature`, so the
// notice and the billing page can't disagree. Admins get "See plans" with that
// plan preselected; everyone else is pointed at an admin.
export function upgradeNoticeCopy(feature: Feature, isAdmin: boolean): NoticeCopy {
  const plan = (["team", "growth"] as const).find(p => PLAN_FEATURES.some(l => l.feature === feature && l.plans.includes(p)));
  return {
    text: plan
      ? `The ${planDisplayName(plan)} plan adds ${FEATURE_NAME[feature]}.`
      : `Paid plans add ${FEATURE_NAME[feature]}.`,
    hint: isAdmin ? null : "Ask an admin to upgrade.",
    href: isAdmin ? (plan ? `${BILLING}?plan=${plan}` : BILLING) : null,
  };
}

// This month's AI budget: a heads-up from 80%, "paused" at 100%, nothing below.
// Only Team has a bigger plan to move to, so only its admins get the link.
export function aiUsageCopy(percent: number, resetsAt: Date, isAdmin: boolean, plan: Plan): NoticeCopy | null {
  if (percent < 80) return null;
  const date = resetsAt.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  return {
    text: percent >= 100
      ? `AI is paused until ${date}.`
      : `You've used ${percent}% of this month's AI operations. Resets ${date}.`,
    hint: null,
    href: isAdmin && plan === "team" ? BILLING : null,
  };
}

// Neutral on purpose: a hairline box on the card surface, not the success or
// error banner. The action is a plain outline button; ember stays on the trail.
function Notice({ text, hint, href }: NoticeCopy) {
  return (
    <div role="note" className="row gap-3 text-sm" style={{
      justifyContent: "space-between",
      flexWrap: "wrap",
      background: "var(--surface)",
      border: "var(--border)",
      borderRadius: "var(--r-sm)",
      padding: "10px 12px",
      lineHeight: 1.55,
    }}>
      <span>{text}{hint && <span className="muted"> {hint}</span>}</span>
      {href && <Link href={href} className="btn sm" style={{ textDecoration: "none" }}>See plans</Link>}
    </div>
  );
}

export async function UpgradeNotice({ feature, isAdmin }: { feature: Feature; isAdmin?: boolean }) {
  const admin = isAdmin ?? ((await getActiveSession()).user.role === "admin");
  return <Notice {...upgradeNoticeCopy(feature, admin)} />;
}

export function AiUsageNotice({ percent, resetsAt, isAdmin, plan }: { percent: number; resetsAt: Date; isAdmin: boolean; plan: Plan }) {
  const copy = aiUsageCopy(percent, resetsAt, isAdmin, plan);
  return copy && <Notice {...copy} />;
}

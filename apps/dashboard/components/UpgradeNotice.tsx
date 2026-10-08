import Link from "next/link";
import { getActiveSession } from "@/lib/server";
import { PLAN_FEATURES, planDisplayName, type Feature, type Plan } from "@/lib/entitlements";
import { isActiveStatus } from "@/lib/stripe";
import { supportContactAddress } from "@/lib/email";
import { formatDate } from "@/lib/timefmt";

// Paywall and AI-budget notices: say what's locked or paused, and give admins
// the way through to billing. Server components (they read PLAN_FEATURES, and
// the session), so a client component takes one pre-rendered as a prop
// instead of importing it.

// `action` labels the button `href` opens.
type NoticeCopy = { text: string; hint: string | null; href: string | null; action?: string };

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
// notice and the billing page can't disagree. Admins go to billing with that
// plan preselected: "See plans", or "Change plan" once subscribed (the page
// then offers the plans above theirs). Everyone else is pointed at an admin.
export function upgradeNoticeCopy(feature: Feature, isAdmin: boolean, subscribed = false): NoticeCopy {
  const plan = (["team", "growth"] as const).find(p => PLAN_FEATURES.some(l => l.feature === feature && l.plans.includes(p)));
  return {
    text: plan
      ? `The ${planDisplayName(plan)} plan adds ${FEATURE_NAME[feature]}.`
      : `Paid plans add ${FEATURE_NAME[feature]}.`,
    hint: isAdmin ? null : "Ask an admin to upgrade.",
    href: isAdmin ? (plan ? `${BILLING}?plan=${plan}` : BILLING) : null,
    action: subscribed ? "Change plan" : "See plans",
  };
}

// This month's AI budget: a heads-up from 80%, "paused" at 100%, nothing below.
// Team admins can move up a plan. Growth is the top plan, so its admins are
// pointed at a person (`contact`, the support address) for higher limits.
export function aiUsageCopy(
  percent: number, resetsAt: Date, isAdmin: boolean, plan: Plan, contact: string | null = null,
): NoticeCopy | null {
  if (percent < 80) return null;
  const date = formatDate(resetsAt, { utc: true });
  const text = percent >= 100
    ? `AI is paused until ${date}.`
    : `You've used ${percent}% of this month's AI operations. Resets ${date}.`;
  if (isAdmin && plan === "team") return { text, hint: null, href: BILLING, action: "Change plan" };
  if (isAdmin && plan === "growth") {
    return contact
      ? { text, hint: null, href: `mailto:${contact}`, action: "Contact us for higher limits" }
      : { text, hint: "Contact us for higher limits.", href: null };
  }
  return { text, hint: null, href: null };
}

// Neutral on purpose: a hairline box on the card surface, not the success or
// error banner. The action is a plain outline button; ember stays on the trail.
function Notice({ text, hint, href, action = "See plans" }: NoticeCopy) {
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
      {href && <Link href={href} className="btn sm" style={{ textDecoration: "none" }}>{action}</Link>}
    </div>
  );
}

export async function UpgradeNotice({ feature, isAdmin }: { feature: Feature; isAdmin?: boolean }) {
  const { workspace, user } = await getActiveSession();
  const admin = isAdmin ?? user.role === "admin";
  return <Notice {...upgradeNoticeCopy(feature, admin, isActiveStatus(workspace.subscriptionStatus))} />;
}

export function AiUsageNotice({ percent, resetsAt, isAdmin, plan }: { percent: number; resetsAt: Date; isAdmin: boolean; plan: Plan }) {
  const copy = aiUsageCopy(percent, resetsAt, isAdmin, plan, supportContactAddress());
  return copy && <Notice {...copy} />;
}

import { autoNotifiesSubmitter } from "@/lib/feedback/source";

// Will an item's submitter be emailed, and if not, why. One rule for both
// sides: the mutation cores (lib/items/mutations.ts) gate their sends on it and
// the thread renders its "will be emailed" copy from it, so the UI and the real
// sends can't disagree. Pure and client-safe on purpose: the status pickers
// import statusEmailsCustomer() to label the rows that email.

export type NotifySkipReason = "source" | "unsubscribed" | "muted" | "no_email" | "not_configured";
export type NotifyPlan = { willEmail: true } | { willEmail: false; reason: NotifySkipReason };

// Reasons go most specific first: a customer-side reason still holds once email
// is set up, so "not_configured" only shows when it's the last thing in the way.
export function customerNotifyPlan(input: {
  source: string | null;          // items.source
  submitterEmail: string | null;  // account_users.email
  unsubscribedAll: boolean;       // account_users.unsubscribed_all
  notifyReplies: boolean;         // account_users.notify_replies
  notifyStatus: boolean;          // account_users.notify_status
  emailConfigured: boolean;       // emailConfigured() from lib/email (false on stdout)
}): { replies: NotifyPlan; status: NotifyPlan } {
  const email = input.submitterEmail?.trim().toLowerCase() ?? "";
  const plan = (kindOn: boolean): NotifyPlan => {
    // Only widget-origin submitters opted into Crumb's loop (lib/feedback/source).
    if (!autoNotifiesSubmitter(input.source)) return { willEmail: false, reason: "source" };
    // Captures with no real address get a reserved-TLD placeholder (x@slack.invalid).
    if (!email || email.endsWith(".invalid")) return { willEmail: false, reason: "no_email" };
    if (input.unsubscribedAll) return { willEmail: false, reason: "unsubscribed" };
    if (!kindOn) return { willEmail: false, reason: "muted" };
    if (!input.emailConfigured) return { willEmail: false, reason: "not_configured" };
    return { willEmail: true };
  };
  return { replies: plan(input.notifyReplies), status: plan(input.notifyStatus) };
}

// Status changes worth an email: commitments and outcomes. Triage moves (open,
// review) would be noise. A duplicate hears from the merge itself, once
// (notifyMergedItem in lib/items/mutations), and then gets these same emails
// when the item it was merged into moves, each under its own `status` plan.
const STATUS_EMAILS: ReadonlySet<string> = new Set(["planned", "progress", "shipped", "declined", "deferred"]);

export function statusEmailsCustomer(status: string): boolean {
  return STATUS_EMAILS.has(status);
}

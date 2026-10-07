// Every word the widget shows or says to a customer, in one typed table.
//
// English is complete. Another language is one more entry in LOCALES, keyed
// by its canonical tag ("fr", "pt-BR"); any key it leaves out stays English,
// and a group (statuses, types, columns, sizeUnits) is translated whole.
// Functions place names and numbers where the language wants them and do its
// plurals; callers escape whatever lands in markup. Plain text only: no
// markup, and “curly” rather than straight double quotes, since some strings
// land in attributes as they are (a unit test holds every locale to it).
// Product names (Crumb, Slack, Teams) stay as they are.
export const en = {
  // launcher and loop news
  feedback: "Feedback",
  updates: (n: number) => (n === 1 ? "1 update" : `${n} updates`),
  shareFeedback: "Share feedback",
  replied: (name: string) => `${name} replied`,
  newReply: "New reply",
  statusUpdate: "Status update",
  statusNews: (status: string, title: string) => `${status}: ${title}`,

  // header, tabs, footer
  yourFeedback: "Your feedback",
  roadmap: "Roadmap",
  admin: "Admin",
  back: "Back",
  close: "Close",
  expand: "Expand",
  collapse: "Collapse",
  notifSettings: "Notification settings",
  viaCrumb: "via Crumb",

  // the list
  searchFeedback: "Search feedback",
  noMatches: (query: string) => `No matches for “${query}”.`,
  fromRoadmap: "From the roadmap",
  replies: (n: number) => (n === 1 ? "1 reply" : `${n} replies`),
  emptyTitle: "Got something to share?",
  emptyBody: "Tell us about a bug, an idea or a question. Replies show up here.",
  tryAgain: "Try again",
  seeYourFeedback: "See your feedback",
  statuses: {
    open: "Open",
    review: "In review",
    planned: "Planned",
    progress: "In progress",
    shipped: "Shipped",
    declined: "Won’t ship",
    deferred: "Set aside",
    duplicate: "Duplicate",
    resolved: "Resolved",
  },

  // compose
  type: "Type",
  types: { bug: "Bug", idea: "Idea", question: "Question" },
  title: "Title",
  titleHint: "One line: what's the gist?",
  details: "Details (optional)",
  detailsHint: "Anything else we should know?",
  attachFile: "Attach file",
  capture: "Capture screenshot",
  uploading: "Uploading…",
  sizeUnits: ["B", "KB", "MB"] as [string, string, string],
  recordConsent: "Record my session to help us reproduce this",
  recordBodies: "Captures this page as you see it, your clicks and scrolling, and the page's network requests including their contents, with secret-looking values such as passwords and tokens removed.",
  recordNoBodies: "Captures this page as you see it, your clicks and scrolling, and the address, status and timing of the page's network requests, but not their contents.",
  recordMasking: "Text you type into standard form fields is masked; rich-text editors may be recorded. You can turn this off anytime.",
  postingAs: (who: string, account: string) => `Posting as ${who} · ${account}`,
  send: "Send",
  sending: "Sending…",

  // sent
  feedbackSent: "Feedback sent",
  // `team` is the vendor's name, "" when it isn't known yet.
  willReply: (team: string, byEmail: boolean) => `${team || "The team"} will reply here${byEmail ? " and by email" : ""}.`,
  sendAnother: "Send another",

  // a thread
  submitted: "Submitted",
  noMessages: "No messages yet.",
  statusHeading: "Status",
  noHistory: "No history yet.",
  closeThis: "Close this request",
  closeAsk: "Close this request? We’ll let the team know you’re all set.",
  closeRequest: "Close request",
  closing: "Closing…",
  cancel: "Cancel",
  remove: "Remove",
  removeName: (name: string) => `Remove ${name}`,
  yourReply: "Your reply",
  replyHint: "Reply…",

  // roadmap
  columns: { now: "Now", next: "Next", later: "Later" },
  follow: "Follow",
  following: "Following",
  roadmapEmpty: "Nothing here yet",
  roadmapEmptyBody: "This team hasn't shared a public roadmap yet. Check back soon.",

  // email settings
  notifications: "Notifications",
  notifLede: (team: string) => team
    ? `Choose which emails ${team} sends you about your feedback.`
    : "Choose which emails we send you about your feedback.",
  notifReplies: "Replies",
  notifRepliesHint: "When the team replies on your feedback",
  notifStatus: "Status changes",
  notifStatusHint: "When your feedback moves (planned, shipped…)",
  notifRoadmap: "Roadmap updates",
  notifRoadmapHint: "When a roadmap item you follow changes",
  pauseAll: "Pause all email",
  pauseAllHint: "Mute every notification above",

  // account admin
  members: "Members",
  memberCount: (n: number, account: string) => `${n} on ${account}`,
  noTeammates: "No teammates yet.",
  membersHelp: "Teammates appear here automatically when they open the widget. Change a role or remove someone above.",
  changeRole: "Change role",
  roleAdmin: "Admin",
  roleMember: "Member",
  you: "you",
  removeAsk: (what: string) => `Remove ${what}?`,
  notifyChannel: "Notify a channel",
  channelHelp: "Get replies, status changes, and roadmap updates in your own Slack or Teams channel. Paste a channel incoming-webhook URL.",
  channel: (name: string) => `${name} channel`,
  connected: "Connected",
  webhookUrl: (name: string) => `${name} webhook URL`,
  webhookHint: (name: string, example: string) => `${name} webhook (${example})`,
  saveChannel: "Save channel",
  pasteWebhook: "Paste a Slack or Teams webhook URL.",
  channelSaved: "Saved. Notifications will post to your channel.",
  channelRemoved: (name: string) => `${name} disconnected. It won't get notifications anymore.`,

  // said aloud (and some shown)
  replySent: "Reply sent.",
  requestClosed: "Request closed.",
  attached: (file: string) => `${file} attached.`,
  removed: (name: string) => `${name} removed.`,

  // errors: customer copy, never a code
  errExpired: "Your session expired. Reload the page to continue.",
  errOffline: "Couldn’t connect. Check your connection and try again.",
  errNotYours: "This request belongs to someone else.",
  errNotFound: "We couldn’t find that request.",
  errNoTitle: "Add a one-line title.",
  errNoBody: "Write a reply or attach a file.",
  errEmptyFile: "That file is empty.",
  errTooMany: "Too many requests. Wait a moment, then try again.",
  errTooBig: "That file is too large. Try a smaller one.",
  errFileType: "That file type isn’t supported. Images, PDFs and documents work.",
  errTooLong: "That’s longer than we can take. Shorten it and try again.",
  errSignIn: "We couldn’t confirm you’re signed in. Reload the page and try again.",
  errServer: "Something went wrong on our end. Try again in a moment.",
  errCapture: "Couldn’t capture the screen. Attach a file instead.",
  errWebhook: "That isn't a valid https webhook URL.",
  errAdminOnly: "Only account admins can change this.",
  errLastAdmin: "An account needs at least one admin.",
  errRole: "Couldn't change that role.",
  errHasItems: "This teammate has feedback on file and can't be removed.",
  errRemove: "Couldn't remove that teammate.",
};

export type Strings = typeof en;

// Tag → table. A new language: `fr: { feedback: "Avis", … },`
export const LOCALES: Record<string, Partial<Strings>> = { en };

// The first of data-locale, <html lang>, then the browser's language that we
// have a table for, matched exactly or by its parent ("pt-BR", then "pt").
// Dates and numbers follow that tag (en-GB writes "7 Oct"); a page in a
// language we lack gets English words and English dates, never a mix. Tags
// that aren't BCP 47 are skipped ("en_US" is read as en-US).
export function pickLocale(tags: ReadonlyArray<string | null | undefined>): { locale: string; t: Strings } {
  for (const raw of tags) {
    let tag = "";
    try { tag = Intl.getCanonicalLocales((raw || "").trim().replace(/_/g, "-") || [])[0] || ""; } catch { /* not a language tag */ }
    for (let k = tag; k; k = k.slice(0, Math.max(0, k.lastIndexOf("-")))) {
      if (LOCALES[k]) return { locale: tag, t: { ...en, ...LOCALES[k] } };
    }
  }
  return { locale: "en", t: en };
}

// Not in the ES2018 lib types, and missing before Safari 14 (dates only there).
type RelTime = { format(n: number, unit: "second" | "minute" | "hour" | "day"): string };
const RelativeTimeFormat = (Intl as unknown as { RelativeTimeFormat?: new (locale: string, o: { numeric: "auto" }) => RelTime }).RelativeTimeFormat;

// When something happened, in the widget's locale: "now", "5 minutes ago",
// "3 hours ago", then calendar days ("yesterday", "3 days ago": Monday night
// is "2 days ago" on Wednesday morning), then the date ("Sep 16", with the
// year when it isn't this one). `exact` is the full date and time, for a
// tooltip. A bad timestamp gives "".
export function timeFormat(locale: string) {
  const rel = RelativeTimeFormat && new RelativeTimeFormat(locale, { numeric: "auto" });
  const dtf = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(locale, o);
  const day = dtf({ month: "short", day: "numeric" });
  const dayYear = dtf({ month: "short", day: "numeric", year: "numeric" });
  const full = dtf({ year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" });
  const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  return {
    ago(iso: string, now = new Date()): string {
      const then = new Date(iso);
      if (isNaN(+then)) return "";
      const min = Math.floor((+now - +then) / 60_000);
      const days = Math.round((midnight(now) - midnight(then)) / 86_400_000);
      if (!rel || days >= 7) return (then.getFullYear() === now.getFullYear() ? day : dayYear).format(then);
      return min < 1 ? rel.format(0, "second") // "now", also for a clock running ahead
        : min < 60 ? rel.format(-min, "minute")
        : min < 1440 ? rel.format(-Math.floor(min / 60), "hour")
        : rel.format(-days, "day");
    },
    exact(iso: string): string {
      const d = new Date(iso);
      return isNaN(+d) ? "" : full.format(d);
    },
  };
}

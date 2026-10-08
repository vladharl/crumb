import Link from "next/link";
import { Btn, Card, CardHead, StatusDot } from "@crumb/ui";
import { db, notificationPreferences, type WorkspaceUser } from "@crumb/db";
import { eq } from "drizzle-orm";
import { getActiveSession } from "@/lib/server";
import { previewDigest } from "@/lib/vendor-notify";
import { PreferencesCard, type PrefsState } from "./PreferencesCard";

async function loadPreferences(user: Pick<WorkspaceUser, "id" | "role">): Promise<PrefsState & { lastDigestAt: Date | null }> {
  const [row] = await db
    .select()
    .from(notificationPreferences)
    .where(eq(notificationPreferences.workspaceUserId, user.id))
    .limit(1);
  // No saved row: the defaults the nudges apply (lib/vendor-notify.ts), which
  // keep new-submission alerts to admins.
  if (!row) {
    return {
      digestFrequency: "daily",
      newSubmissionRealtime: user.role === "admin",
      assignedRealtime: true,
      replyRealtime: true,
      mentionRealtime: true,
      delivery: "email",
      lastDigestAt: null,
    };
  }
  return {
    digestFrequency: (row.digestFrequency as PrefsState["digestFrequency"]),
    newSubmissionRealtime: row.newSubmissionRealtime,
    assignedRealtime: row.assignedRealtime,
    replyRealtime: row.replyRealtime,
    mentionRealtime: row.mentionRealtime,
    delivery: (row.delivery as PrefsState["delivery"]),
    lastDigestAt: row.lastDigestAt,
  };
}

export async function NotificationsSidebarTile() {
  const { workspace, user } = await getActiveSession();
  const { lastDigestAt, ...prefs } = await loadPreferences(user);
  // The same sections the digest email would carry right now.
  const digest = await previewDigest(workspace.id, { id: user.id, frequency: prefs.digestFrequency, lastDigestAt });

  const headline = digest.sections.length === 0
    ? "Nothing to report yet. Quiet day."
    : digest.waiting > 0
      ? `${digest.waiting} ${digest.waiting === 1 ? "loop" : "loops"} waiting on your team.`
      : "Nothing waiting on your team.";

  return (
    <div className="col gap-4">
      <PreferencesCard initial={prefs} slackInstalled={!!workspace.slackBotToken} />

      <Card>
        <CardHead title="Digest preview" />
        <div className="card-body col gap-3">
          <div className="text-xs muted">
            {prefs.digestFrequency === "off"
              ? "Your digest is off. This is what it would say."
              : `What your next ${prefs.digestFrequency} digest says right now.`}
          </div>
          <div className="display" style={{ fontSize: 22, lineHeight: 1.25 }}>{headline}</div>
          {digest.sections.length > 0 && (
            <div className="col gap-2 text-sm">
              {digest.sections.map(s => (
                <div key={s.heading} className="row gap-3 center">
                  <StatusDot status="open" />
                  <span className="grow truncate">{s.heading}</span>
                  <span className="muted">{s.total}</span>
                </div>
              ))}
            </div>
          )}
          <Link href="/inbox" style={{ alignSelf: "flex-start" }}>
            <Btn sm>Open inbox →</Btn>
          </Link>
        </div>
      </Card>
    </div>
  );
}

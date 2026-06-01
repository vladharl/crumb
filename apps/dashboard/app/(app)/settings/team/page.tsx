import { Avatar, Card, CardHead, Ic, Pill } from "@crumb/ui";
import { db, workspaceUsers, magicTokens, sessions } from "@crumb/db";
import { and, asc, eq, gt, isNull, sql } from "drizzle-orm";
import { getActiveSession } from "@/lib/server";
import { InvitePanel, RemoveButton, ResendButton, RoleSelect } from "./InvitePanel";

export const dynamic = "force-dynamic";

export default async function SettingsTeamPage() {
  const { workspace, user: me } = await getActiveSession();
  const canInvite = me.role === "admin";

  const [team, sessionRows, pendingRows] = await Promise.all([
    db.select({
        id: workspaceUsers.id,
        name: workspaceUsers.name,
        email: workspaceUsers.email,
        role: workspaceUsers.role,
        initials: workspaceUsers.initials,
        createdAt: workspaceUsers.createdAt,
      })
      .from(workspaceUsers)
      .where(eq(workspaceUsers.workspaceId, workspace.id))
      .orderBy(asc(workspaceUsers.name)),

    db.select({ userId: sessions.workspaceUserId, c: sql<number>`COUNT(*)::int` })
      .from(sessions)
      .where(eq(sessions.workspaceId, workspace.id))
      .groupBy(sessions.workspaceUserId),

    db.select({ userId: magicTokens.workspaceUserId, c: sql<number>`COUNT(*)::int` })
      .from(magicTokens)
      .where(and(
        eq(magicTokens.workspaceId, workspace.id),
        isNull(magicTokens.consumedAt),
        gt(magicTokens.expiresAt, new Date()),
      ))
      .groupBy(magicTokens.workspaceUserId),
  ]);

  const sessionByUser = new Map(sessionRows.map(r => [r.userId, r.c]));
  const pendingByUser = new Map(pendingRows.map(r => [r.userId, r.c]));

  return (
    <Card>
      <CardHead
        title={`Team & roles · ${team.length}`}
        after={<InvitePanel canInvite={canInvite} />}
      />
      <div className="list">
        <div className="list-row head" style={{ gridTemplateColumns: "1.4fr 1fr 130px 120px 1.2fr" }}>
          <span>Member</span><span>Email</span><span>Role</span><span>Status</span><span></span>
        </div>
        {team.length === 0 && (
          <div className="card-body">
            <p className="text-sm muted" style={{ margin: 0 }}>No team members yet. Invite your first PM.</p>
          </div>
        )}
        {team.map(m => {
          const sessionCount = sessionByUser.get(m.id) ?? 0;
          const pendingCount = pendingByUser.get(m.id) ?? 0;
          const hasEverSignedIn = sessionCount > 0;
          const isPending = !hasEverSignedIn && pendingCount > 0;
          const isMe = m.id === me.id;
          return (
            <div key={m.id} className="list-row" style={{ gridTemplateColumns: "1.4fr 1fr 130px 120px 1.2fr" }}>
              <div className="row gap-3 center">
                <Avatar>{m.initials}</Avatar>
                <div className="col">
                  <span className="fw-med">{m.name}{isMe ? <span className="text-xs muted" style={{ marginLeft: 6 }}>you</span> : null}</span>
                  <span className="text-xs muted">
                    {new Date(m.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "2-digit" })}
                  </span>
                </div>
              </div>
              <span className="text-sm muted truncate">{m.email}</span>
              <span>
                {canInvite
                  ? <RoleSelect id={m.id} role={m.role} isMe={isMe} />
                  : <span className="text-sm">{m.role === "admin" ? "Admin" : m.role === "viewer" ? "Viewer" : "PM"}</span>}
              </span>
              <span>
                {isPending
                  ? <Pill ring>Pending</Pill>
                  : hasEverSignedIn
                    ? <Pill ring ringFill>Active</Pill>
                    : <Pill>Never signed in</Pill>}
              </span>
              <span className="row gap-2 center" style={{ justifyContent: "flex-end" }}>
                {isPending && canInvite ? <ResendButton id={m.id} /> : null}
                {canInvite && !isMe ? <RemoveButton id={m.id} name={m.name} /> : null}
              </span>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

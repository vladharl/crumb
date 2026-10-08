import { test, expect } from "@playwright/test";
import { psql, publicOrigin, stdoutEmails, type StdoutEmail } from "./helpers/mint";

// Settings → Team: an admin invites a teammate, which emails them a sign-in
// link (lib/email.ts sendInvite, "<Inviter> invited you to <Workspace> on
// Crumb"). Opened signed out, the link goes through the sign-in confirm step
// (its GET only forwards to Continue, so a mail scanner can't spend it) and
// Continue lands the new teammate in the workspace.

test("an invited teammate signs in from the emailed link and lands in the workspace", async ({ page, browser, baseURL }) => {
  const email = `invitee+${Date.now()}@southbeam.io`;
  const [workspace, inviter] = psql(
    `SELECT w.name, u.name FROM workspaces w JOIN workspace_users u ON u.workspace_id = w.id
     WHERE w.slug = 'southbeam' AND u.email = 'lina@southbeam.io'`,
  ).split("|") as [string, string];

  await page.goto("/settings/team");
  await page.getByRole("button", { name: "Invite" }).click();
  await page.getByPlaceholder("teammate@yourcompany.com").fill(email);
  await page.getByPlaceholder("First Last").fill("Iris Invitee");
  await page.getByRole("button", { name: "Send invite" }).click();
  await expect(page.getByText(`Invite link for ${email}`)).toBeVisible();
  const link = (await page.locator(".invite-panel .mono").innerText()).trim();

  if (stdoutEmails() === null) {
    test.info().annotations.push({
      type: "skipped",
      description: "invite email not checked: set CRUMB_E2E_DEV_LOG to the dev server's log file; following the link shown to the admin",
    });
  } else {
    let sent: StdoutEmail | undefined;
    await expect.poll(() => (sent = stdoutEmails()!.find((e) => e.to === email)), { timeout: 15_000 }).toBeTruthy();
    expect(sent!.subject).toBe(`${inviter} invited you to ${workspace} on Crumb`);
    expect(sent!.link).toBe(link);
  }

  const url = new URL(link);
  expect(url.origin).toBe(publicOrigin(new URL(baseURL!).origin));
  const token = url.searchParams.get("token");
  const spent = () => psql(`SELECT consumed_at IS NOT NULL FROM magic_tokens WHERE token = '${token}'`);

  // The teammate's own browser: no session. Opened on this server, since the
  // link's origin is the public one (another host when .env.local points
  // CRUMB_APP_URL at a tunnel).
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const invitee = await context.newPage();
  await invitee.goto(new URL(url.pathname + url.search, baseURL).href);
  await expect(invitee).toHaveURL(/\/login\/continue\?token=/);
  await expect(invitee.getByRole("heading", { name: "You're almost in" })).toBeVisible();
  expect(spent()).toBe("f");

  await invitee.getByRole("button", { name: "Continue to Crumb" }).click();
  await expect(invitee).toHaveURL(/\/inbox$/);
  expect(spent()).toBe("t");
  await expect(invitee.locator(".topbar-ws")).toHaveText(workspace);
  await expect(invitee.getByRole("button", { name: "Account menu" })).toHaveText("II");
  await context.close();

  // And the admin's list now has them signed in.
  await page.goto("/settings/team");
  await expect(page.locator(".list-row", { hasText: email })).toContainText("Active");
});

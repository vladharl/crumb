"use server";

import { requireSession } from "@/lib/auth";
import { sendSupportRequest, supportContactAddress } from "@/lib/email";
import { log } from "@/lib/log";

export type SupportResult = { ok: true } | { ok: false; error: string };

const SUBJECT_MAX = 160;
const MESSAGE_MAX = 5000;

/**
 * Delivers an in-app Help → Contact message to the deployment's support address
 * (CRUMB_SUPPORT_EMAIL, falling back to CRUMB_OPS_EMAIL). Auth-gated — the sender
 * identity comes from the session, never the client — and Reply-To is set to the
 * teammate so the operator can answer them directly. No new public surface.
 */
export async function submitSupportRequest(input: {
  subject: string;
  message: string;
}): Promise<SupportResult> {
  const { user, workspace } = await requireSession();

  const subject = input.subject?.trim() ?? "";
  const message = input.message?.trim() ?? "";
  if (!subject || !message) {
    return { ok: false, error: "Add a subject and a message." };
  }
  if (subject.length > SUBJECT_MAX || message.length > MESSAGE_MAX) {
    return { ok: false, error: "That message is too long. Please shorten it." };
  }

  const to = supportContactAddress();
  if (!to) {
    // Shouldn't happen: the form only renders when supportContactEnabled().
    return { ok: false, error: "Support contact isn't configured on this deployment." };
  }

  try {
    const res = await sendSupportRequest({
      to,
      workspaceName: workspace.name,
      fromUserName: user.name,
      fromUserEmail: user.email,
      subject,
      message,
    });
    if (!res.ok) return { ok: false, error: "Couldn't send your message. Please try again." };
    return { ok: true };
  } catch (err) {
    log.error("support-request action threw", { scope: "crumb/support", err });
    return { ok: false, error: "Couldn't send your message. Please try again." };
  }
}

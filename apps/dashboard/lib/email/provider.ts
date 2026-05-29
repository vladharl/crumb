import "server-only";

export type OutgoingEmail = {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** Optional per-send override; falls back to the provider's default. */
  from?: string;
  /** Optional Reply-To header — used by inbound-reply addresses. */
  replyTo?: string;
  /** Short one-line summary surfaced by the stdout provider (e.g. for log scanning). */
  previewLine?: string;
  /** Convenience pointer — providers may surface this in logs. */
  link?: string;
};

export type SendResult =
  | { ok: true; providerMessageId: string | null }
  | { ok: false; error: string; detail?: string };

export type EmailProvider = {
  name: string;
  send(email: OutgoingEmail): Promise<SendResult>;
};

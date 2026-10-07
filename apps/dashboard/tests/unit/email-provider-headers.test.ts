import { afterEach, describe, expect, it, vi } from "vitest";
import type { SendMailOptions } from "nodemailer";
import { makeResendProvider } from "@/lib/email/resend";
import { makeSmtpProvider } from "@/lib/email/smtp";

// lib/email.ts puts List-Unsubscribe (RFC 8058 one-click) and per-item
// threading headers on customer emails. Both real providers must deliver them:
// without them Gmail/Yahoo show no unsubscribe button and every email about an
// item starts a new thread.

// Real nodemailer composes the message; a stream transport stands in for the socket.
const sent = vi.hoisted(() => [] as string[]);
vi.mock("nodemailer", async (importOriginal) => {
  const { createTransport } = await importOriginal<typeof import("nodemailer")>();
  const stream = createTransport({ streamTransport: true, buffer: true });
  return {
    default: {
      createTransport: () => ({
        sendMail: async (mail: SendMailOptions) => {
          const info = await stream.sendMail(mail);
          sent.push(info.message.toString());
          return info;
        },
      }),
    },
  };
});

const headers = {
  "List-Unsubscribe": `<https://crumb.test/api/v1/unsubscribe?u=0b8f7a52-5d0f-4d1e-9a3c-2b9f0e6c1a11&t=${"a".repeat(64)}&scope=replies>, <mailto:unsubscribe@in.crumb.test>`,
  "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  "Message-ID": "<reply.42.fb-12.ws-1@crumb.test>",
  "In-Reply-To": "<fb-12.ws-1@crumb.test>",
  "References": "<fb-12.ws-1@crumb.test>",
};
const email = { to: "pat@initech.test", subject: "Acme replied", html: "<p>Hi</p>", text: "Hi", headers };

describe("email providers forward headers", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("resend: in the API's headers field", async () => {
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => Response.json({ id: "re_1" }));
    vi.stubGlobal("fetch", fetch);
    await makeResendProvider({ apiKey: "re_test", from: "Acme <crumb@acme.test>" }).send(email);
    expect(JSON.parse(fetch.mock.calls[0][1].body as string).headers).toEqual(headers);
  });

  it("smtp: in the message, keeping our Message-ID", async () => {
    const res = await makeSmtpProvider({ host: "smtp.test", port: 587, user: "", pass: "", from: "Acme <crumb@acme.test>" }).send(email);
    expect(res).toEqual({ ok: true, providerMessageId: headers["Message-ID"] });
    const unfolded = sent[0].replace(/\r\n(?=[ \t])/g, ""); // nodemailer folds long header lines
    for (const [k, v] of Object.entries(headers)) expect(unfolded).toContain(`${k}: ${v}\r\n`);
  });
});

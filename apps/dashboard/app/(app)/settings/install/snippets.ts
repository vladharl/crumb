import "server-only";
import { originFromHeaders } from "@/lib/origin";

// Every code sample on the Install page, built from this deployment's public
// origin (CRUMB_APP_URL first, see lib/origin.ts) and the workspace slug, so
// what people copy works as pasted. Claims in the signing examples follow
// lib/jwt.ts: iss = workspace slug, sub = customer email, account_name, exp
// (required), iat; name and role are optional.

type HeaderGetter = { get(name: string): string | null };

export function installSnippets(h: HeaderGetter, slug: string) {
  const origin = originFromHeaders(h) ?? "https://your-crumb-host";
  const tag = (...attrs: string[]) =>
    [`<script src="${origin}/widget.js"`, `data-workspace="${slug}"`, ...attrs, `defer></script>`].join("\n        ");

  return {
    origin,
    install: `<!-- in your page template, server-rendered -->\n${tag(`data-user-jwt="{signedIdentityJwt}"`)}`,
    dev: tag(
      `data-user-email="{currentUser.email}"`,
      `data-user-name="{currentUser.name}"`,
      `data-account-name="{currentUser.account.name}"`,
    ),
    hidden: tag(`data-user-jwt="{signedIdentityJwt}"`, `data-launcher="hidden"`),
    api: `<!-- your own button -->
<button onclick="crumb.open()">Give feedback</button>

// jump straight to a thread
crumb.open("FB-12");
crumb.close();  crumb.toggle();

// keep your launcher badged when crumb is hidden
crumb.onUnread(function (count) { /* show your own dot */ });

// sign a customer in (or hand over a fresh token) without a page load
crumb.identify({ jwt: token });
crumb.onTokenExpired(function () { /* sign a new token, then identify() */ });
// on sign-out: forget their feedback, drafts and unread state
crumb.shutdown();
// their build, sent with each new request (same as data-app-version)
crumb.setContext({ app_version: "4.2.1" });

<!-- optional on the tag: your build, and the widget's language -->
data-app-version="4.2.1" data-locale="en-GB"`,
    // The refresh fetches the Next.js signing route below.
    session: `// after your customer signs in (the tag can load before anyone has)
crumb.identify({ jwt: token });

// tokens last an hour: hand the widget a fresh one when it asks
crumb.onTokenExpired(() =>
  fetch("/api/crumb-token")
    .then((r) => r.json())
    .then(({ token }) => crumb.identify({ jwt: token })));

// on sign-out: forget their feedback, drafts and unread state
crumb.shutdown();

// which build they're on (or data-app-version="4.2.1" on the tag)
crumb.setContext({ app_version: "4.2.1" });`,
    intercom: `// hide Intercom's launcher and add a "Give feedback" item that opens crumb
Intercom("update", { hide_default_launcher: true });
document.querySelector("#your-feedback-link")
  .addEventListener("click", function () { crumb.open(); });`,
    zendesk: `// a CTA that closes the Zendesk messenger and opens crumb
zE("messenger", "close");
crumb.open();`,
    signing: [
      {
        label: "Node",
        code: `// Sign on your server for the signed-in customer, never in the browser.
import { createHmac } from "node:crypto";

const b64url = (s) => Buffer.from(s).toString("base64url");

export function crumbToken(user) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({
    iss: "${slug}",
    sub: user.email,
    name: user.name,
    account_name: user.account.name,
    iat: now,
    exp: now + 60 * 60,
  }));
  const sig = createHmac("sha256", process.env.CRUMB_SIGNING_SECRET)
    .update(\`\${header}.\${claims}\`)
    .digest("base64url");
  return \`\${header}.\${claims}.\${sig}\`;
}`,
      },
      {
        label: "Next.js",
        code: `// app/api/crumb-token/route.ts
import { createHmac } from "node:crypto";
import { getUser } from "@/lib/auth"; // your session lookup

export const dynamic = "force-dynamic";

const b64url = (s: string) => Buffer.from(s).toString("base64url");

export async function GET() {
  const user = await getUser();
  if (!user) return new Response(null, { status: 401 });
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({
    iss: "${slug}",
    sub: user.email,
    name: user.name,
    account_name: user.account.name,
    iat: now,
    exp: now + 60 * 60,
  }));
  const sig = createHmac("sha256", process.env.CRUMB_SIGNING_SECRET!)
    .update(\`\${header}.\${claims}\`)
    .digest("base64url");
  return Response.json({ token: \`\${header}.\${claims}.\${sig}\` });
}

// Then, in the browser, load the widget with it:
// const { token } = await fetch("/api/crumb-token").then((r) => r.json());
// const s = document.createElement("script");
// s.src = "${origin}/widget.js";
// s.dataset.workspace = "${slug}";
// s.dataset.userJwt = token;
// document.body.appendChild(s);`,
      },
      {
        label: "Python",
        code: `# pip install pyjwt
import os
import time

import jwt


def crumb_token(user):
    now = int(time.time())
    return jwt.encode(
        {
            "iss": "${slug}",
            "sub": user.email,
            "name": user.name,
            "account_name": user.account.name,
            "iat": now,
            "exp": now + 3600,
        },
        os.environ["CRUMB_SIGNING_SECRET"],
        algorithm="HS256",
    )`,
      },
      {
        label: "Rails",
        code: `# Gemfile: gem "jwt"
# app/helpers/crumb_helper.rb
module CrumbHelper
  def crumb_token(user)
    now = Time.now.to_i
    JWT.encode(
      {
        iss: "${slug}",
        sub: user.email,
        name: user.name,
        account_name: user.account.name,
        iat: now,
        exp: now + 3600
      },
      ENV.fetch("CRUMB_SIGNING_SECRET"),
      "HS256"
    )
  end
end

# In your layout: data-user-jwt="<%= crumb_token(current_user) %>"`,
      },
      {
        label: "Laravel",
        code: `<?php
// composer require firebase/php-jwt
// config/services.php: 'crumb' => ['secret' => env('CRUMB_SIGNING_SECRET')],

use Firebase\\JWT\\JWT;

function crumb_token($user): string
{
    $now = time();

    return JWT::encode([
        'iss' => '${slug}',
        'sub' => $user->email,
        'name' => $user->name,
        'account_name' => $user->account->name,
        'iat' => $now,
        'exp' => $now + 3600,
    ], config('services.crumb.secret'), 'HS256');
}

// In a Blade view: data-user-jwt="{{ crumb_token(auth()->user()) }}"`,
      },
      {
        label: "Go",
        code: `// go get github.com/golang-jwt/jwt/v5
package crumb

import (
    "os"
    "time"

    "github.com/golang-jwt/jwt/v5"
)

func Token(email, name, accountName string) (string, error) {
    now := time.Now()
    claims := jwt.MapClaims{
        "iss":          "${slug}",
        "sub":          email,
        "name":         name,
        "account_name": accountName,
        "iat":          now.Unix(),
        "exp":          now.Add(time.Hour).Unix(),
    }
    return jwt.NewWithClaims(jwt.SigningMethodHS256, claims).
        SignedString([]byte(os.Getenv("CRUMB_SIGNING_SECRET")))
}`,
      },
    ],
  };
}

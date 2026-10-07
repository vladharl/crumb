// Operator CLI, run inside the production container against DATABASE_URL:
//   docker compose exec dashboard node packages/db/dist/cli.mjs <command>
//
//   setup-link [ttlMinutes=60]                       one-time link to /onboard
//   first-run                                        setup link only while no workspace exists
//                                                    (run by docker-entrypoint.sh on every start)
//   add-user <workspace-slug> <email> <name> [role]  register a user + sign-in link
//   list-users [slug]                                inspect workspaces + members
//
// Built self-contained by `build:cli` (esbuild, like migrate.mjs).
import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "./client";
import { workspaces, workspaceUsers, magicTokens } from "./schema";
import { createFirstRunSetupToken, createSetupToken, setupLinkFor } from "./setup-tokens";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const VALID_ROLES = new Set(["admin", "pm", "viewer"]);
const SIGNIN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const SETUP_TTL_MIN = 60;

function appUrl(): string {
  const url = (process.env.CRUMB_APP_URL ?? "").replace(/\/+$/, "");
  if (!url) {
    console.error("CRUMB_APP_URL is not set in the environment; cannot build links.");
    process.exit(1);
  }
  return url;
}

function initialsOf(name: string): string {
  return (
    name.split(/\s+/).filter(Boolean).slice(0, 2)
      .map(s => s[0]?.toUpperCase() ?? "").join("").slice(0, 4) || "?"
  );
}

// The link, plus how to use it when CRUMB_APP_URL is unset and it's only a path.
function setupLinkLines(token: string, ttlMin: number): string[] {
  const link = setupLinkFor(token);
  const lines = [`One-time setup link (works once, valid ${ttlMin} min):`, `  ${link}`];
  if (link.startsWith("/")) {
    lines.push(
      "",
      "CRUMB_APP_URL is not set, so that is only the path. Open it on your",
      "dashboard's address, for example:",
      `  http://localhost:3000${link}`,
      "For full links, set CRUMB_APP_URL in .env (for example",
      "CRUMB_APP_URL=https://crumb.example.com) and run docker compose up -d.",
    );
  }
  return lines;
}

async function setupLink(ttlMinutesArg?: string): Promise<void> {
  const ttlMin = Number(ttlMinutesArg ?? SETUP_TTL_MIN);
  if (!Number.isFinite(ttlMin) || ttlMin <= 0) {
    console.error("ttlMinutes must be a positive number.");
    process.exit(1);
  }
  const token = await createSetupToken(ttlMin * 60 * 1000);
  console.log(["", ...setupLinkLines(token, ttlMin), ""].join("\n"));
}

// Container start hook: a fresh instance has no workspace and invite-only
// sign-in, so print the way in where the operator is already looking (the
// logs). Silent once any workspace exists.
async function firstRun(): Promise<void> {
  const token = await createFirstRunSetupToken(SETUP_TTL_MIN * 60 * 1000);
  if (!token) return;
  const rule = "=".repeat(72);
  console.log([
    "",
    rule,
    "Crumb first run: no workspace exists yet. Open this link to create",
    "your workspace and its admin account.",
    "",
    ...setupLinkLines(token, SETUP_TTL_MIN),
    "",
    "Expired? Restart the dashboard, or make a fresh link with:",
    "  docker compose exec dashboard node packages/db/dist/cli.mjs setup-link",
    rule,
    "",
  ].join("\n"));
}

async function addUser(slug?: string, email?: string, name?: string, role = "pm"): Promise<void> {
  const base = appUrl();
  if (!slug || !email || !name) {
    console.error('Usage: add-user <workspace-slug> <email> <name> [role=pm]');
    process.exit(1);
  }
  const e = email.trim().toLowerCase();
  if (!EMAIL_RE.test(e)) { console.error("Invalid email."); process.exit(1); }
  if (!VALID_ROLES.has(role)) { console.error("Role must be one of: admin, pm, viewer."); process.exit(1); }

  const [ws] = await db.select().from(workspaces).where(eq(workspaces.slug, slug)).limit(1);
  if (!ws) {
    console.error(`No workspace with slug "${slug}". Run "list-users" to see what exists.`);
    process.exit(1);
  }

  const [existing] = await db
    .select()
    .from(workspaceUsers)
    .where(and(eq(workspaceUsers.workspaceId, ws.id), eq(workspaceUsers.email, e)))
    .limit(1);

  let user = existing;
  if (!user) {
    const inserted = await db.insert(workspaceUsers).values({
      workspaceId: ws.id,
      email: e,
      name,
      role,
      initials: initialsOf(name),
    }).returning();
    user = inserted[0];
    console.log(`Created ${role} ${e} in workspace "${slug}".`);
  } else {
    console.log(`${e} already exists in "${slug}"; issuing a fresh sign-in link.`);
  }
  if (!user) { console.error("Could not create the user."); process.exit(1); }

  const token = randomBytes(24).toString("base64url");
  await db.insert(magicTokens).values({
    workspaceId: ws.id,
    workspaceUserId: user.id,
    token,
    expiresAt: new Date(Date.now() + SIGNIN_TTL_MS),
  });
  console.log(`\nSign-in link (valid 7 days):\n  ${base}/login/verify?token=${encodeURIComponent(token)}\n`);
}

async function listUsers(slug?: string): Promise<void> {
  const wss = slug
    ? await db.select().from(workspaces).where(eq(workspaces.slug, slug))
    : await db.select().from(workspaces);
  if (!wss.length) { console.log(slug ? `(no workspace "${slug}")` : "(no workspaces yet)"); return; }
  for (const ws of wss) {
    const users = await db.select().from(workspaceUsers).where(eq(workspaceUsers.workspaceId, ws.id));
    console.log(`\n${ws.name} (${ws.slug}) — ${users.length} user(s):`);
    for (const u of users) console.log(`  • ${u.email}  —  ${u.name}  [${u.role}]`);
  }
  console.log("");
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "setup-link": await setupLink(rest[0]); break;
    case "first-run":  await firstRun(); break;
    case "add-user":   await addUser(rest[0], rest[1], rest[2], rest[3]); break;
    case "list-users": await listUsers(rest[0]); break;
    default:
      console.error(
        "Usage:\n" +
        "  setup-link [ttlMinutes=60]\n" +
        "  first-run\n" +
        "  add-user <workspace-slug> <email> <name> [role=pm]\n" +
        "  list-users [slug]",
      );
      process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });

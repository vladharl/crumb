import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync, randomInt, randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { db, workspaces } from "@crumb/db";
import { GET } from "@/app/api/integrations/github/callback/route";
import { signState } from "@/lib/integrations/state";

// The GitHub callback's installation_id is a bare query parameter, and the App
// JWT can read every installation of the App. Unchecked, a workspace admin
// replays their own valid state with another company's installation id and
// gets its repos, private READMEs and issue webhooks. Runs the real route
// handler against Postgres (DATABASE_URL, migrated via `pnpm db:migrate`) with
// the session mocked and GitHub faked. Skipped locally when no database
// answers; CI has one, so there it fails instead of skipping.

const { getSession } = vi.hoisted(() => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getSession }));

const reachable = await db.execute(sql`select 1`).then(() => true, () => false);

const APP = "https://crumb.example.test";
const tag = randomUUID().slice(0, 8);
const created: string[] = [];
const newInstallId = () => String(randomInt(1e9, 2e9));

// Fake GitHub: when each installation was created/updated, and which ones the
// user behind OAuth code "good" can reach. Token minting and the repo
// pre-select 404, which the callback treats as best-effort (and logs).
const installedAt = new Map<string, string>();
let listed: string[] = [];
const fetchSpy = vi.fn(async (input: unknown, init?: RequestInit) => {
  const url = String(input);
  if (url === "https://github.com/login/oauth/access_token") {
    const code = new URLSearchParams(String(init?.body)).get("code");
    return Response.json(code === "good" ? { access_token: "ghu_test" } : { error: "bad_verification_code" });
  }
  if (url.startsWith("https://api.github.com/user/installations")) {
    if (new Headers(init?.headers).get("authorization") !== "Bearer ghu_test") return new Response(null, { status: 401 });
    return Response.json({ total_count: listed.length, installations: listed.map(id => ({ id: Number(id) })) });
  }
  const at = installedAt.get(url.match(/^https:\/\/api\.github\.com\/app\/installations\/(\d+)$/)?.[1] ?? "");
  if (at) return Response.json({ account: { login: "acme", type: "Organization" }, created_at: at, updated_at: at });
  return new Response("not found", { status: 404 });
});

async function workspace(githubAppInstallId: string | null = null) {
  const [ws] = await db.insert(workspaces)
    .values({ slug: `gh-owner-${tag}-${created.length}`, name: "GitHub install owner test", githubAppInstallId })
    .returning({ id: workspaces.id });
  created.push(ws.id);
  return ws.id;
}

async function installOf(workspaceId: string) {
  const [row] = await db.select({ id: workspaces.githubAppInstallId }).from(workspaces).where(eq(workspaces.id, workspaceId));
  return row.id;
}

// Finish the install as the signed-in admin of `workspaceId`, with that
// workspace's own valid state. Returns the settings banner slug.
async function finish(workspaceId: string, query: string) {
  getSession.mockResolvedValue({ workspace: { id: workspaceId }, user: { id: "user-1", role: "admin" } });
  const res = await GET(new Request(
    `http://0.0.0.0:3000/api/integrations/github/callback?${query}&state=${signState("github", workspaceId)}`,
  ));
  return res.headers.get("location")?.replace(`${APP}/settings/integrations?github=`, "");
}

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const logLines = () => consoleError.mock.calls.map(([line]) => String(line));
let consoleError: ReturnType<typeof vi.spyOn>;

describe.skipIf(!reachable && !process.env.CI)("GitHub install callback binds only installations the installer owns", () => {
  beforeAll(() => {
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    vi.stubEnv("CRUMB_APP_URL", APP);
    vi.stubEnv("CRUMB_OAUTH_STATE_SECRET", "test-state-secret");
    vi.stubEnv("GITHUB_APP_ID", "1");
    vi.stubEnv("GITHUB_APP_PRIVATE_KEY", privateKey);
    vi.stubGlobal("fetch", fetchSpy);
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {}); // log.warn lines
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    consoleError.mockRestore();
    if (created.length) await db.delete(workspaces).where(inArray(workspaces.id, created));
  });
  beforeEach(() => fetchSpy.mockClear());

  it("refuses an installation another workspace holds, before asking GitHub", async () => {
    vi.stubEnv("GITHUB_APP_CLIENT_ID", "Iv1.test");
    vi.stubEnv("GITHUB_APP_CLIENT_SECRET", "test-client-secret");
    const id = newInstallId();
    installedAt.set(id, minutesAgo(1));
    listed = [id]; // even a GitHub user who can reach it doesn't move it
    const holder = await workspace(id);
    const other = await workspace();

    expect(await finish(other, `installation_id=${id}&setup_action=install&code=good`)).toBe("error_install_taken");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await installOf(other)).toBeNull();
    // The holder itself can still finish an update of its own install.
    expect(await finish(holder, `installation_id=${id}&setup_action=update&code=good`)).toBe("connected");
    expect(await installOf(holder)).toBe(id);
  });

  it("with the App's OAuth credentials, binds only installations listed for the installing GitHub user", async () => {
    vi.stubEnv("GITHUB_APP_CLIENT_ID", "Iv1.test");
    vi.stubEnv("GITHUB_APP_CLIENT_SECRET", "test-client-secret");
    const theirs = newInstallId();
    const mine = newInstallId();
    installedAt.set(theirs, minutesAgo(1)); // fresh: recency alone would admit it
    installedAt.set(mine, minutesAgo(60 * 24)); // stale: only the listing admits it
    listed = [mine];
    const ws = await workspace();

    expect(await finish(ws, `installation_id=${theirs}&setup_action=install&code=good`)).toBe("error_not_owner");
    // Dropping the code must not fall back to the recency check: it goes
    // through GitHub's user authorization instead (next test).
    expect(await finish(ws, `installation_id=${theirs}&setup_action=install`)).toMatch(/^https:\/\/github\.com\/login\/oauth\/authorize\?/);
    expect(await finish(ws, `installation_id=${mine}&setup_action=install&code=bad`)).toBe("error_not_owner");
    expect(await installOf(ws)).toBeNull();

    expect(await finish(ws, `installation_id=${mine}&setup_action=install&code=good`)).toBe("connected");
    expect(await installOf(ws)).toBe(mine);
  });

  it("with them, reconnecting an App that's already installed goes through GitHub's user authorization", async () => {
    vi.stubEnv("GITHUB_APP_CLIENT_ID", "Iv1.test");
    vi.stubEnv("GITHUB_APP_CLIENT_SECRET", "test-client-secret");
    const mine = newInstallId();
    const theirs = newInstallId();
    installedAt.set(mine, minutesAgo(60 * 24 * 30)); // installed a month ago
    installedAt.set(theirs, minutesAgo(60 * 24 * 30));
    listed = [mine];
    const ws = await workspace();

    // GitHub sends an already-installed App back with no code: setup_action=update, or none.
    for (const query of [`installation_id=${mine}&setup_action=update`, `installation_id=${mine}`]) {
      const authorize = new URL((await finish(ws, query))!);
      expect(authorize.origin + authorize.pathname).toBe("https://github.com/login/oauth/authorize");
      expect(authorize.searchParams.get("client_id")).toBe("Iv1.test");
      expect(authorize.searchParams.get("redirect_uri")).toBe(`${APP}/api/integrations/github/callback`);
      expect(fetchSpy).not.toHaveBeenCalled();
    }
    expect(await installOf(ws)).toBeNull();

    // GitHub returns only code + state; the state carries the installation id.
    const back = async (query: string) => {
      const res = await GET(new Request(`http://0.0.0.0:3000/api/integrations/github/callback?${query}`));
      return res.headers.get("location")?.replace(`${APP}/settings/integrations?github=`, "");
    };
    const stateFor = async (id: string) =>
      new URL((await finish(ws, `installation_id=${id}&setup_action=update`))!).searchParams.get("state")!;

    // Declined on GitHub (no code): fails closed instead of asking again.
    expect(await back(`error=access_denied&state=${await stateFor(mine)}`)).toBe("error_not_owner");
    // An id swapped into the signed state breaks it; a user who can't reach the installation is refused.
    const swapped = (await stateFor(mine)).replace(mine, theirs);
    expect(await back(`code=good&state=${swapped}`)).toBe("error_bad_state");
    expect(await back(`code=good&state=${await stateFor(theirs)}`)).toBe("error_not_owner");
    expect(await installOf(ws)).toBeNull();

    expect(await back(`code=good&state=${await stateFor(mine)}`)).toBe("connected");
    expect(await installOf(ws)).toBe(mine);
  });

  it("without them, binds only an install or update GitHub recorded in the last 10 minutes, and says so once", async () => {
    vi.stubEnv("GITHUB_APP_CLIENT_ID", "");
    vi.stubEnv("GITHUB_APP_CLIENT_SECRET", "");
    const stale = newInstallId();
    const fresh = newInstallId();
    installedAt.set(stale, minutesAgo(11));
    installedAt.set(fresh, minutesAgo(2));
    const ws = await workspace();

    expect(await finish(ws, `installation_id=${stale}&setup_action=install`)).toBe("error_not_owner");
    expect(await finish(ws, `installation_id=${fresh}`)).toBe("error_not_owner"); // no setup_action
    expect(await installOf(ws)).toBeNull();

    expect(await finish(ws, `installation_id=${fresh}&setup_action=install`)).toBe("connected");
    expect(await installOf(ws)).toBe(fresh);
    expect(logLines().filter(line => line.includes("install recency"))).toHaveLength(1);
  });

  it("without them on Cloud, binds nothing: any tenant could claim a fresh install there", async () => {
    vi.stubEnv("GITHUB_APP_CLIENT_ID", "");
    vi.stubEnv("GITHUB_APP_CLIENT_SECRET", "");
    vi.stubEnv("CRUMB_TIER", "cloud");
    const fresh = newInstallId();
    installedAt.set(fresh, minutesAgo(1));
    const ws = await workspace();

    expect(await finish(ws, `installation_id=${fresh}&setup_action=install`)).toBe("error_not_owner");
    expect(await installOf(ws)).toBeNull();
    expect(logLines().some(line => line.includes("required on Cloud"))).toBe(true);
    vi.stubEnv("CRUMB_TIER", "self_host");
  });
});

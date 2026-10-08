import { afterEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { listTeams } from "@/lib/integrations/linear";
import { listProjectsWithToken, pickSite } from "@/lib/integrations/jira";
import { listInstallationRepos } from "@/lib/integrations/github";

// Tracker lists past their first page: Linear used to stop at 50 teams, Jira
// at 50 projects and GitHub at 100 repositories, so a big org's create dialog
// and default pickers never offered the rest. Plus the Jira site a workspace
// uses when one Atlassian login reaches several.

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("tracker lists follow every page", () => {
  it("linear: by cursor", async () => {
    const afters: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: RequestInit) => {
      const { variables } = JSON.parse(String(init?.body));
      afters.push(variables.after);
      const first = variables.after === null;
      return Response.json({ data: { teams: {
        nodes: [first ? { id: "t1", name: "Eng", key: "ENG" } : { id: "t2", name: "Design", key: "DES" }],
        pageInfo: { hasNextPage: first, endCursor: first ? "c1" : null },
      } } });
    }));
    expect((await listTeams("tok")).map(t => t.key)).toEqual(["ENG", "DES"]);
    expect(afters).toEqual([null, "c1"]);
  });

  it("jira: by startAt until the last page", async () => {
    const starts: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const startAt = new URL(url).searchParams.get("startAt")!;
      starts.push(startAt);
      const values = startAt === "0"
        ? Array.from({ length: 50 }, (_, i) => ({ id: String(i), key: `P${i}`, name: `Project ${i}` }))
        : [{ id: "50", key: "LAST", name: "Last" }];
      return Response.json({ values, isLast: startAt !== "0" });
    }));
    const projects = await listProjectsWithToken("cloud-1", "tok");
    expect(projects).toHaveLength(51);
    expect(projects.at(-1)?.key).toBe("LAST");
    expect(starts).toEqual(["0", "50"]);
  });

  it("github: by page until total_count", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    vi.stubEnv("GITHUB_APP_ID", "1");
    vi.stubEnv("GITHUB_APP_PRIVATE_KEY", privateKey.export({ type: "pkcs1", format: "pem" }).toString());
    const pages: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/access_tokens")) return Response.json({ token: "ghs_test", expires_at: "" });
      const page = new URL(url).searchParams.get("page")!;
      pages.push(page);
      const repositories = Array.from({ length: page === "1" ? 100 : 20 }, (_, i) => ({ full_name: `acme/r${page}-${i}` }));
      return Response.json({ total_count: 120, repositories });
    }));
    expect(await listInstallationRepos("4242")).toHaveLength(120);
    expect(pages).toEqual(["1", "2"]);
  });
});

describe("the jira site a workspace uses", () => {
  const a = { id: "a", url: "https://a.atlassian.net", name: "A", scopes: [] };
  const b = { id: "b", url: "https://b.atlassian.net", name: "B", scopes: [] };

  it("keeps the chosen site, takes a lone one, and otherwise leaves it to the admin", () => {
    expect(pickSite([a, b], "b")).toBe(b);
    expect(pickSite([a], null)).toBe(a);
    expect(pickSite([a], "gone")).toBe(a);
    // Never just the first of several.
    expect(pickSite([a, b], null)).toBeNull();
    expect(pickSite([a, b], "gone")).toBeNull();
    expect(pickSite([], "a")).toBeNull();
  });
});

import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

// The thread's Engineering tile on a plan without tracker tickets (a Cloud
// downgrade keeps trackers connected; Free can't connect one): it says the
// plan is why, instead of offering Create or pointing at Settings to connect.

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock("@/components/confirm", () => ({ useConfirm: () => async () => false }));
vi.mock("@/components/toast", () => ({ useToast: () => ({ show: () => {} }) }));
vi.mock("@/app/(app)/thread/[shortId]/actions", () => ({
  externalStatusSetup: async () => ({ setUp: true, cloud: true }),
  unlinkExternalTicket: async () => ({ ok: true }),
  createExternalTicket: async () => ({ ok: false, error: "failed" }),
  listProviderTargets: async () => ({ ok: false, error: "failed" }),
  suggestExternalTicket: async () => ({ ok: false, error: "failed" }),
}));

import { ExternalTicketTile, type ExternalTicketTileProps } from "@/app/(app)/thread/[shortId]/ExternalTicketTile";

const AT = "2026-10-01T00:00:00.000Z";

// The unit config compiles JSX to React.createElement without importing React.
function tile(workspace: Partial<ExternalTicketTileProps["workspace"]>): string {
  vi.stubGlobal("React", React);
  return renderToStaticMarkup(React.createElement(ExternalTicketTile, {
    itemShortId: "FB-1", itemTitle: "Export", itemBody: "", aiAvailable: false, isAdmin: true,
    workspace: { linearInstalledAt: null, jiraInstalledAt: null, githubInstalledAt: null, integrationsAllowed: true, ...workspace },
    item: { externalProvider: null, externalTicketId: null, externalTicketUrl: null, externalStatus: null, externalSyncedAt: null },
  }));
}

describe("Engineering tile", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("offers Connect, then Create, while the plan includes tickets", () => {
    expect(tile({})).toContain("Connect Linear, Jira, or GitHub");
    expect(tile({ linearInstalledAt: AT })).toContain("Create Linear ticket");
  });

  it("says the plan leaves them out, connected or not", () => {
    const free = tile({ integrationsAllowed: false });
    expect(free).toContain("include creating tickets.");
    expect(free).not.toContain("Connect Linear");
    expect(free).toContain('href="/settings/billing"');

    const downgraded = tile({ integrationsAllowed: false, linearInstalledAt: AT });
    expect(downgraded).toContain("include creating Linear tickets.");
    expect(downgraded).not.toContain("Create Linear ticket");
    expect(tile({ integrationsAllowed: false, linearInstalledAt: AT, githubInstalledAt: AT })).toContain("include creating tickets.");
  });
});

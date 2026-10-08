import { describe, expect, it } from "vitest";
import {
  ASSIGNEE_ME, ASSIGNEE_NONE, INITIATIVE_NONE, inTab, matchesFilters, readFilters, viewQuery, withFilters,
  type InboxFilters,
} from "@/app/(app)/inbox/view-query";
import type { InboxRow } from "@/app/(app)/inbox/InboxTable";

// The inbox view lives in the URL: the tab, sort and filters (and the search,
// which saved views keep too). These pin the URL round trip, the canonical
// string a saved view is stored and matched by, and the row filters behind the
// tab counts.

const NONE: InboxFilters = { tab: "yours", sort: "newest", status: null, type: null, assignee: null, account: null, initiative: null };

function row(over: Partial<InboxRow>): InboxRow {
  return {
    id: "i1", shortId: "FB-1", title: "t", preview: null, searchText: "", type: "idea", status: "open",
    source: null, sourceUrl: null, tags: [], assigneeId: null, createdAtIso: "2026-10-01T00:00:00.000Z",
    accountId: "acct-1", accountName: "Acme", arrAtStakeCents: 0, reachAccounts: 1, submitterName: "Maya", previewSubmitter: false,
    assigneeInitials: null, replyCount: 0, lastReplySide: null, lastExternalReplyAtIso: null, vendorReplied: false,
    externalProvider: null, externalStatus: null, externalSyncedAtIso: null, lastNotifiedAtIso: null,
    initiativeId: null, initiativeName: null, initiativeColor: null, suggestion: null,
    aiSeverity: null, aiSentiment: null, aiTriageReason: null, aiSuggestedAssignee: null,
    mergedIntoId: null, mergedCount: 0,
    ...over,
  };
}

describe("inbox view URL", () => {
  it("reads known values and drops junk", () => {
    expect(readFilters(new URLSearchParams(""))).toEqual(NONE);
    expect(readFilters(new URLSearchParams("tab=mine&sort=revenue&status=shipped&type=bug&assignee=me&account=a1&initiative=__none")))
      .toEqual({ tab: "mine", sort: "revenue", status: "shipped", type: "bug", assignee: "me", account: "a1", initiative: INITIATIVE_NONE });
    expect(readFilters(new URLSearchParams(`tab=nope&sort=up&status=toString&type=praise&account=${"x".repeat(65)}`)))
      .toEqual(NONE);
  });

  it("writes the filters into the URL, leaving defaults out and keeping the search and other params", () => {
    const out = withFilters(new URLSearchParams("q=export&compose=1&status=open"), { ...NONE, tab: "all", account: "a1" });
    expect(out.toString()).toBe("q=export&compose=1&tab=all&account=a1");
    expect(withFilters(new URLSearchParams("tab=all&sort=revenue"), NONE).toString()).toBe("");
  });

  it("stores a saved view as one canonical string, whatever order the URL had", () => {
    const a = viewQuery("?q= csv export &account=a1&tab=all&compose=1&status=bogus");
    expect(a).toBe("tab=all&account=a1&q=csv+export");
    expect(viewQuery("account=a1&q=csv+export&tab=all")).toBe(a);
    expect(viewQuery("tab=yours&sort=newest")).toBe("");
    expect(viewQuery(`q=${"a".repeat(300)}`)).toBe(`q=${"a".repeat(200)}`);
  });
});

describe("inbox row filters", () => {
  it("narrows by status, type, account, assignee and initiative", () => {
    const r = row({ status: "planned", type: "bug", accountId: "a1", assigneeId: "me-id", initiativeId: "ini-1" });
    const f = (over: Partial<InboxFilters>) => matchesFilters(r, { ...NONE, ...over }, "me-id");
    expect(f({})).toBe(true);
    expect(f({ status: "planned", type: "bug", account: "a1", assignee: ASSIGNEE_ME, initiative: "ini-1" })).toBe(true);
    expect(f({ status: "shipped" })).toBe(false);
    expect(f({ type: "idea" })).toBe(false);
    expect(f({ account: "a2" })).toBe(false);
    expect(f({ assignee: ASSIGNEE_NONE })).toBe(false);
    expect(f({ assignee: "someone-else" })).toBe(false);
    expect(f({ initiative: INITIATIVE_NONE })).toBe(false);
    expect(matchesFilters(row({}), { ...NONE, assignee: ASSIGNEE_NONE, initiative: INITIATIVE_NONE }, "me-id")).toBe(true);
  });

  it("keeps closed loops out of Mine; they live under Closed", () => {
    const open = row({ assigneeId: "me-id", status: "planned" });
    const shipped = row({ assigneeId: "me-id", status: "shipped" });
    const theirs = row({ assigneeId: "sam", status: "open" });
    expect([open, shipped, theirs].filter(r => inTab(r, "mine", "me-id"))).toEqual([open]);
    expect(inTab(shipped, "closed", "me-id")).toBe(true);
    expect(inTab(shipped, "all", "me-id")).toBe(true);
    expect(inTab(row({ lastReplySide: "vendor" }), "waiting", "me-id")).toBe(true);
    expect(inTab(row({}), "yours", "me-id")).toBe(true);
  });
});

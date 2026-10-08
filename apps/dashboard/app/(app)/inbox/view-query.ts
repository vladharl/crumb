import { STATUS_LABELS } from "@crumb/ui";
import { engDoneUntold, loopTurn } from "@/lib/loop";
import type { InboxRow } from "./InboxTable";

// The inbox's working view lives in the URL, so a link or Back lands on the
// same rows: the tab, the sort, the filters (here) and the search (`q`, kept
// by the table as you type). Saved views store the canonical string. Pure, so
// the parsing and the row filters are unit-tested.

export type Tab = "yours" | "waiting" | "closed" | "mine" | "all" | "eng-done";
export type SortMode = "newest" | "revenue";

export const INITIATIVE_NONE = "__none";
export const ASSIGNEE_ME = "me";
export const ASSIGNEE_NONE = "none";

export type InboxFilters = {
  tab: Tab;
  sort: SortMode;
  status: string | null;
  type: string | null;
  assignee: string | null;   // ASSIGNEE_ME, ASSIGNEE_NONE or a member id
  account: string | null;
  initiative: string | null; // an initiative id or INITIATIVE_NONE
};

const TABS: ReadonlySet<string> = new Set<Tab>(["yours", "waiting", "closed", "mine", "all", "eng-done"]);
const SORTS: ReadonlySet<string> = new Set<SortMode>(["newest", "revenue"]);
const STATUSES: ReadonlySet<string> = new Set(Object.keys(STATUS_LABELS));
const TYPES: ReadonlySet<string> = new Set(["bug", "idea", "question"]);
const FILTER_KEYS = ["tab", "status", "type", "assignee", "account", "initiative", "sort"] as const;

// Ids are uuids; anything longer is junk from a hand-edited URL.
const idParam = (v: string | null) => (v && v.length <= 64 ? v : null);

export function readFilters(p: URLSearchParams): InboxFilters {
  const tab = p.get("tab");
  const sort = p.get("sort");
  const status = p.get("status");
  const type = p.get("type");
  return {
    tab: tab && TABS.has(tab) ? (tab as Tab) : "yours",
    sort: sort && SORTS.has(sort) ? (sort as SortMode) : "newest",
    status: status && STATUSES.has(status) ? status : null,
    type: type && TYPES.has(type) ? type : null,
    assignee: idParam(p.get("assignee")),
    account: idParam(p.get("account")),
    initiative: idParam(p.get("initiative")),
  };
}

/** `params` with the filters written in, defaults left out. Anything else in it (the search, compose=1) is kept. */
export function withFilters(params: URLSearchParams, f: InboxFilters): URLSearchParams {
  const out = new URLSearchParams(params);
  for (const k of FILTER_KEYS) out.delete(k);
  if (f.tab !== "yours") out.set("tab", f.tab);
  if (f.status) out.set("status", f.status);
  if (f.type) out.set("type", f.type);
  if (f.assignee) out.set("assignee", f.assignee);
  if (f.account) out.set("account", f.account);
  if (f.initiative) out.set("initiative", f.initiative);
  if (f.sort !== "newest") out.set("sort", f.sort);
  return out;
}

/** What a saved view stores and is matched by: the filters and the search, nothing else, in one order. */
export function viewQuery(search: string | URLSearchParams): string {
  const p = new URLSearchParams(search);
  const out = withFilters(new URLSearchParams(), readFilters(p));
  const q = (p.get("q") ?? "").trim().slice(0, 200);
  if (q) out.set("q", q);
  return out.toString();
}

/** The filters narrow the table before the tabs bucket it, so every tab count answers for what's shown. */
export function matchesFilters(r: InboxRow, f: InboxFilters, meId: string): boolean {
  if (f.status && r.status !== f.status) return false;
  if (f.type && r.type !== f.type) return false;
  if (f.account && r.accountId !== f.account) return false;
  if (f.assignee === ASSIGNEE_ME) { if (r.assigneeId !== meId) return false; }
  else if (f.assignee === ASSIGNEE_NONE) { if (r.assigneeId !== null) return false; }
  else if (f.assignee && r.assigneeId !== f.assignee) return false;
  if (f.initiative === INITIATIVE_NONE) { if (r.initiativeId !== null) return false; }
  else if (f.initiative && r.initiativeId !== f.initiative) return false;
  return true;
}

/** Whether a row shows under a tab. Mine is your open loops: closed ones live under Closed. */
export function inTab(r: InboxRow, tab: Tab, meId: string): boolean {
  if (tab === "all") return true;
  if (tab === "mine") return r.assigneeId === meId && loopTurn(r) !== "closed";
  if (tab === "eng-done") return engDoneUntold(r);
  return loopTurn(r) === tab;
}

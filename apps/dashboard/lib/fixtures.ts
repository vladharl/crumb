import type { Status, TypeKind } from "@crumb/ui";

export type TriageItem = {
  id: string;
  title: string;
  type: TypeKind;
  acct: string;
  who: string;
  age: string;
  status: Status;
  assignee: string | null;
  count: number;
};

export const triageItems: TriageItem[] = [
  { id: "FB-247", title: "Bulk export from cohort view as CSV",   type: "idea",        acct: "Acme",     who: "Maya",  age: "2h", status: "open",     assignee: null, count: 0 },
  { id: "FB-246", title: "Mobile layout breaks on iPad landscape", type: "bug",         acct: "Acme",     who: "Maya",  age: "5h", status: "review",   assignee: "LR", count: 3 },
  { id: "FB-245", title: "Slack DM when status changes",           type: "idea",        acct: "Lumen",    who: "Anika", age: "1d", status: "planned",  assignee: "LR", count: 2 },
  { id: "FB-244", title: "API returns 429 under burst load",       type: "question",    acct: "Acme",     who: "Dev",   age: "1d", status: "open",     assignee: null, count: 0 },
  { id: "FB-243", title: "Per-cohort retention math seems off",    type: "bug",         acct: "Lumen",    who: "Marco", age: "2d", status: "review",   assignee: "JK", count: 5 },
  { id: "FB-242", title: "Webhook for status change",              type: "idea", acct: "Vora",     who: "Sam",   age: "2d", status: "open",     assignee: null, count: 1 },
  { id: "FB-241", title: "Custom embedded domain",                 type: "idea",        acct: "Acme",     who: "Admin", age: "3d", status: "planned",  assignee: "LR", count: 4 },
  { id: "FB-240", title: "Datepicker doesn't respect locale",      type: "bug",         acct: "Pinedrop", who: "Tao",   age: "4d", status: "review",   assignee: "JK", count: 1 },
  { id: "FB-239", title: "SSO via Okta — more groups",             type: "idea", acct: "Stratus",  who: "Lin",   age: "5d", status: "progress", assignee: "LR", count: 8 },
  { id: "FB-238", title: "Export funnel data as XLSX",             type: "idea",        acct: "Lumen",    who: "Anika", age: "1w", status: "open",     assignee: null, count: 2 },
];

export const accounts = [
  { name: "Acme Co",      doms: ["acme.co", "acme.com", "acmecorp.io"] },
  { name: "Lumen Health", doms: ["lumen.health", "lumenhealth.com"] },
  { name: "Pinedrop",     doms: ["pinedrop.com"] },
];

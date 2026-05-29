import "server-only";
import { requireSession } from "./auth";
import type { Workspace, WorkspaceUser } from "@crumb/db";

export async function getActiveWorkspace(): Promise<Workspace> {
  const s = await requireSession();
  return s.workspace;
}

export async function getActiveSession(): Promise<{ workspace: Workspace; user: WorkspaceUser }> {
  return requireSession();
}

const RELATIVE_DIVS: Array<[unit: string, ms: number]> = [
  ["w", 1000 * 60 * 60 * 24 * 7],
  ["d", 1000 * 60 * 60 * 24],
  ["h", 1000 * 60 * 60],
  ["m", 1000 * 60],
];

export function ageFrom(d: Date) {
  const diff = Date.now() - d.getTime();
  if (diff < 60_000) return "now";
  for (const [unit, ms] of RELATIVE_DIVS) {
    if (diff >= ms) return `${Math.floor(diff / ms)}${unit}`;
  }
  return "now";
}

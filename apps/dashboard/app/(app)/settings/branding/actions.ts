"use server";

import { eq } from "drizzle-orm";
import { db, workspaces } from "@crumb/db";
import { revalidatePath } from "next/cache";
import { requireSession } from "@/lib/auth";

type SaveInput = {
  name?: string;
  accent?: string;
  launcherBg?: string;
  launcherGlass?: boolean;
  position?: string;
  launcherVisibility?: string;
  launcherOffsetX?: number;
  launcherOffsetY?: number;
  productUrl?: string;
};

const VALID_POSITIONS = new Set(["corner", "pill", "tab"]);
const VALID_VISIBILITY = new Set(["auto", "always", "hidden"]);
// Keep offsets sane — enough to clear another widget's bubble, not enough to
// fling the launcher off-screen.
const MAX_OFFSET = 400;

export type SaveResult = { ok: true } | { ok: false; error: string };

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

export async function saveBranding(input: SaveInput): Promise<SaveResult> {
  const { workspace, user } = await requireSession();
  if (user.role !== "admin") return { ok: false, error: "Only admins can edit branding." };

  const patch: Record<string, string | boolean | number | null> = {};

  if (typeof input.name === "string") {
    const name = input.name.trim();
    if (!name) return { ok: false, error: "Workspace name can't be empty." };
    patch.name = name;
  }

  if (typeof input.accent === "string") {
    if (!HEX_RE.test(input.accent)) return { ok: false, error: "Dot color must be a six-digit hex (e.g. #E27D3A)." };
    patch.accent = input.accent.toUpperCase();
  }

  if (typeof input.launcherBg === "string") {
    if (!HEX_RE.test(input.launcherBg)) return { ok: false, error: "Launcher color must be a six-digit hex (e.g. #4A2E1F)." };
    patch.launcherBg = input.launcherBg.toUpperCase();
  }

  if (typeof input.position === "string") {
    if (!VALID_POSITIONS.has(input.position)) return { ok: false, error: "Pick a valid widget position." };
    patch.position = input.position;
  }

  if (typeof input.launcherGlass === "boolean") {
    patch.launcherGlass = input.launcherGlass;
  }

  if (typeof input.launcherVisibility === "string") {
    if (!VALID_VISIBILITY.has(input.launcherVisibility)) return { ok: false, error: "Pick a valid launcher visibility." };
    patch.launcherVisibility = input.launcherVisibility;
  }

  for (const axis of ["launcherOffsetX", "launcherOffsetY"] as const) {
    const v = input[axis];
    if (typeof v === "number") {
      if (!Number.isFinite(v) || Math.abs(v) > MAX_OFFSET) return { ok: false, error: `Offset must be between -${MAX_OFFSET} and ${MAX_OFFSET}px.` };
      patch[axis] = Math.round(v);
    }
  }

  if (typeof input.productUrl === "string") {
    const url = input.productUrl.trim();
    if (url === "") {
      patch.productUrl = null;
    } else {
      try {
        const parsed = new URL(url);
        if (!/^https?:$/.test(parsed.protocol)) return { ok: false, error: "Product URL must start with http:// or https://." };
        patch.productUrl = parsed.toString();
      } catch {
        return { ok: false, error: "Product URL doesn't look like a valid URL." };
      }
    }
  }

  if (Object.keys(patch).length === 0) return { ok: true };

  await db.update(workspaces).set(patch).where(eq(workspaces.id, workspace.id));
  revalidatePath("/settings/branding");
  return { ok: true };
}

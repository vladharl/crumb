import { NextResponse } from "next/server";
import { getActiveSession } from "@/lib/server";
import { getManifest } from "@/lib/replay/read";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Vendor-side. The dashboard session cookie identifies the workspace; we
// scope the manifest read to that workspace so a UUID alone can't pull
// content from a sibling tenant.
export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const session = await getActiveSession();
  const manifest = await getManifest(params.id, session.workspace.id);
  if (!manifest) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json(manifest);
}

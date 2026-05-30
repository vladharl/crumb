import { NextResponse } from "next/server";
import { getActiveSession } from "@/lib/server";
import { getChunk } from "@/lib/replay/read";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Returns the chunk's raw rrweb events JSON to the player. Workspace
// scoping happens inside `getChunk` so the (sessionId, seq, workspaceId)
// triple all has to line up — no `getBytes(storageKey)` shortcut.
export async function GET(
  _req: Request,
  { params }: { params: { id: string; seq: string } },
) {
  const session = await getActiveSession();
  const seq = Number.parseInt(params.seq, 10);
  if (!Number.isFinite(seq) || seq < 0) {
    return NextResponse.json({ error: "bad_sequence" }, { status: 400 });
  }
  const bytes = await getChunk(params.id, seq, session.workspace.id);
  if (!bytes) return NextResponse.json({ error: "not_found" }, { status: 404 });
  // Node's Buffer is a Uint8Array under the hood; wrapping in Uint8Array is
  // the cleanest way to satisfy NextResponse's BodyInit type without copying.
  return new NextResponse(new Uint8Array(bytes), {
    status: 200,
    headers: { "content-type": "application/x-rrweb-events+json" },
  });
}

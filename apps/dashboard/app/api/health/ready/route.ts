import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@crumb/db";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Readiness probe. Answers "can this instance serve real traffic right now?"
// — i.e. is the database reachable. A load balancer routes traffic only to
// ready instances, so this gates the instance OUT during a DB blip without
// the orchestrator killing the process (that's liveness, /api/health).
export async function GET() {
  try {
    await db.execute(sql`select 1`);
    return NextResponse.json({ ok: true, db: "up" });
  } catch (err) {
    log.error("readiness DB check failed", { scope: "crumb/health", err });
    return NextResponse.json({ ok: false, db: "down" }, { status: 503 });
  }
}

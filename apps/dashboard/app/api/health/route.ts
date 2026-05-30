import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Liveness probe. Answers "is the process up and serving?" without touching
// any dependency — a load balancer / orchestrator uses this to decide
// whether to restart the container. Cheap and always-200 while the event
// loop is healthy. For dependency health (DB reachable) see /api/health/ready.
export function GET() {
  return NextResponse.json({ ok: true });
}

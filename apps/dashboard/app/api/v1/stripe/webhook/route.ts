import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, workspaces } from "@crumb/db";
import { stripeClient, STRIPE_WEBHOOK_SECRET } from "@/lib/stripe";
import type Stripe from "stripe";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// ─── POST /api/v1/stripe/webhook ───────────────────────────────
// Stripe sends subscription lifecycle events here. Signature is verified
// with STRIPE_WEBHOOK_SECRET (set via the Stripe dashboard "Add endpoint"
// flow). The handler keeps the workspaces row in sync — Stripe is the
// source of truth.
//
// Events we care about:
//   customer.subscription.created
//   customer.subscription.updated
//   customer.subscription.deleted
//   invoice.payment_failed   (status flips to past_due via subscription.updated;
//                             but we also write a log line so we notice)
//
// All other events get a 200 ok so Stripe stops retrying.
export async function POST(req: Request) {
  const stripe = stripeClient();
  const secret = STRIPE_WEBHOOK_SECRET();
  if (!stripe || !secret) {
    return NextResponse.json({ error: "stripe_not_configured" }, { status: 503 });
  }

  const sig = req.headers.get("stripe-signature");
  if (!sig) return NextResponse.json({ error: "missing_signature" }, { status: 400 });

  const raw = await req.text();
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(raw, sig, secret);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "verify_failed";
    return NextResponse.json({ error: "invalid_signature", detail: msg }, { status: 400 });
  }

  try {
    switch (event.type) {
      case "customer.subscription.created":
      case "customer.subscription.updated": {
        const sub = event.data.object as Stripe.Subscription;
        await syncSubscription(sub);
        break;
      }
      case "customer.subscription.deleted": {
        const sub = event.data.object as Stripe.Subscription;
        await db
          .update(workspaces)
          .set({
            subscriptionStatus: "canceled",
            stripeSubscriptionId: null,
            currentPeriodEnd: null,
            planId: "free",
          })
          .where(eq(workspaces.stripeCustomerId, sub.customer as string));
        break;
      }
      case "invoice.payment_failed": {
        const invoice = event.data.object as Stripe.Invoice;
        // eslint-disable-next-line no-console
        console.warn(`[crumb/stripe] payment failed for customer=${invoice.customer} invoice=${invoice.id}`);
        // The subscription.updated event that follows will flip status to
        // past_due, so no DB write needed here.
        break;
      }
      default:
        // Stripe sends a lot of events we don't model; that's fine.
        break;
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[crumb/stripe] handler for ${event.type} threw:`, err);
    // Returning 500 makes Stripe retry; that's the right behavior when
    // our DB is temporarily down.
    return NextResponse.json({ error: "handler_failed" }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}

// Reads price/period from the subscription object and writes them onto
// the matching workspace (looked up by stripe_customer_id).
async function syncSubscription(sub: Stripe.Subscription): Promise<void> {
  const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
  // Subscriptions can have multiple items; we only model one for now.
  // Note: in Stripe API 2026-04-22 current_period_end moved from the
  // Subscription to the SubscriptionItem — read it off the line.
  const item = sub.items.data[0];
  const seats = item?.quantity ?? 1;
  // plan_id is whatever the price's lookup_key resolves to (e.g. "team",
  // "growth"); fall back to the raw price id if no lookup_key was set.
  const lookupKey = item?.price?.lookup_key ?? null;
  const planId = lookupKey ?? item?.price?.id ?? "unknown";
  const currentPeriodEnd = item?.current_period_end
    ? new Date(item.current_period_end * 1000)
    : null;

  await db
    .update(workspaces)
    .set({
      stripeSubscriptionId: sub.id,
      subscriptionStatus: sub.status,
      currentPeriodEnd,
      seats,
      planId,
    })
    .where(eq(workspaces.stripeCustomerId, customerId));
}

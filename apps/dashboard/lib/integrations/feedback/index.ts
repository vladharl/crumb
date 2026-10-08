import "server-only";
import { gong } from "./gong";
import { zendesk } from "./zendesk";
import { intercom } from "./intercom";
import { freshdesk } from "./freshdesk";
import { freshchat } from "./freshchat";
import type { FeedbackAdapter, FeedbackProvider } from "./types";

// Registry of inbound feedback connectors (Autopilot). Mirrors lib/integrations/
// crm/index.ts. The provider key matches both integration_connections.provider
// and inbound_captures.source, so a connection round-trips to a capture source.

const ADAPTERS: Record<FeedbackProvider, FeedbackAdapter> = { gong, zendesk, intercom, freshdesk, freshchat };

export const FEEDBACK_PROVIDERS: FeedbackProvider[] = ["gong", "zendesk", "intercom", "freshdesk", "freshchat"];

export function getFeedbackAdapter(provider: FeedbackProvider): FeedbackAdapter {
  return ADAPTERS[provider];
}

export function isFeedbackProvider(v: string): v is FeedbackProvider {
  return Object.hasOwn(ADAPTERS, v); // not `in`: "constructor" would pass
}

export type { FeedbackProvider, FeedbackAdapter, FeedbackRecord, FeedbackPage } from "./types";

import "server-only";
import { hubspot } from "./hubspot";
import { salesforce } from "./salesforce";
import type { CrmAdapter, CrmProvider } from "./types";

const ADAPTERS: Record<CrmProvider, CrmAdapter> = { hubspot, salesforce };

export const CRM_PROVIDERS: CrmProvider[] = ["hubspot", "salesforce"];

export function getCrmAdapter(provider: CrmProvider): CrmAdapter {
  return ADAPTERS[provider];
}

export function crmConfigured(provider: CrmProvider): boolean {
  return ADAPTERS[provider].configured();
}

export function anyCrmConfigured(): boolean {
  return hubspot.configured() || salesforce.configured();
}

export type { CrmProvider, CrmAdapter, CrmCompany } from "./types";

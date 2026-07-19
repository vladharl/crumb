import "server-only";

// Community-edition stub for lib/ai/size-request.ts — aliased in when
// CRUMB_EDITION != cloud so the aistack client + prompt never enter the bundle.
// Mirrors the disabled self-host runtime (sizeRequestConfigured() === false;
// sizeRequest() === null).

export const SIZE_REQUEST_MODEL = "qwen-35b-8bit";

export type SizeRequestInput = {
  requestText: string;
  repoContext?: {
    repo: string;
    readme: string | null;
    topLevelTree: string | null;
  };
  similar: Array<{ title: string; status: string }>;
};

export type Size = "S" | "M" | "L" | "XL";
export type Confidence = "low" | "medium" | "high";
export type SizeRequestResult = {
  restatement: string;
  size: Size;
  rationale: string;
  confidence: Confidence;
};

export function sizeRequestConfigured(): boolean {
  return false;
}

export async function sizeRequest(_input: SizeRequestInput): Promise<SizeRequestResult | null> {
  return null;
}

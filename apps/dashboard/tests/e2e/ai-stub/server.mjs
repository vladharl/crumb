// Deterministic OpenAI-compatible AI stub for e2e. No deps, no network, no
// model cold-load. Point AISTACK_BASE_URL + EMBEDDINGS_BASE_URL at this server
// (e.g. http://localhost:3939/v1) and any AISTACK_API_KEY.
//
//   - /v1/embeddings        → bag-of-words hashed + L2-normalized 1024-dim
//                             vectors, so texts that share vocabulary get high
//                             cosine similarity (dedup/Ask ANN clear their
//                             thresholds) and disjoint texts get low.
//   - /v1/chat/completions  → branches on a marker in the prompt to return the
//                             canned single-line JSON each AI feature expects.
//   - /health               → readiness probe for Playwright's webServer.

import { createServer } from "node:http";

const PORT = Number(process.env.AI_STUB_PORT || 3939);
const DIM = 1024;

function embed(text) {
  const v = new Float64Array(DIM);
  const tokens = String(text || "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  for (const tok of tokens) {
    // FNV-1a hash → bucket. Deterministic across runs.
    let h = 2166136261;
    for (let i = 0; i < tok.length; i++) {
      h ^= tok.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    v[Math.abs(h) % DIM] += 1;
  }
  let norm = 0;
  for (let i = 0; i < DIM; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm) || 1;
  const out = new Array(DIM);
  for (let i = 0; i < DIM; i++) out[i] = v[i] / norm;
  return out;
}

function chatContent(prompt) {
  const p = String(prompt || "");
  // Auto-triage (lib/ai/triage.ts). Input-sensitive so churn (negative
  // sentiment) and translation (non-en language) are e2e-testable.
  if (p.includes("triaging a piece of inbound customer feedback")) {
    const idm = p.match(/id=([0-9a-fA-F-]{36})/); // first team-member id → real assignee target
    const tym = p.match(/declared type:\s*(\w+)/);
    // Scan ONLY the feedback's own text. The instruction template contains words
    // like "angry/frustrated" — matching the whole prompt would force every item
    // negative (and "medium" severity would never appear).
    const fbm = p.match(/Feedback:\n([\s\S]*?)\n\nRespond with a single line/);
    const lc = (fbm ? fbm[1] : "").toLowerCase();
    const negative = /\b(angry|furious|frustrat|broken|terrible|awful|unusable|cancel|refund|hate|disappoint)\b/.test(lc);
    const lang = /\b(hola|gracias|necesitamos|exportar|por favor)\b/.test(lc) ? "es"
               : /\b(bonjour|merci|besoin)\b/.test(lc) ? "fr"
               : "en";
    return JSON.stringify({
      type: tym ? tym[1] : "idea",
      severity: negative ? "high" : "medium",
      sentiment: negative ? -0.7 : 0,
      urgency: negative ? 0.8 : 0.5,
      suggested_assignee_id: idm ? idm[1] : null,
      is_duplicate_likely: false,
      lang,
      summary: "e2e one-line summary of what the customer asked for",
      reason: negative ? "frustrated customer" : "e2e triage stub",
      confidence: 0.9,
    });
  }
  // Ask your feedback (lib/ai/ask.ts) — echo a context FB-id so a citation lands
  if (p.includes("answering a question using ONLY the customer feedback requests")) {
    const fb = p.match(/\[(FB-\d+)\]/);
    return `Based on the feedback, customers want faster exports. [${fb ? fb[1] : "FB-1"}]`;
  }
  // Reply draft (lib/ai/reply.ts)
  if (p.includes("drafting a customer-facing reply")) {
    return JSON.stringify({ draft: "Thanks for flagging this — we're on it and will share an update soon.", reason: "e2e", confidence: 0.9 });
  }
  // Translation (lib/ai/reply.ts translate) — raw text, not JSON
  if (p.includes("Translate the following text into")) {
    return "Translated text (e2e stub).";
  }
  // Replay summary (lib/ai/replay-summary.ts)
  if (p.includes("summarizing a customer's screen session")) {
    return JSON.stringify({ summary: "The user navigated to Reports and hunted for an export option before leaving.", highlights: ["hunted for Export for 40s"] });
  }
  // Clustering (lib/ai/cluster.ts) — return no suggestion, harmless
  if (p.includes("classifying a piece of inbound customer feedback")) {
    return JSON.stringify({ initiative_id: null, confidence: 0, reason: "e2e stub" });
  }
  // Account matcher fallback (lib/ai/match-account.ts) — real module usually
  // resolves via its name heuristic first; this covers the model fallback.
  if (p.includes("matching inbound customer feedback") || p.includes("which customer account")) {
    const idm = p.match(/id=([0-9a-fA-F-]{36})/);
    return JSON.stringify({ account_id: idm ? idm[1] : null, account_name: null, confidence: 0.7 });
  }
  return "{}";
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => resolve(b));
  });
}

createServer(async (req, res) => {
  if (req.method === "GET" && req.url.startsWith("/health")) {
    res.writeHead(200, { "content-type": "text/plain" }).end("ok");
    return;
  }
  const body = await readBody(req);
  let json = {};
  try { json = JSON.parse(body || "{}"); } catch { /* leave {} */ }

  if (req.url.startsWith("/v1/embeddings")) {
    const input = json.input;
    const arr = Array.isArray(input) ? input : [input ?? ""];
    const data = arr.map((t, i) => ({ object: "embedding", index: i, embedding: embed(t) }));
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ object: "list", model: json.model || "stub", data }));
    return;
  }

  if (req.url.startsWith("/v1/chat/completions")) {
    const userMsg = (json.messages || []).map((m) => m.content).join("\n");
    res.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({ choices: [{ message: { content: chatContent(userMsg) } }] }),
    );
    return;
  }

  res.writeHead(404, { "content-type": "text/plain" }).end("not found");
}).listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[ai-stub] listening on http://localhost:${PORT}`);
});

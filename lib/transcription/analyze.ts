export type CallIntent =
  | "quote_request"
  | "booked"
  | "existing_customer"
  | "wrong_number"
  | "solicitation"
  | "other";

export interface CallAnalysis {
  intent: CallIntent;
  spamScore: number; // 0..1
}

/**
 * Lightweight keyword analysis of a call transcript — intent label + a spam score.
 * Deterministic and free (no LLM). The score feeds spam exclusion from ROI; intent
 * helps triage the lead inbox. Good enough as a first pass; an LLM pass can refine
 * later if needed.
 */
const SOLICITATION = [
  "calling about your google listing",
  "business listing",
  "search engine optimization",
  "rank higher",
  "merchant cash",
  "lower your rate",
  "warranty",
  "this is not a sales call",
  "final notice",
  "press one",
  "google business profile specialist",
];
const QUOTE = ["quote", "estimate", "how much", "price", "cost", "come out", "look at", "free estimate"];
const BOOK = ["schedule", "book", "set up an appointment", "when can you", "get on the schedule"];
const EXISTING = ["already a customer", "you did work", "last time", "invoice", "my account", "follow up on the job"];
const WRONG = ["wrong number", "sorry to bother", "didn't mean to call"];

export function analyzeCall(transcript: string): CallAnalysis {
  const t = (transcript || "").toLowerCase();
  if (!t.trim()) return { intent: "other", spamScore: 0 };

  const solicitationHits = SOLICITATION.filter((p) => t.includes(p)).length;
  const spamScore = Math.min(1, solicitationHits / 2);

  let intent: CallIntent = "other";
  if (solicitationHits > 0) intent = "solicitation";
  else if (WRONG.some((p) => t.includes(p))) intent = "wrong_number";
  else if (EXISTING.some((p) => t.includes(p))) intent = "existing_customer";
  else if (BOOK.some((p) => t.includes(p))) intent = "booked";
  else if (QUOTE.some((p) => t.includes(p))) intent = "quote_request";

  return { intent, spamScore };
}

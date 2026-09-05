import { getCredential } from "@/lib/credentials";
import { analyzeCall } from "./analyze";
import { normalizeSelfReported, SELF_REPORTED_CHANNELS, type SelfReportedChannel } from "@/lib/leads/self-reported";

export interface LeadClassification {
  isLead: boolean; // did the caller request an estimate / want tree work?
  reason: string;
  intent: string; // stored on calls.intentLabel
  spamScore: number; // 0..1
  /** One plain-English sentence describing the call (AI only — null on keyword fallback). */
  summary: string | null;
  /** Caller's own "how did you hear about us" answer, if they said one (AI only). */
  selfReportedSource: string | null;
  /** That answer rolled up to a channel — the model's pick, else the normalizer's. */
  selfReportedChannel: SelfReportedChannel | null;
  method: "ai" | "keyword";
}

// Fast, cheap model for per-call classification.
const MODEL = "claude-haiku-4-5-20251001";

/**
 * What kind of contact is being classified. The decision ("did this person ask for
 * tree work?") is identical across channels; only the wording of the prompt and the
 * "no content" message differ.
 */
export type ContactKind = "call" | "text";

const KIND_COPY: Record<ContactKind, { noun: string; content: string; empty: string }> = {
  call: { noun: "inbound phone call", content: "Transcript", empty: "no transcript" },
  text: { noun: "inbound text message (SMS)", content: "Message", empty: "no message body" },
};

/**
 * Decide whether a contact is an actual lead from what was said: did the person request
 * an estimate / quote / tree work? Uses Claude when an Anthropic key is configured,
 * else falls back to keyword analysis — so it works day-1 and upgrades to real AI when
 * the key lands. Always returns a keyword spam score as a floor.
 */
export async function classifyCallLead(
  transcript: string,
  kind: ContactKind = "call",
): Promise<LeadClassification> {
  const kw = analyzeCall(transcript);
  const t = (transcript || "").trim();
  const kwIsLead = kw.intent === "quote_request" || kw.intent === "booked";

  const apiKey = await getCredential("anthropic", "api_key");
  if (!apiKey || !t) {
    return { isLead: kwIsLead, reason: t ? `keyword: ${kw.intent}` : KIND_COPY[kind].empty, intent: kw.intent, spamScore: kw.spamScore, summary: null, selfReportedSource: null, selfReportedChannel: null, method: "keyword" };
  }

  try {
    const ai = await classifyWithClaude(apiKey, t, kind);
    return {
      isLead: !!ai.requested_estimate && !ai.is_spam,
      reason: ai.reason || (ai.requested_estimate ? "requested an estimate" : "no estimate request"),
      intent: ai.intent || kw.intent,
      spamScore: ai.is_spam ? 1 : kw.spamScore,
      summary: ai.summary?.trim() || null,
      selfReportedSource: ai.self_reported_source?.trim() || null,
      selfReportedChannel:
        (ai.self_reported_channel && (SELF_REPORTED_CHANNELS as readonly string[]).includes(ai.self_reported_channel)
          ? (ai.self_reported_channel as SelfReportedChannel)
          : null) ?? normalizeSelfReported(ai.self_reported_source),
      method: "ai",
    };
  } catch (err) {
    console.error("[classify-lead] AI failed; keyword fallback", err);
    return { isLead: kwIsLead, reason: `keyword: ${kw.intent} (ai error)`, intent: kw.intent, spamScore: kw.spamScore, summary: null, selfReportedSource: null, selfReportedChannel: null, method: "keyword" };
  }
}

interface ClaudeResult {
  requested_estimate: boolean;
  intent: string;
  is_spam: boolean;
  reason: string;
  summary?: string | null;
  self_reported_source?: string | null;
  self_reported_channel?: string | null;
}

async function classifyWithClaude(
  apiKey: string,
  transcript: string,
  kind: ContactKind,
): Promise<ClaudeResult> {
  const copy = KIND_COPY[kind];
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 500,
      tool_choice: { type: "tool", name: "record_call" },
      tools: [
        {
          name: "record_call",
          description: `Record the classification of an ${copy.noun}.`,
          input_schema: {
            type: "object",
            properties: {
              requested_estimate: {
                type: "boolean",
                description: "True only if the person is a prospective customer asking about or requesting an estimate/quote/price, or wanting tree work done (removal, trimming, stump grinding, etc.). False for existing-customer questions, wrong numbers, vendors/solicitors, automated/notification messages, or anything unrelated.",
              },
              intent: { type: "string", enum: ["quote_request", "booked", "existing_customer", "wrong_number", "solicitation", "other"] },
              is_spam: { type: "boolean", description: "True for solicitations, robocalls, or spam." },
              reason: { type: "string", description: "One short sentence explaining the decision." },
              summary: {
                type: "string",
                description: "One plain-English sentence describing the contact for the business owner, e.g. 'Homeowner in Edwardsville wants two oak trees trimmed, scheduled an estimate for Tuesday.' Max ~25 words.",
              },
              self_reported_source: {
                type: ["string", "null"],
                description: "If the person mentions HOW they heard about the business (e.g. 'saw your truck', 'my neighbor used you', 'found you on Google', 'yard sign', 'Facebook ad'), a short normalized phrase like 'google search', 'referral - neighbor', 'yard sign', 'truck', 'facebook'. null if never mentioned.",
              },
              self_reported_channel: {
                type: ["string", "null"],
                enum: ["referral", "google_search", "social", "sign_or_truck", "repeat_customer", "other", null],
                description: "The same answer as ONE channel: referral (a person or another business recommended us), google_search (searched online / Google / Maps), social (Facebook, Instagram, Nextdoor), sign_or_truck (a yard sign, a truck, saw the crew), repeat_customer (has used us before themselves), other. null if never mentioned.",
              },
            },
            required: ["requested_estimate", "intent", "is_spam", "reason", "summary", "self_reported_source", "self_reported_channel"],
          },
        },
      ],
      messages: [
        {
          role: "user",
          content: `Classify this ${copy.noun} for a tree-service company based ONLY on the content below.\n\n${copy.content}:\n${transcript.slice(0, 6000)}`,
        },
      ],
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
  const j = (await res.json()) as { content?: Array<{ type: string; input?: ClaudeResult }> };
  const tool = j.content?.find((c) => c.type === "tool_use");
  if (!tool?.input) throw new Error("no tool_use in Anthropic response");
  return tool.input;
}

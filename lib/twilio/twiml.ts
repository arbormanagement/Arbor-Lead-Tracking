import twilio from "twilio";
import { env } from "@/lib/env";

const VoiceResponse = twilio.twiml.VoiceResponse;

export interface ForwardOptions {
  destination: string;
  /** Spoken to the answering rep before connect, e.g. "Tree lead — Google Ads".
   *  ⚠️ Only set this when the destination is a HUMAN. It plays into the answering
   *  party's ear, so pointing it at an AI voice agent (Retell/Chloe) feeds the agent's
   *  ASR a phantom caller utterance that it will answer. See the note in
   *  app/api/twilio/voice/route.ts — there is deliberately no default whisper. */
  whisper?: string;
  /** Recording-ready callback path under /api/twilio. */
  recordingCallbackPath?: string;
  /** Status callback for the dial leg. */
  actionPath?: string;
  /** Pre-call message played to the caller before dialing (e.g. a recording notice).
   *
   *  Tri-state, and the distinction is load-bearing:
   *    • `string`    — play this.
   *    • `undefined` — nothing configured; when `record` is on the default recording
   *                    notice plays, so no caller path is ever recorded silently.
   *    • `null`      — DELIBERATELY suppressed. Only pass this when the destination
   *                    announces the recording itself (Chloe opens with "on a recorded
   *                    line"), otherwise recording a caller in IL/MO with no notice at
   *                    all is a mixed-consent problem. */
  greeting?: string | null;
  /** Record the call (dual-channel). Default true. */
  record?: boolean;
  timeoutSec?: number;
}

const base = () => env.TWILIO_VOICE_WEBHOOK_BASE ?? `${env.APP_BASE_URL}/api/twilio`;

/** Default recording notice. IL/MO are mixed-consent states, so a notice MUST play
 *  whenever recording is on — `forwardTwiml` enforces this even if no greeting is
 *  configured. Exported so the voice route shares the same copy. */
export const DEFAULT_RECORDING_NOTICE = "This call may be recorded.";

/** Does a configured greeting already carry a recording disclosure? Deliberately
 *  loose — it matches "recorded", "recording", "record" — because the cost of a
 *  false positive is a slightly redundant greeting, while a false negative is an
 *  undisclosed recording in an all-party-consent state. */
function mentionsRecording(greeting: string): boolean {
  return /record/i.test(greeting);
}

/**
 * Build the inbound-call TwiML: recording notice/greeting → dial the destination
 * with dual-channel recording and a whisper. The `action` callback (/status)
 * receives the dial-leg outcome; there is deliberately NO TwiML after the <Dial>,
 * so the call simply ends when the dial leg does — the forward destination's own
 * voicemail/AI handles no-answers (app-side voicemail is not wanted).
 */
export function forwardTwiml(opts: ForwardOptions): string {
  const vr = new VoiceResponse();
  const record = opts.record !== false; // default on

  // Pre-call message. `null` means the caller was deliberately opted out (the
  // destination does its own disclosure); `undefined` means nothing was configured,
  // and when recording is on we force the notice so no caller path is recorded
  // silently. With recording off the greeting is fully optional per number.
  const greeting =
    opts.greeting === null
      ? undefined
      : (opts.greeting ?? (record ? DEFAULT_RECORDING_NOTICE : undefined));
  if (greeting) {
    vr.say({ voice: "Polly.Joanna" }, greeting);
    // A CUSTOM greeting replaces the default notice rather than joining it, so a
    // number configured with e.g. "Thanks for calling Arbor!" plus recording on
    // would record the caller with no disclosure at all. Only `null` (the explicit
    // opt-out above, where the destination discloses) may skip it — a configured
    // greeting that doesn't mention recording gets the notice appended.
    if (record && !mentionsRecording(greeting)) {
      vr.say({ voice: "Polly.Joanna" }, DEFAULT_RECORDING_NOTICE);
    }
  }

  const dial = vr.dial({
    ...(record
      ? {
          record: "record-from-answer-dual" as const,
          recordingStatusCallback: `${base()}${opts.recordingCallbackPath ?? "/recording"}?src=dial`,
          recordingStatusCallbackEvent: ["completed"],
        }
      : {}),
    action: `${base()}${opts.actionPath ?? "/status"}`,
    answerOnBridge: true,
    timeout: opts.timeoutSec ?? 20,
  });

  if (opts.whisper) {
    dial.number(
      { url: `${base()}/whisper?text=${encodeURIComponent(opts.whisper)}` },
      opts.destination,
    );
  } else {
    dial.number(opts.destination);
  }

  return vr.toString();
}

/** The whisper leg the rep hears before the caller is bridged. */
export function whisperTwiml(text: string): string {
  const vr = new VoiceResponse();
  vr.say({ voice: "Polly.Joanna" }, text);
  return vr.toString();
}

/** Hard reject (spam). */
export function rejectTwiml(): string {
  const vr = new VoiceResponse();
  vr.reject({ reason: "rejected" });
  return vr.toString();
}

/** Static fallback used if the DB lookup is slow — never leave a caller in dead air. */
export function fallbackTwiml(destination = env.TWILIO_DEFAULT_DESTINATION): string {
  const vr = new VoiceResponse();
  vr.dial({ answerOnBridge: true }, destination);
  return vr.toString();
}

export function xmlResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/xml; charset=utf-8" },
  });
}

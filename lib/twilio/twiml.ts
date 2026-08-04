import twilio from "twilio";
import { env } from "@/lib/env";

const VoiceResponse = twilio.twiml.VoiceResponse;

export interface ForwardOptions {
  destination: string;
  /** Spoken to the answering rep before connect, e.g. "Tree lead — Google Ads". */
  whisper?: string;
  /** Recording-ready callback path under /api/twilio. */
  recordingCallbackPath?: string;
  /** Status callback for the dial leg. */
  actionPath?: string;
  /** Pre-call message played to the caller before dialing (e.g. a recording notice).
   *  When `record` is on and this is unset, the default recording notice plays
   *  instead — a notice is mandatory whenever we record (IL/MO mixed consent). */
  greeting?: string;
  /** Record the call (dual-channel). Default true. */
  record?: boolean;
  timeoutSec?: number;
}

const base = () => env.TWILIO_VOICE_WEBHOOK_BASE ?? `${env.APP_BASE_URL}/api/twilio`;

/** Default recording notice. IL/MO are mixed-consent states, so a notice MUST play
 *  whenever recording is on — `forwardTwiml` enforces this even if no greeting is
 *  configured. Exported so the voice route shares the same copy. */
export const DEFAULT_RECORDING_NOTICE = "This call may be recorded.";

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

  // Pre-call message. When recording is on a notice is REQUIRED (mixed consent) —
  // fall back to the default so no caller path can be recorded silently. With
  // recording off the greeting stays fully optional per number in the app.
  const greeting = opts.greeting ?? (record ? DEFAULT_RECORDING_NOTICE : undefined);
  if (greeting) {
    vr.say({ voice: "Polly.Joanna" }, greeting);
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

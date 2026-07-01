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
   *  Independent of recording — plays whenever set. */
  greeting?: string;
  /** Record the call (dual-channel). Default true. */
  record?: boolean;
  timeoutSec?: number;
}

const base = () => env.TWILIO_VOICE_WEBHOOK_BASE ?? `${env.APP_BASE_URL}/api/twilio`;

/**
 * Build the inbound-call TwiML: optional recording notice → dial the destination
 * with dual-channel recording and a whisper, then voicemail on no-answer.
 *
 * IL/MO are mixed-consent states; we play a recording notice to stay safe.
 */
export function forwardTwiml(opts: ForwardOptions): string {
  const vr = new VoiceResponse();
  const record = opts.record !== false; // default on

  // Pre-call message (recording notice, greeting, etc.) — plays if set, regardless
  // of recording, so it's fully controlled per number in the app.
  if (opts.greeting) {
    vr.say({ voice: "Polly.Joanna" }, opts.greeting);
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

  // Fell through (no answer) — take a voicemail.
  vr.say(
    { voice: "Polly.Joanna" },
    "Sorry, we couldn't connect you. Please leave a message after the tone and we'll call you right back.",
  );
  vr.record({
    maxLength: 120,
    playBeep: true,
    recordingStatusCallback: `${base()}/recording?src=voicemail`,
    recordingStatusCallbackEvent: ["completed"],
  });
  vr.hangup();

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

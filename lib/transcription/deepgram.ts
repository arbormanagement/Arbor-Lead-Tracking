import { getCredential, getPlatformCreds } from "@/lib/credentials";

export interface Transcription {
  transcript: string;
  confidence: number | null;
  provider: "deepgram";
}

/**
 * Transcribe a Twilio call recording with Deepgram (Nova-2 phonecall: dual-channel,
 * accurate on noisy mobile/field calls). We fetch the recording bytes from Twilio
 * (which require account auth — kept in env) and post them to Deepgram's prerecorded
 * API. The Deepgram key comes from the in-app resolver (DB over env).
 */
export async function transcribeRecording(recordingUrl: string): Promise<Transcription> {
  const deepgramKey = await getCredential("deepgram", "api_key");
  if (!deepgramKey) throw new Error("Deepgram API key is not configured");

  // Fetch the recording bytes from Twilio with basic auth, resolving creds from the
  // in-app store (DB over env) — prefer the API key/secret, else account SID + auth
  // token. (Reading env directly broke this when Twilio was entered via the API key.)
  const tw = await getPlatformCreds("twilio");
  const user = tw.api_key_sid || tw.account_sid;
  const pass = tw.api_key_secret || tw.auth_token;
  if (!user || !pass) throw new Error("Twilio credentials required to fetch the recording");
  const basic = Buffer.from(`${user}:${pass}`).toString("base64");
  const audioRes = await fetch(recordingUrl, {
    headers: { Authorization: `Basic ${basic}` },
    signal: AbortSignal.timeout(60_000),
  });
  if (!audioRes.ok) throw new Error(`Twilio recording fetch ${audioRes.status}`);
  const audio = await audioRes.arrayBuffer();

  const dgUrl = new URL("https://api.deepgram.com/v1/listen");
  dgUrl.searchParams.set("model", "nova-2-phonecall");
  dgUrl.searchParams.set("smart_format", "true");
  dgUrl.searchParams.set("punctuate", "true");
  dgUrl.searchParams.set("diarize", "true");

  const dgRes = await fetch(dgUrl, {
    method: "POST",
    headers: { Authorization: `Token ${deepgramKey}`, "Content-Type": "audio/mpeg" },
    body: audio,
    signal: AbortSignal.timeout(120_000),
  });
  if (!dgRes.ok) throw new Error(`Deepgram ${dgRes.status}: ${await dgRes.text()}`);

  const json = (await dgRes.json()) as any;
  const alt = json?.results?.channels?.[0]?.alternatives?.[0];
  return {
    transcript: alt?.transcript ?? "",
    confidence: typeof alt?.confidence === "number" ? alt.confidence : null,
    provider: "deepgram",
  };
}

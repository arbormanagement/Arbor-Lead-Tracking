import { createHash } from "node:crypto";
import { getPlatformCreds } from "@/lib/credentials";
import { fetchWithRetry } from "./http";

/**
 * Google Data Manager API — the replacement for the Google Ads
 * ConversionUploadService, which is now closed to new integrations (every upload
 * from this app is rejected on policy, not on data).
 *
 * Two things make it a better home than the endpoint it replaces, beyond simply
 * being the supported one:
 *   · click IDs and hashed user identifiers can travel on the SAME event. The old
 *     API rejected that pairing, so a lead without a gclid — every organic call —
 *     exported nothing at all.
 *   · `transactionId` gives real server-side dedup, so a retried send cannot
 *     double-count. The old path had none, which is why the exporter needed a
 *     retry cap bolted on.
 */
const INGEST_URL = "https://datamanager.googleapis.com/v1/events:ingest";
/** Data Manager has its OWN scope. A refresh token minted for `adwords` is not
 *  automatically authorized here — the probe below is what proves it either way. */
export const DATA_MANAGER_SCOPE = "https://www.googleapis.com/auth/datamanager";

export interface DataManagerConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  customerId: string;
  loginCustomerId?: string;
  conversionActionId: string;
}

async function config(): Promise<DataManagerConfig> {
  const c = await getPlatformCreds("google_ads");
  if (!c.client_id || !c.client_secret || !c.refresh_token) {
    throw new Error("Google Ads OAuth credentials are incomplete");
  }
  if (!c.customer_id) throw new Error("Google Ads customer_id is not configured");
  const action = c.conversion_action_lead || c.conversion_action_qualified || c.conversion_action_won;
  if (!action) throw new Error("No Google Ads conversion action is configured");
  return {
    clientId: c.client_id,
    clientSecret: c.client_secret,
    refreshToken: c.refresh_token,
    customerId: c.customer_id.replace(/-/g, ""),
    loginCustomerId: c.login_customer_id ? c.login_customer_id.replace(/-/g, "") : undefined,
    // Destinations take the bare numeric conversion-action id, not the
    // `customers/…/conversionActions/…` resource name the Google Ads API uses.
    conversionActionId: action.trim().split("/").pop()!.replace(/[^0-9]/g, ""),
  };
}

/** Exchange the refresh token, requesting the Data Manager scope explicitly so a
 *  scope problem surfaces here rather than as a confusing 403 on ingest. */
async function accessToken(cfg: DataManagerConfig): Promise<{ token?: string; error?: string }> {
  const res = await fetchWithRetry(
    "https://oauth2.googleapis.com/token",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        refresh_token: cfg.refreshToken,
        grant_type: "refresh_token",
      }),
    },
    { timeoutMs: 30_000 },
  );
  const json = (await res.json()) as { access_token?: string; scope?: string; error_description?: string; error?: string };
  if (!res.ok || !json.access_token) {
    return { error: `OAuth ${res.status}: ${json.error_description ?? json.error ?? "no access_token"}` };
  }
  // The token endpoint reports the scopes actually granted. If datamanager isn't
  // among them, no amount of correct payload will work.
  if (json.scope && !json.scope.split(" ").includes(DATA_MANAGER_SCOPE)) {
    return {
      token: json.access_token,
      error: `granted scopes do not include ${DATA_MANAGER_SCOPE} — got: ${json.scope}`,
    };
  }
  return { token: json.access_token };
}

const sha256Hex = (v: string) => createHash("sha256").update(v).digest("hex");

/** Google requires email lowercased/trimmed and phone in E.164 BEFORE hashing.
 *  Hashing an unnormalized value produces a valid-looking digest that matches
 *  nobody, which is indistinguishable from "this customer never clicked an ad". */
export const hashEmailForDm = (email: string) => sha256Hex(email.trim().toLowerCase());
export const hashPhoneForDm = (e164: string) => sha256Hex(e164.trim());

function destinationsFor(cfg: DataManagerConfig, conversionActionId: string) {
  return [
    {
      operatingAccount: { accountType: "GOOGLE_ADS", accountId: cfg.customerId },
      ...(cfg.loginCustomerId
        ? { loginAccount: { accountType: "GOOGLE_ADS", accountId: cfg.loginCustomerId } }
        : {}),
      productDestinationId: conversionActionId,
    },
  ];
}

/**
 * Legal `EventSource` values, established by sweeping the enum against the live
 * API (2026-08-10) because the rejection message names the bad value but never
 * lists the good ones. `OFFLINE`, `CRM` and `PHONE_CALL` all read as plausible
 * and are all rejected; `PHONE` is the one that covers a tracked call, which is
 * this business's highest-volume lead type.
 */
export type EventSource = "WEB" | "APP" | "IN_STORE" | "PHONE" | "OTHER";

export interface IngestEvent {
  /** Stable per (lead, stage). Data Manager dedups on it server-side, which is
   *  what makes a retry safe — see the note on `retries` in `ingestEvents`. */
  transactionId: string;
  /** Bare numeric conversion-action id — the destination this event belongs to. */
  conversionActionId: string;
  eventTimestamp: Date;
  valueDollars: number;
  eventSource: EventSource;
  gclid?: string | null;
  gbraid?: string | null;
  wbraid?: string | null;
  /** Hashed and sent alongside the click id when present. Google matches on the
   *  click id first; the identifiers only widen the match. */
  emailLc?: string | null;
  phoneE164?: string | null;
}

export interface IngestResult {
  ok: boolean;
  error?: string;
  raw?: unknown;
}

/** One event as Data Manager wants it. Shape verified field-by-field by
 *  `probeDataManagerShapes` — notably `adIdentifiers.gclid` rather than a flat
 *  `gclid`, which is "Cannot find field". */
function buildEvent(e: IngestEvent) {
  const userIdentifiers: Array<Record<string, string>> = [];
  if (e.emailLc) userIdentifiers.push({ emailAddress: hashEmailForDm(e.emailLc) });
  if (e.phoneE164) userIdentifiers.push({ phoneNumber: hashPhoneForDm(e.phoneE164) });

  const adIdentifiers: Record<string, string> = {};
  // Exactly one click id, in the same preference order the exporter resolves them.
  if (e.gclid) adIdentifiers.gclid = e.gclid;
  else if (e.gbraid) adIdentifiers.gbraid = e.gbraid;
  else if (e.wbraid) adIdentifiers.wbraid = e.wbraid;

  return {
    transactionId: e.transactionId,
    eventTimestamp: e.eventTimestamp.toISOString(),
    conversionValue: e.valueDollars,
    currency: "USD",
    eventSource: e.eventSource,
    ...(Object.keys(adIdentifiers).length ? { adIdentifiers } : {}),
    ...(userIdentifiers.length ? { userData: { userIdentifiers } } : {}),
  };
}

/**
 * Send conversions. Returns a result per `transactionId` so the caller can mark
 * each export row individually.
 *
 * One request per destination: `destinations` applies to every event in the body,
 * so events bound for different conversion actions cannot share a request.
 *
 * Two honest limits worth knowing before reading the return value:
 *   · a 200 means ACCEPTED FOR PROCESSING, not attributed. Matching happens
 *     asynchronously on Google's side, so `ok: true` says the payload was valid
 *     and the destination exists — it does not promise the conversion will show
 *     up in the account. Only the Google Ads UI can confirm that.
 *   · results are therefore per-BATCH, not per-event. Every event in a failed
 *     request is marked failed together, which is why batches are kept small
 *     enough that one bad row doesn't drag many good ones down with it.
 */
export async function ingestEvents(events: IngestEvent[]): Promise<Map<string, IngestResult>> {
  const out = new Map<string, IngestResult>();
  if (!events.length) return out;

  const cfg = await config();
  const auth = await accessToken(cfg);
  if (!auth.token) {
    for (const e of events) out.set(e.transactionId, { ok: false, error: auth.error ?? "no access token" });
    return out;
  }

  const byDestination = new Map<string, IngestEvent[]>();
  for (const e of events) {
    const list = byDestination.get(e.conversionActionId);
    if (list) list.push(e);
    else byDestination.set(e.conversionActionId, [e]);
  }

  const BATCH = 200;
  for (const [conversionActionId, list] of byDestination) {
    for (let i = 0; i < list.length; i += BATCH) {
      const chunk = list.slice(i, i + BATCH);
      const body = {
        destinations: destinationsFor(cfg, conversionActionId),
        events: chunk.map(buildEvent),
        encoding: "HEX",
      };
      try {
        const res = await fetchWithRetry(
          INGEST_URL,
          {
            method: "POST",
            headers: { Authorization: `Bearer ${auth.token}`, "Content-Type": "application/json" },
            body: JSON.stringify(body),
          },
          // Retries are SAFE here, unlike on the old upload endpoint. That one had
          // no dedup, so a 5xx returned after Google had already recorded the
          // conversion turned into a duplicate (or a CONVERSION_ALREADY_EXISTS
          // error stored as a failure) on retry. `transactionId` removes the
          // hazard: a replayed event is discarded server-side.
          { retries: 2, timeoutMs: 30_000 },
        );
        const text = await res.text();
        let raw: unknown = text;
        try {
          raw = JSON.parse(text);
        } catch {
          /* keep the text — a non-JSON body is itself the diagnostic */
        }
        const result: IngestResult = res.ok
          ? { ok: true, raw }
          : { ok: false, error: `Data Manager ${res.status}: ${text.replace(/\s+/g, " ").slice(0, 300)}`, raw };
        for (const e of chunk) out.set(e.transactionId, result);
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        for (const e of chunk) out.set(e.transactionId, { ok: false, error });
      }
    }
  }
  return out;
}

/**
 * Probe the SHAPE of the payload the exporter intends to send, not just whether
 * auth works.
 *
 * The age probe proved the account accepts a minimal event. It says nothing about
 * the fields the real exporter has to carry — where a gclid lives, what
 * `eventSource` values are legal, whether a click id and hashed user identifiers
 * may travel together. Those are exactly the parts I would otherwise be guessing
 * from prose docs, and a wrong guess ships as a silently rejected upload.
 *
 * `validateOnly: true` makes Google's own parser the authority: unknown fields
 * come back as INVALID_ARGUMENT, bad enums name the field. Nothing is recorded.
 */
export async function probeDataManagerShapes() {
  const cfg = await config();
  const auth = await accessToken(cfg);
  if (!auth.token) return { ok: false, stage: "oauth", error: auth.error };

  const when = new Date(Date.now() - 86_400_000).toISOString();
  const gclid = "TeStGcLiD_probe_only_0000000000";
  const ids = { userIdentifiers: [{ emailAddress: hashEmailForDm("probe@example.invalid") }] };

  // Each candidate is one hypothesis about the schema. Named so the result reads
  // as an answer ("adIdentifiers.gclid works, flat gclid does not") rather than a
  // pile of HTTP codes.
  const candidates: Array<{ name: string; event: Record<string, unknown> }> = [
    { name: "adIdentifiers.gclid", event: { adIdentifiers: { gclid } } },
    { name: "adIdentifiers.gclid + userData", event: { adIdentifiers: { gclid }, userData: ids } },
    { name: "flat gclid", event: { gclid } },
    { name: "adIdentifiers.gbraid", event: { adIdentifiers: { gbraid: gclid } } },
    { name: "adIdentifiers.wbraid", event: { adIdentifiers: { wbraid: gclid } } },
    { name: "userData only", event: { userData: ids } },
    { name: "no eventSource", event: { userData: ids } },
    // EventSource enum sweep. PHONE_CALL was rejected by name, and the error does
    // not enumerate the legal values, so the only way to learn them is to ask.
    // Calls are the highest-volume lead type here, so which value represents an
    // offline/phone conversion is not a cosmetic detail.
    ...["WEB", "APP", "IN_STORE", "PHONE", "OFFLINE", "CRM", "OTHER", "UNSPECIFIED", "EVENT_SOURCE_UNSPECIFIED"].map(
      (v) => ({ name: `eventSource=${v}`, event: { userData: ids, eventSource: v } }),
    ),
    // The first real run failed on exactly two events, both of stage `scheduled`,
    // whose timestamp is the estimate's APPOINTMENT time — routinely in the
    // future. A conversion that has not happened yet is a contradiction, so the
    // hypothesis is that Google rejects a future eventTimestamp. Testing it
    // beats assuming it: the returned error is the generic "There was a problem
    // with the request", which names no field.
    {
      name: "eventTimestamp +7d (future)",
      event: { userData: ids, eventTimestamp: new Date(Date.now() + 7 * 86_400_000).toISOString() },
    },
    {
      name: "eventTimestamp +1h (future)",
      event: { userData: ids, eventTimestamp: new Date(Date.now() + 3_600_000).toISOString() },
    },
  ];

  const results: Array<Record<string, unknown>> = [];
  for (const [i, c] of candidates.entries()) {
    const body = {
      destinations: destinationsFor(cfg, cfg.conversionActionId),
      events: [
        {
          transactionId: `shape-probe-${i}`,
          eventTimestamp: when,
          conversionValue: 12.34,
          currency: "USD",
          eventSource: "WEB",
          ...c.event,
        },
      ],
      encoding: "HEX",
      validateOnly: true,
    };
    const res = await fetchWithRetry(
      INGEST_URL,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${auth.token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      { retries: 0, timeoutMs: 30_000 },
    );
    const text = await res.text();
    results.push({
      candidate: c.name,
      httpStatus: res.status,
      accepted: res.ok,
      // Only the failures need detail; a 200 carries nothing but a requestId.
      response: res.ok ? "ok" : text.replace(/\s+/g, " ").slice(0, 300),
    });
  }

  return {
    ok: results.some((r) => r.accepted),
    accepted: results.filter((r) => r.accepted).map((r) => r.candidate),
    rejected: results.filter((r) => !r.accepted).map((r) => r.candidate),
    results,
  };
}

/**
 * Validate-only ingest at several event ages, to find the real upper bound on how
 * old a conversion may be. Nothing is recorded: `validateOnly` makes Google check
 * the request and discard it.
 */
export async function probeDataManager() {
  const cfg = await config();
  const auth = await accessToken(cfg);
  if (!auth.token) return { ok: false, stage: "oauth", error: auth.error };

  const destinations = destinationsFor(cfg, cfg.conversionActionId);

  // Ages spanning the window the exporter actually needs. 90 days is the current
  // export window (it matches Google's click lookback); 3 days probes the 72-hour
  // figure the docs mention.
  const ages = [0, 3, 30, 89];
  const results: Array<Record<string, unknown>> = [];

  for (const days of ages) {
    const when = new Date(Date.now() - days * 86_400_000);
    const body = {
      destinations,
      events: [
        {
          // Synthetic and clearly marked. validateOnly means it is never stored,
          // and the identifiers below match nobody.
          transactionId: `probe-${days}d-${when.getTime()}`,
          eventTimestamp: when.toISOString(),
          conversionValue: 1,
          currency: "USD",
          eventSource: "WEB",
          userData: {
            userIdentifiers: [{ emailAddress: sha256Hex("probe@example.invalid") }],
          },
        },
      ],
      encoding: "HEX",
      validateOnly: true,
    };

    const res = await fetchWithRetry(
      INGEST_URL,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${auth.token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      { retries: 0, timeoutMs: 30_000 },
    );
    const text = await res.text();
    results.push({
      eventAgeDays: days,
      httpStatus: res.status,
      accepted: res.ok,
      response: text.slice(0, 600),
    });
    if (res.status === 401 || res.status === 403) break; // auth problem — later ages tell us nothing
  }

  const accepted = results.filter((r) => r.accepted).map((r) => r.eventAgeDays as number);
  return {
    ok: accepted.length > 0,
    scopeWarning: auth.error ?? null,
    customerId: cfg.customerId,
    conversionActionId: cfg.conversionActionId,
    acceptedEventAgesDays: accepted,
    maxAcceptedAgeDays: accepted.length ? Math.max(...accepted) : null,
    // The design question: if only very recent events validate, an estimate
    // approved weeks after its lead can never be exported and the whole approach
    // needs rethinking rather than porting.
    verdict: accepted.includes(89)
      ? "90-day window is usable — port the exporter as-is"
      : accepted.length
        ? "Only recent events validate — the 90-day export window will NOT work unchanged"
        : "Nothing validated — see responses (scope or destination config)",
    results,
  };
}

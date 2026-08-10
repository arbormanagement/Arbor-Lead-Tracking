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

/**
 * Validate-only ingest at several event ages, to find the real upper bound on how
 * old a conversion may be. Nothing is recorded: `validateOnly` makes Google check
 * the request and discard it.
 */
export async function probeDataManager() {
  const cfg = await config();
  const auth = await accessToken(cfg);
  if (!auth.token) return { ok: false, stage: "oauth", error: auth.error };

  const destinations = [
    {
      operatingAccount: { accountType: "GOOGLE_ADS", accountId: cfg.customerId },
      ...(cfg.loginCustomerId
        ? { loginAccount: { accountType: "GOOGLE_ADS", accountId: cfg.loginCustomerId } }
        : {}),
      productDestinationId: cfg.conversionActionId,
    },
  ];

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

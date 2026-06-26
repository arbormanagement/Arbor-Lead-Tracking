import { getPlatformCreds } from "@/lib/credentials";
import { googleAds } from "./google-ads";
import { facebook } from "./facebook";
import { housecallpro } from "./housecallpro";
import type { RevenueProvider, SpendProvider } from "./types";

export * from "./types";
export { googleAds, facebook, housecallpro };

/**
 * Active spend providers — only those with credentials configured (DB or env) run,
 * so the sync degrades gracefully before every platform is wired up.
 */
export async function activeSpendProviders(): Promise<SpendProvider[]> {
  const providers: SpendProvider[] = [];
  const google = await getPlatformCreds("google_ads");
  if (google.refresh_token && google.developer_token) providers.push(googleAds);
  const fb = await getPlatformCreds("facebook");
  if (fb.access_token) providers.push(facebook);
  return providers;
}

export async function revenueProvider(): Promise<RevenueProvider | null> {
  const c = await getPlatformCreds("housecallpro");
  return c.api_key ? housecallpro : null;
}

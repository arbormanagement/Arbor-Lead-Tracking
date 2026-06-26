import { env } from "@/lib/env";
import { googleAds } from "./google-ads";
import { facebook } from "./facebook";
import { housecallpro } from "./housecallpro";
import type { RevenueProvider, SpendProvider } from "./types";

export * from "./types";
export { googleAds, facebook, housecallpro };

/**
 * Active spend providers — only those with credentials configured run, so the
 * sync degrades gracefully before every platform is wired up.
 */
export function activeSpendProviders(): SpendProvider[] {
  const providers: SpendProvider[] = [];
  if (env.GOOGLE_ADS_REFRESH_TOKEN && env.GOOGLE_ADS_DEVELOPER_TOKEN) providers.push(googleAds);
  if (env.FACEBOOK_ACCESS_TOKEN) providers.push(facebook);
  return providers;
}

export function revenueProvider(): RevenueProvider | null {
  return env.HCP_API_KEY ? housecallpro : null;
}

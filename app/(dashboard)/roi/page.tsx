import { redirect } from "next/navigation";

/**
 * Campaigns folded into /sources as a view (2026-08-15) — channel, campaign and
 * landing page are one question at three grains, not three nav items.
 *
 * The timeframe is carried across rather than dropped: this URL is bookmarked and
 * linked from elsewhere in the app, and silently resetting a 90-day view to 30 days
 * is the kind of thing that gets read as a data change.
 */
export default async function RoiRedirect({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>;
}) {
  const { days } = await searchParams;
  redirect(`/sources?view=campaign${days ? `&days=${encodeURIComponent(days)}` : ""}`);
}

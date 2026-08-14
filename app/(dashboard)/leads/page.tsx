import { redirect } from "next/navigation";

/**
 * The Leads list became /estimates.
 *
 * It listed `leads` rows passing `isQualifiedLead` and called them "confirmed
 * estimate requests" — but that could only ever show opportunities arriving
 * through a tracked contact, and roughly 41% of estimate customers have no lead on
 * any channel. Those opportunities were absent rather than merely unattributed.
 * Counting estimates instead makes them visible and puts this page on the same
 * unit as roi_daily.
 *
 * Kept as a redirect because /leads is in bookmarks and in links from earlier
 * notes. /leads/[id] is unchanged — an individual contact still has a detail page,
 * and estimate rows link to it.
 */
export default function LeadsRedirect() {
  redirect("/estimates");
}

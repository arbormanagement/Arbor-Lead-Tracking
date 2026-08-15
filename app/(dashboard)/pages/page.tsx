import { redirect } from "next/navigation";

/** Landing pages folded into /sources as a view (2026-08-15). Timeframe preserved —
 *  see the note in ../roi/page.tsx. */
export default async function PagesRedirect({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>;
}) {
  const { days } = await searchParams;
  redirect(`/sources?view=page${days ? `&days=${encodeURIComponent(days)}` : ""}`);
}

import { TRACKING_STARTED_LABEL, uncoveredDays } from "@/lib/tracking-coverage";

/**
 * Warns when the selected window reaches back before call and web tracking existed.
 *
 * Shown on any surface that divides spend by outcomes. The numbers on those pages
 * are not wrong so much as incomparable: spend covers the whole window, attributed
 * contacts only cover the part after the cutover, so ROAS and cost-per-estimate are
 * overstated for every paid channel — and unequally, since Facebook carries its own
 * API history while calls and forms do not.
 *
 * Deliberately not a silent clamp of the window. Quietly shortening what the user
 * asked for would make the figure correct and the page dishonest about which period
 * it describes; this says what is missing and lets them choose.
 */
export function CoverageNotice({ days }: { days: number }) {
  const missing = uncoveredDays(days);
  if (missing <= 0) return null;
  return (
    <div
      className="empty"
      style={{
        marginBottom: 16,
        padding: "10px 14px",
        textAlign: "left",
        fontSize: 12.5,
        borderColor: "var(--accent-line)",
        background: "var(--accent-soft)",
      }}
    >
      <strong>This window starts before tracking did.</strong> Call and web tracking began {TRACKING_STARTED_LABEL}{" "}
      (the CallRail cutover), so roughly {missing} {missing === 1 ? "day" : "days"} of this window has spend but no
      attributable contacts. Cost per estimate and ROAS are overstated for every paid channel, and unevenly — Meta lead
      forms carry their own history from the Graph API while calls, forms, Google Business Profile and Local Services do
      not. Shorter windows are comparable; longer ones are not, until the CallRail history is imported.
    </div>
  );
}

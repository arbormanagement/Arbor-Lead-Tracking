/** Groupable dimensions for the Inbox — shared by the page (server) and the
 *  view controls (client). Selected groupings travel as `?g=a,b` (ordered). */
export type Dim = "source" | "campaign" | "stage" | "type" | "location" | "day" | "week" | "month";

export const DIMS: Array<{ key: Dim; label: string }> = [
  { key: "source", label: "Source" },
  { key: "campaign", label: "Campaign" },
  { key: "stage", label: "Stage" },
  { key: "type", label: "Type" },
  { key: "location", label: "Location" },
  { key: "day", label: "Day" },
  { key: "week", label: "Week" },
  { key: "month", label: "Month" },
];

export const MAX_GROUPS = 3;

export function isDim(v: string): v is Dim {
  return DIMS.some((d) => d.key === v);
}

/** Parse `?g=` into an ordered, deduped list of valid dims (capped). */
export function parseGroups(param: string | undefined): Dim[] {
  return [...new Set((param ?? "").split(",").filter(isDim))].slice(0, MAX_GROUPS);
}

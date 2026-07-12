/** Groupable dimensions for the Inbox — shared by the page (server) and the
 *  view controls (client). */
export type Dim = "source" | "stage" | "type" | "location" | "week";

export const DIMS: Array<{ key: Dim; label: string }> = [
  { key: "source", label: "Source" },
  { key: "stage", label: "Stage" },
  { key: "type", label: "Type" },
  { key: "location", label: "Location" },
  { key: "week", label: "Week" },
];

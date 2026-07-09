// Shared lead-stage → badge styling (inbox table + lead detail).
export function stageClass(status: string): string {
  if (status === "won") return "badge win";
  if (status === "quoted") return "badge info";
  if (status === "qualified") return "badge warn";
  if (status === "spam" || status === "lost") return "badge bad";
  if (status === "cancelled") return "badge muted-strike"; // neutral, distinct from lost
  return "badge";
}

export const TYPE_META: Record<string, { ic: string; label: string }> = {
  call: { ic: "☎", label: "Call" },
  web_form: { ic: "✉", label: "Form" },
  facebook_leadgen: { ic: "ⓕ", label: "Facebook" },
  lsa: { ic: "◎", label: "LSA" },
  manual: { ic: "✎", label: "Manual" },
};

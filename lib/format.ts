export function dollars(cents: number | null | undefined): string {
  const c = cents ?? 0;
  return (c / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
}

export function dateTime(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    // Business wall-clock time. Without this the server container renders UTC —
    // a 2:10pm Central call showed as 7:10pm.
    timeZone: "America/Chicago",
  });
}

export function durationLabel(sec: number | null | undefined): string {
  if (!sec || sec <= 0) return "—";
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

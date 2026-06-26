/**
 * Phone normalization to E.164. Lead↔HCP matching silently undercounts ROI if
 * numbers aren't normalized consistently, so every phone that enters the system
 * (Twilio `From`, HCP customer phone, form field) passes through here.
 *
 * Scope is US/NANP — Arbor operates in Metro East IL. We intentionally avoid a
 * heavy dependency (libphonenumber) for this; the rules below cover real inputs.
 */
export function normalizePhone(input: string | null | undefined): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (!trimmed) return null;

  // Already E.164-ish — keep if it's a plausible +1 number.
  if (trimmed.startsWith("+")) {
    const digits = trimmed.replace(/[^\d]/g, "");
    if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
    if (digits.length === 10) return `+1${digits}`;
    // Non-NANP international — return as-is if it has enough digits.
    return digits.length >= 8 ? `+${digits}` : null;
  }

  const digits = trimmed.replace(/[^\d]/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

/** Pretty US display: +16188368004 → (618) 836-8004 */
export function formatPhoneDisplay(e164: string | null | undefined): string {
  if (!e164) return "";
  const d = e164.replace(/[^\d]/g, "");
  const ten = d.length === 11 && d.startsWith("1") ? d.slice(1) : d;
  if (ten.length !== 10) return e164;
  return `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}`;
}

export function normalizeEmail(input: string | null | undefined): string | null {
  if (!input) return null;
  const e = input.trim().toLowerCase();
  return e.includes("@") ? e : null;
}

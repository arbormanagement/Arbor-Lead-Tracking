/**
 * Channel vocabulary and presentation — deliberately free of any DB import so
 * client components can use it. `lib/messaging/thread.ts` pulls in the Postgres
 * driver; importing these constants from there dragged node-postgres into the
 * browser bundle and broke the build.
 */

/** Every way someone can reach us. Adding one is an enum value + an ingest call. */
export type ThreadChannel = "call" | "sms" | "email" | "form" | "facebook";

export const CHANNEL_META: Record<ThreadChannel, { ic: string; label: string }> = {
  call: { ic: "☎", label: "Call" },
  sms: { ic: "💬", label: "Text" },
  email: { ic: "✉", label: "Email" },
  form: { ic: "▤", label: "Form" },
  facebook: { ic: "ⓕ", label: "Facebook" },
};

/** Longest snippet worth keeping for an inbox row preview. */
const PREVIEW_CHARS = 140;

/** Collapse whitespace and clip — inbox previews are one line, never a paragraph. */
export function preview(text: string | null | undefined): string | null {
  if (!text) return null;
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return null;
  return flat.length > PREVIEW_CHARS ? flat.slice(0, PREVIEW_CHARS - 1) + "…" : flat;
}

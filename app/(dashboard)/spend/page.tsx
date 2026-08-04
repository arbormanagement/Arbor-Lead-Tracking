import { redirect } from "next/navigation";

/** Data & sync moved under Settings (nav reorg) — keep the old URL working. */
export default function SpendRedirect() {
  redirect("/settings/sync");
}

import { redirect } from "next/navigation";

/** Numbers moved under Settings (nav reorg) — keep the old URL working. */
export default function NumbersRedirect() {
  redirect("/settings/numbers");
}

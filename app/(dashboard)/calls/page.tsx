import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/**
 * The call log became the Inbox's "Calls" channel — same rows, same recordings and
 * lead triage, now alongside texts. Kept as a redirect because /calls is in
 * bookmarks and in links from earlier notes.
 */
export default function CallsPage() {
  redirect("/inbox?channel=call");
}

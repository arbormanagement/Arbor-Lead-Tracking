import { redirect } from "next/navigation";

/** The enquiry detail page is /inquiries/[id] since 2026-09-05; this keeps bookmarks and
 *  older estimate links working. Retire with the other legacy names after 2026-10-05. */
export default async function LeadRedirect({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/inquiries/${encodeURIComponent(id)}`);
}

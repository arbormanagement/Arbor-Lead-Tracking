/**
 * Display name for a contact.
 *
 * The HousecallPro name wins when there is one: that's the record Justin curates,
 * where a web form's "Sarah W" is just whatever the customer typed that day. This
 * app stores no customer details of its own — it links to HCP and reads through
 * the link, so a correction made there shows up here with no sync of names.
 */
export function contactName(t: {
  name: string | null;
  hcpFirst: string | null;
  hcpLast: string | null;
}): string | null {
  const hcp = [t.hcpFirst, t.hcpLast].filter(Boolean).join(" ").trim();
  return hcp || t.name || null;
}

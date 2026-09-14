/**
 * RFC 822 message assembly for the Gmail transport.
 *
 * ⚠️ THIS IS WHERE THE GMAIL TRANSPORT IS RISKIER THAN SENDGRID, AND THE REASON
 * EVERY HEADER GOES THROUGH `sanitizeHeaderValue`. SendGrid took a JSON body and
 * built the message itself, so a newline in a subject was just a newline. Gmail
 * takes the RAW message, so a CR or LF in a header value ENDS THAT HEADER and
 * everything after it is parsed as the next one — the classic header-injection
 * hole (a forged `Bcc:`, a replaced body).
 *
 * That is reachable, not theoretical: `app/api/webhook/call_summary` builds its
 * subject as `Call from ${fromNumber}`, and `fromNumber` comes straight off the
 * Retell webhook payload. Anyone who can post to that endpoint — or spoof a
 * caller id into it — writes part of a Subject header.
 */

/** Strip anything that could terminate a header. Folding whitespace goes too. */
export function sanitizeHeaderValue(value: string): string {
  return String(value).replace(/[\r\n\t]+/g, " ").trim();
}

function isPrintableAscii(s: string): boolean {
  return /^[\x20-\x7E]*$/.test(s);
}

/** RFC 2047 encoded-word, so a non-ASCII subject survives an 8-bit-unclean hop. */
function encodedWord(s: string): string {
  return `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`;
}

/** Header value: sanitized, and encoded only when it is not plain ASCII. */
export function encodeHeaderValue(value: string): string {
  const clean = sanitizeHeaderValue(value);
  return isPrintableAscii(clean) ? clean : encodedWord(clean);
}

/**
 * `Name <addr>` when a display name is given, bare address otherwise. Quotes in a
 * display name are dropped rather than escaped — a name is cosmetic and a broken
 * quote run would corrupt the whole header.
 */
export function formatAddress(email: string, name?: string): string {
  const address = sanitizeHeaderValue(email);
  const display = name ? sanitizeHeaderValue(name) : "";
  if (!display) return address;
  const rendered = isPrintableAscii(display)
    ? `"${display.replace(/["\\]/g, "")}"`
    : encodedWord(display);
  return `${rendered} <${address}>`;
}

export interface MimeOptions {
  from: string;
  fromName?: string;
  to: string;
  subject: string;
  html: string;
  replyTo?: string;
}

/**
 * The body is base64 with CRLF every 76 characters: an HTML mail is long,
 * frequently non-ASCII (a customer's name, a smart quote in a transcript), and
 * RFC 5322 caps a line at 998 octets. Base64 sidesteps both.
 */
export function buildMimeMessage(opts: MimeOptions): string {
  const headers = [
    `From: ${formatAddress(opts.from, opts.fromName)}`,
    `To: ${sanitizeHeaderValue(opts.to)}`,
    `Subject: ${encodeHeaderValue(opts.subject)}`,
  ];
  if (opts.replyTo) headers.push(`Reply-To: ${sanitizeHeaderValue(opts.replyTo)}`);
  headers.push("MIME-Version: 1.0", 'Content-Type: text/html; charset="UTF-8"', "Content-Transfer-Encoding: base64");

  const base64 = Buffer.from(opts.html, "utf8").toString("base64");
  const body = base64.match(/.{1,76}/g)?.join("\r\n") ?? "";

  return `${headers.join("\r\n")}\r\n\r\n${body}`;
}

/** Gmail's `raw` field is base64url of the whole message. */
export function toBase64Url(message: string): string {
  return Buffer.from(message, "utf8").toString("base64url");
}

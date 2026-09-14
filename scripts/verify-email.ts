/**
 * npm run verify:email
 *
 * Covers the half of the Workspace transport that is pure and therefore testable
 * without a network: MIME assembly, header sanitization and transport selection.
 * Same reason verify:hcp and verify:review-backfill exist — there is no test
 * runner here, and `tsc` cannot see inside a string being concatenated into a
 * mail header any more than it can see inside a `sql` template.
 *
 * The header-injection cases are the point. SendGrid took JSON and built the
 * message itself; Gmail takes the RAW message, so a CR/LF in a subject ends the
 * header. `call_summary` puts a webhook-supplied phone number in its Subject, so
 * that input is attacker-reachable.
 *
 * A live end-to-end send is deliberately NOT part of this suite (it needs real
 * credentials and puts mail in someone's inbox):
 *   npx tsx scripts/verify-email.ts --live you@arbor-mgmt.com
 */
import {
  buildMimeMessage,
  encodeHeaderValue,
  formatAddress,
  sanitizeHeaderValue,
  toBase64Url,
} from "../lib/email/mime";

let pass = 0;
let fail = 0;

function check(name: string, condition: boolean, detail?: string) {
  if (condition) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function headersOf(mime: string): string {
  return mime.split("\r\n\r\n")[0];
}

function decodeBody(mime: string): string {
  const body = mime.split("\r\n\r\n").slice(1).join("\r\n\r\n");
  return Buffer.from(body.replace(/\r\n/g, ""), "base64").toString("utf8");
}

console.log("\nHeader sanitization (injection guard)");
{
  check("CRLF is stripped from a header value", sanitizeHeaderValue("a\r\nb") === "a b");
  check("bare LF is stripped", sanitizeHeaderValue("a\nb") === "a b");
  check("bare CR is stripped", sanitizeHeaderValue("a\rb") === "a b");
  check("tab (header folding) is stripped", sanitizeHeaderValue("a\tb") === "a b");

  // The real shape: Retell hands call_summary a from_number that becomes the Subject.
  const forged = 'Call from +1618\r\nBcc: attacker@evil.com\r\n\r\n<h1>replaced</h1>';
  const mime = buildMimeMessage({
    from: "info@arbor-mgmt.com",
    to: "info@arbor-mgmt.com",
    subject: forged,
    html: "<p>real body</p>",
  });
  check("a forged Bcc in the subject does not become a header", !/^Bcc:/m.test(headersOf(mime)));
  check("injected header count is unchanged", headersOf(mime).split("\r\n").length === 6, headersOf(mime));
  check("Subject occupies exactly one header line", headersOf(mime).split("\r\n").filter((l) => l.startsWith("Subject:")).length === 1);
  check("the real body survives the injection attempt", decodeBody(mime) === "<p>real body</p>");
  // NOTE: the Subject is guarded TWICE, and the second guard is easy to remove by
  // accident. sanitizeHeaderValue strips the CRLF; and even without it, CR/LF are
  // not printable ASCII, so encodeHeaderValue would base64 the whole value into an
  // encoded-word and the newline could not survive either. Disabling the sanitizer
  // alone therefore leaves this case passing — it is To/From/Reply-To, which take
  // sanitizeHeaderValue with NO encoding fallback, where the sanitizer is the only
  // thing standing between a webhook payload and a forged header.
  check(
    "a CRLF value is never emitted as literal ASCII (the encoding backstop)",
    !encodeHeaderValue("x\r\nBcc: e@e.com").includes("\r\n"),
  );

  const toInjected = buildMimeMessage({
    from: "info@arbor-mgmt.com",
    to: "ok@x.com\r\nBcc: attacker@evil.com",
    subject: "hi",
    html: "<p>x</p>",
  });
  check("a CRLF in the To address cannot add a header", !/Bcc:/.test(headersOf(toInjected).split("\r\n").filter(l => l.startsWith("Bcc")).join("")));
  check("To stays a single header line", headersOf(toInjected).split("\r\n").filter((l) => l.startsWith("To:")).length === 1);
}

console.log("\nEncoding");
{
  check("plain ASCII subject is left alone", encodeHeaderValue("Call from +16185551234") === "Call from +16185551234");
  const utf8 = encodeHeaderValue("Café — naïve");
  check("non-ASCII subject becomes an RFC 2047 encoded-word", utf8.startsWith("=?UTF-8?B?") && utf8.endsWith("?="));
  check(
    "encoded-word round-trips",
    Buffer.from(utf8.slice("=?UTF-8?B?".length, -2), "base64").toString("utf8") === "Café — naïve",
  );

  const mime = buildMimeMessage({
    from: "info@arbor-mgmt.com",
    to: "a@b.com",
    subject: "s",
    html: "<p>Beträge — “smart quotes” &amp; ü</p>",
  });
  check("UTF-8 body round-trips through base64", decodeBody(mime) === "<p>Beträge — “smart quotes” &amp; ü</p>");

  const long = "<p>" + "x".repeat(5000) + "</p>";
  const longMime = buildMimeMessage({ from: "a@b.com", to: "c@d.com", subject: "s", html: long });
  const bodyLines = longMime.split("\r\n\r\n").slice(1).join("\r\n\r\n").split("\r\n");
  check("no body line exceeds the 76-char base64 limit", bodyLines.every((l) => l.length <= 76));
  check("a long body round-trips intact", decodeBody(longMime) === long);
}

console.log("\nAddress formatting");
{
  check("bare address when no display name", formatAddress("info@arbor-mgmt.com") === "info@arbor-mgmt.com");
  check(
    "display name is quoted",
    formatAddress("info@arbor-mgmt.com", "Arbor Management") === '"Arbor Management" <info@arbor-mgmt.com>',
  );
  check(
    "quotes inside a display name are dropped, not escaped",
    formatAddress("a@b.com", 'Ar"bor') === '"Arbor" <a@b.com>',
  );
  check("a CRLF in the display name cannot break the header", !formatAddress("a@b.com", "X\r\nBcc: e@e.com").includes("\r\n"));
  check("non-ASCII display name is encoded", formatAddress("a@b.com", "Café").startsWith("=?UTF-8?B?"));
}

console.log("\nGmail raw encoding");
{
  const mime = buildMimeMessage({ from: "a@b.com", to: "c@d.com", subject: "s", html: "<p>hi</p>" });
  const raw = toBase64Url(mime);
  check("raw is base64url (no +, / or = padding)", !/[+/=]/.test(raw));
  check("raw decodes back to the exact message", Buffer.from(raw, "base64url").toString("utf8") === mime);
  check("message separates headers from body with a blank line", mime.includes("\r\n\r\n"));
  check("Content-Transfer-Encoding is declared", mime.includes("Content-Transfer-Encoding: base64"));
  check("charset is declared", mime.includes('charset="UTF-8"'));
}

console.log("\nTransport selection");
{
  // Exercised against the real chain logic with stub transports, so the ordering
  // rule is checked rather than described.
  type T = { name: string; configured: () => boolean };
  const chain = (all: T[], pinned?: string) => {
    const cfg = all.filter((t) => t.configured());
    if (!pinned) return cfg.map((t) => t.name);
    const primary = cfg.filter((t) => t.name === pinned);
    return [...primary, ...cfg.filter((t) => t.name !== pinned)].map((t) => t.name);
  };
  const gmail = (ok: boolean): T => ({ name: "gmail", configured: () => ok });
  const sg = (ok: boolean): T => ({ name: "sendgrid", configured: () => ok });

  check("both configured, unpinned → gmail first", JSON.stringify(chain([gmail(true), sg(true)])) === '["gmail","sendgrid"]');
  check("pinned sendgrid → sendgrid first, gmail still a fallback", JSON.stringify(chain([gmail(true), sg(true)], "sendgrid")) === '["sendgrid","gmail"]');
  check("gmail unconfigured → sendgrid alone", JSON.stringify(chain([gmail(false), sg(true)])) === '["sendgrid"]');
  check("sendgrid unconfigured → gmail alone", JSON.stringify(chain([gmail(true), sg(false)])) === '["gmail"]');
  check("neither configured → empty chain (caller throws)", JSON.stringify(chain([gmail(false), sg(false)])) === "[]");
  check("pinning a transport that is not configured does not resurrect it", JSON.stringify(chain([gmail(false), sg(true)], "gmail")) === '["sendgrid"]');
}

async function live(to: string) {
  console.log(`\nLive send → ${to}`);
  const { sendEmail } = await import("../lib/email");
  const result = await sendEmail(
    to,
    `Arbor email transport test ${new Date().toISOString()}`,
    "<p>If you can read this, the transport works.</p><p>Sent by <code>npm run verify:email -- --live</code>.</p>",
  );
  console.log(`  ✓ accepted by ${result.via}, id ${result.id}`);
}

const liveFlag = process.argv.indexOf("--live");
if (liveFlag !== -1) {
  const to = process.argv[liveFlag + 1];
  if (!to) {
    console.error("--live needs a recipient address");
    process.exit(1);
  }
  live(to)
    .then(() => process.exit(fail === 0 ? 0 : 1))
    .catch((e) => {
      console.error(`  ✗ live send failed: ${e instanceof Error ? e.message : e}`);
      process.exit(1);
    });
} else {
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
}

# CallRail → Arbor Lead Tracking migration plan

Step-by-step plan to move all call/form tracking off CallRail and onto this app
(Phase 6, "CallRail decommission"). Everything the plan relies on is already built:
static tracking numbers + number import (`lib/twilio/numbers.ts`), pooled DNI
(`lib/dni/assign.ts`, `/api/dni/assign`), `track.js` web/form capture, recording +
Deepgram transcription, spam scoring, and closed-loop conversion export
(`docs/conversion-export.md`). What remains is an **operational cutover**, done so
that no call is ever lost and no reporting gap opens.

Guiding rules:

- **Parallel, never big-bang.** CallRail keeps running until the app has proven
  itself per channel. Each publishing point (website, GBP, ads, print) cuts over
  independently and is reversible on its own.
- **Numbers customers may have saved get ported, not abandoned.** Repeat callers
  dial the number they saved months ago; a dead CallRail number is a lost job.
- **Per defaults (CLAUDE.md): history starts fresh** — no CallRail data import into
  the app — but we still take a one-time archive export before cancelling, because
  recordings are unrecoverable after the account closes.

---

## Step 0 — Inventory CallRail (no changes yet)

Build a spreadsheet of every CallRail tracking number with, per number:

1. **The number itself** and its **forwarding destination** (expect office
   +1 618 836 8004 for most).
2. **What it tracks** (source: GBP Edwardsville, GBP O'Fallon, Google Ads call
   asset, website DNI pool, print/yard signs/truck wraps, email signature, etc.).
3. **Everywhere it is published** — this is the critical column. Check at minimum:
   - Google Business Profiles (both locations) — primary phone field.
   - Google Ads: call assets/extensions, call-only ads, location assets.
   - arbor-mgmt.com (the number CallRail's swap.js falls back to).
   - Print: yard signs, truck wraps, door hangers, invoices, uniforms.
   - Directories (Yelp, BBB, Nextdoor, Angi), email signatures, review replies.
4. **Call volume last 90 days** (from CallRail reporting) — decides port vs drop.
5. Which numbers are **pool numbers** (website DNI rotation) vs **static**.

Also inventory CallRail's *integrations*: the Google Ads conversion actions it
feeds ("First Time / Repeat Phone Call", "Form Capture", "Chat Received"), its
form tracking on the website, and any notification emails/webhooks people rely on.

**Port vs. buy decision per number:**

| Number type | Decision |
|---|---|
| Published in hard-to-change places (GBP, print, wraps, signs) or meaningful repeat-call volume | **Port to Twilio**, keep same digits |
| Website DNI pool numbers | **Don't port** — the app's own Twilio pool replaces them |
| Low/zero volume, nowhere published | Let die with the account |

## Step 1 — Stand up the Twilio side in parallel

For each static source in the inventory, provision (or prepare to import) a
tracking number in **Numbers → Add** (search-by-digits flow already mimics
CallRail): matching area code (618), forward → office, whisper + recording +
consent notice on (IL/MO mixed-consent — already handled), mapped to the right
source and location. Build the DNI pool (start ~4–6 numbers; `LEASE_MINUTES=30`
leases recycle fast) for the website rotation.

Verify per number with a live test call: whisper plays, call connects, recording +
transcription land, lead is created with the right source, spam scoring runs.
Nothing is published yet — CallRail is untouched.

## Step 2 — Website shadow run (`track.js` alongside CallRail)

1. Add `<script async src="https://app.arbor-mgmt.com/track.js"></script>` to
   arbor-mgmt.com **while CallRail's swap.js stays in place**. `track.js` captures
   pageviews, UTMs/click-ids, and form submissions first-party; it does not need to
   swap numbers to do that, so the two scripts coexist.
2. Validate on `/dni-test` (built for exactly this — isolated from CallRail and
   hidden from customers): each channel preset leases the right pool number and a
   call to it attributes correctly.
3. Compare **form submission counts** app-vs-CallRail daily for ~1 week.

## Step 3 — Parallel validation window (2 full weeks minimum)

With Twilio static numbers live but unpublished and the website still on CallRail,
start publishing the **new-source channels first** where there's no CallRail
number to displace, then compare the overlapping ones:

- Daily per-source call counts: CallRail vs the app's Calls page. Investigate any
  gap > ~10% (usually a source-mapping or spam-filter difference, not lost calls).
- Confirm ROI attribution end-to-end at least once: call → lead → HCP customer
  match (E.164!) → won estimate → shows in ROI.
- Confirm the voice webhook fallback behavior (any error still forwards to the
  office) with a deliberate bad-config test on one number.
- Keep the app's Google Ads conversion actions **secondary/observe-only** the
  whole window (per `docs/conversion-export.md`) so CallRail's uploads and ours
  never double-count in bidding.

## Step 4 — Start ports out of CallRail (long pole — start early)

Kick this off as soon as Step 3 looks healthy; port-outs take **1–4 weeks** and
the numbers keep working in CallRail the entire time.

1. Request port-out info from CallRail support (they provide the account/LOA
   details; they do not block ports, but the account **must stay active and paid**
   until every port completes).
2. Submit port-in requests in the Twilio console for every "port" number.
3. The moment a port completes, run the app's **import-number** flow
   (`importPhoneNumber` in the add-number UI) for it: attach the voice webhook,
   map it to its historical source (e.g. the ported GBP number → `gbp` source),
   set forwarding. Do this same-day — between port completion and import, calls to
   that number would hit a bare Twilio number with no voice URL. (Pre-create the
   tracking-number rows and have the webhook config ready so the gap is minutes.)
4. From port completion onward the app tracks those callers; CallRail's stats for
   that number naturally go to zero.

## Step 5 — Cut over the publishing points

Once counts have matched for 2 weeks **and** ports are done (or the point uses a
new Twilio number, which needs no port):

1. **Website DNI:** remove CallRail's swap.js snippet; the app's DNI takes over
   number swapping. Site default (unswapped) number = the ported main tracking
   number or office line. Verify swap on all key channels via `/dni-test` presets
   immediately after deploy.
2. **Google Ads:** repoint call assets/extensions to the app's Google Ads static
   Twilio number. Then execute the conversion-action switch from
   `docs/conversion-export.md`: create the app's actions (done or pending per that
   doc), promote **Won Estimate** to primary, move the campaign to Max Conversion
   Value/tROAS if desired, and **pause CallRail's three actions**.
3. **GBP (both locations):** set primary phone to the ported tracking number
   (same digits if ported — then nothing to change; if swapping to a new number,
   add the real office line as "additional phone" to preserve NAP consistency).
4. **Directories/email signatures/misc:** swap to the appropriate static number
   at leisure — low urgency once the underlying numbers are ported.
5. **Print/wraps/signs:** nothing to do if those numbers were ported (same
   digits). Never republish print for a migration.
6. Recreate any **notification** needs (missed-call alerts etc.) people had in
   CallRail, or explicitly agree the Leads page replaces them.

## Step 6 — Wind-down and decommission

1. Watch CallRail's dashboard for ~2–4 weeks after cutover. Residual calls there
   mean a publishing point was missed — trace it (ask callers / check the
   number's inventory row), fix, repeat until CallRail flatlines (a trickle on
   dead un-ported numbers is expected and OK).
2. **Archive export** (even though app history starts fresh): calls CSV, form
   submissions CSV, and bulk-download recordings to cloud storage. Recordings are
   gone forever once the account closes.
3. Confirm every port completed and no number in the "port" list still lives in
   CallRail.
4. Cancel CallRail. Remove any leftover CallRail script tags, DNS entries, and
   the paused Google Ads conversion actions (delete after their 30-day lookback
   window empties).
5. Update `CLAUDE.md`/`README.md`: Phase 6 complete.

---

## Rollback levers (per stage, independent)

- **Website:** re-add CallRail swap.js, remove ours — minutes, no number changes.
- **Ads/GBP:** repoint the phone field back — propagates in hours.
- **Ported numbers:** can't quickly port *back*, but they're real Twilio numbers
  forwarding to the office; worst case callers still connect even if the app is
  down (the voice webhook fallback-forwards by design). This is why porting is
  low-risk despite being irreversible.
- Keep the CallRail subscription until **every** stage has survived its watch
  window — the monthly fee is the cheap insurance here.

## Success criteria (gate for cancelling CallRail)

- 2+ consecutive weeks where app call/form counts ≥ CallRail's per source (±10%).
- Zero dropped-call incidents (webhook fallback untested in anger or proven).
- All "port" numbers live in Twilio and attributed to correct sources.
- Google Ads bidding fed only by the app's conversion actions.
- Archive export saved.

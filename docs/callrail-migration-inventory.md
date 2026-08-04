# CallRail inventory — Step 0 of the migration plan

Companion to `docs/callrail-migration-plan.md`. This is the Step 0 deliverable: every
live CallRail number, what it tracks, where it is published, its real call volume, and
the port/swap/drop decision.

Pulled live on **2026-08-04** from the CallRail, Twilio, Google Ads and Google Business
Profile APIs, plus a fetch of arbor-mgmt.com. Volumes are the **90 days 2026-05-06 →
2026-08-04**, counted per tracking number across all 7 result pages (1,672 calls total —
the per-number counts below sum to exactly that, so nothing is sampled or estimated).

CallRail company `COM5b472d2f8bb648f4b62ee5095e3af772`, swap.js account `190471331`.

## The numbers

19 trackers exist; **13 are disabled** and hold no numbers. **6 active trackers carry 10
live numbers**:

| # | Tracking number | CallRail tracker | Type | 90d calls | Share |
|---|---|---|---|---|---|
| 1 | **+1 618 205 3094** | Direct | source | **552** | 33.0% |
| 2 | **+1 618 366 9977** | Google Local Service Ads | source | **421** | 25.2% |
| 3 | **+1 618 368 2902** | Google My Business (Edwardsville) | source | **327** | 19.6% |
| 4 | **+1 618 350 4451** | Google My Business (Ofallon) | source | **82** | 4.9% |
| 5 | **+1 618 414 5907** | Google Call Only Ads | source | **72** | 4.3% |
| 6 | +1 618 681 5764 | Website pool | session | 51 | 3.0% |
| 7 | +1 618 205 9820 | Website pool | session | 53 | 3.2% |
| 8 | +1 618 350 4871 | Website pool | session | 43 | 2.6% |
| 9 | +1 618 350 4252 | Website pool | session | 37 | 2.2% |
| 10 | +1 618 352 2730 | Website pool | session | 34 | 2.0% |
|   |  | **Website pool subtotal** |  | **218** | **13.0%** |
|   |  | **Total** |  | **1,672** | 100% |

All 10 forward to the same destination — see "Forwarding destination" below.
Recording is on for every active tracker. Only the two disabled GMB/Yelp trackers ever
carried a greeting ("This call may be recorded and shared with third-party providers.");
**the five active source trackers and the pool have `greeting_text: null`**, so today's
callers hear no recording notice from CallRail.

## Where each number is published (verified, not assumed)

| Number | Publishing point | Evidence |
|---|---|---|
| **618 205 3094** | arbor-mgmt.com — hard-coded default, 9 occurrences on the homepage | fetched 2026-08-04 |
| | GBP **Edwardsville** → `additionalPhones` | GBP API |
| | **Print / truck wraps / yard signs — this is the only number in print** | Justin, 2026-08-04 |
| **618 366 9977** | Google **Local Services Ads** account | CallRail tracker source type `google_local_services_ads` |
| **618 368 2902** | GBP **Edwardsville** → `primaryPhone` | GBP API |
| **618 350 4451** | GBP **O'Fallon** → `primaryPhone` | GBP API |
| **618 414 5907** | Google Ads call asset `338816285606` on campaign `23633267649` ("Search \| Tree Services" — the only ENABLED campaign) | GAQL `campaign_asset` |
| | Google Ads **account-level** call asset `172222076754` (ENABLED) | GAQL `customer_asset` |
| pool ×5 | Nowhere — swapped in by CallRail's swap.js at runtime | — |

**Dead Google Ads assets — no action needed.** Call assets `47402561053`, `47402561056`,
`47402561059`, `47402561062` and `47402561065` (numbers 618-202-5224 and 618-205-3094)
are attached only to **REMOVED** campaigns, and `47402561065` is PAUSED at account level.
`618 202 5224` is legacy and appears nowhere live.

## Port / swap / drop decisions

| Number | Decision | Why |
|---|---|---|
| **618 205 3094** | **PORT — mandatory** | The only number in print (trucks, signs, door hangers — Justin 2026-08-04). Cannot be reprinted, so it must keep its digits. Also the highest-volume number (33%), hard-coded on the website, and on GBP Edwardsville. |
| **618 368 2902** | **PORT** | GBP primary phone for Edwardsville. Not in print, so a swap is *possible* — but changing a GBP primary phone is a NAP-consistency event across the whole citation graph, and porting keeps the digits so there is no GBP edit at all. Not worth the SEO risk to save a port. |
| **618 350 4451** | **PORT** | GBP primary phone for O'Fallon. Same reasoning, and it matters more here: closing the O'Fallon review/ranking gap is the #1 GBP lever, so this is the last profile to take chances with. |
| **618 366 9977** | **PORT** | 421 calls/90d (25%) is too much volume to risk. LSA phone numbers are managed in the Local Services Ads product, not the Google Ads API — if it turns out to be freely re-pointable there, downgrading this one to a swap is a safe simplification. |
| **618 414 5907** | **SWAP, don't port** | Lives in exactly one editable place (a Google Ads call asset). Repoint the asset to `+16184278164`, which is already provisioned and wired. No port, no downtime. |
| **pool ×5** | **PORT — and reuse them as the app's own DNI pool** | *Reversed 2026-08-04.* Customers do dial pool numbers directly — see below. Porting keeps the digits alive **and** supplies the pool, so there is nothing to buy. |

That is **9 ports** (8 if LSA proves re-pointable) and **1 asset swap**. Nothing is dropped.

### Why the pool numbers get ported (this reverses the first draft)

The initial call was "published nowhere, let them die with the account." That was wrong,
and the CallRail data says so. Over the same 90 days, of the **218 calls to pool numbers**:

- **18 calls (8.3%) have no `landing_page_url` at all — and 100% of those are repeat
  callers** (`first_call: false`, `prior_calls` 1–5). A call with no landing page and a
  caller who has dialed before is someone ringing a number they saved, with no web
  session behind it. There is no other way to produce that combination.
- **66 calls (30.3%) are repeat callers** overall, against 38.2% on the static numbers —
  close enough that pool numbers are clearly not a first-touch-only channel.

So the floor is **~6 saved-number calls a month** that would hit a disconnected line if
the pool were abandoned, and the true figure is higher (a repeat caller who *also* browses
the site gets a landing page attached and is invisible to this test).

Porting them costs 5 extra port requests and removes the need to buy any pool numbers at
all — the ported originals *become* the app's pool. Strictly better than buying new ones.
The pool is 11 months old (created 2025-09-10), so there is a long tail of saved numbers.

Sequencing note: pool numbers can be ported at any time. Each one must be imported into
the app the same day its port completes, but the website can stay on CallRail's `swap.js`
throughout — CallRail's pool simply shrinks as numbers leave, and a caller dialing a
ported number still connects because the Twilio number forwards to the same destination.

## Twilio side — current state

Arbor's Twilio account (the one behind `TWILIO_ACCOUNT_SID`) owns **3 numbers**:

| Number | Friendly name | Voice URL | Status |
|---|---|---|---|
| **+1 618 427 8164** | `arbor:google` | `https://app.arbor-mgmt.com/api/twilio/voice` | **Live and wired to the app.** Status callback → `/api/twilio/status`; voice fallback → twimlet forward to 618-920-7917. Created 2026-06-29, last touched 2026-08-04. |
| +1 618 310 3486 | (618) 310-3486 | `demo.twilio.com` | Not a tracking number. SMS points at the Arbor MCP webhook. |
| +1 833 479 1834 | (833) 479-1834 | `demo.twilio.com` | Toll-free, unused. |

So **Step 1 is one number in**: `+16184278164` is provisioned and correctly wired, and is
the natural replacement for the Google Ads call asset (618-414-5907).

Still to provision: 3–4 static numbers (or the ported originals) plus a **5–6 number DNI
pool** to replace CallRail's website pool.

## Forwarding destination — DECIDED

**Every new tracking number forwards to `+1 618 205 9924`** (Justin, 2026-08-04) — the
same destination all 10 CallRail numbers use today. The migration therefore changes only
*who tracks* the call, never where it lands, which keeps call routing out of the blast
radius if anything goes wrong.

The migration plan had assumed the office at **+1 618 836 8004**; that is wrong and is
corrected in `docs/callrail-migration-plan.md`. Three destinations were in play:

| Destination | Where it is used | Notes |
|---|---|---|
| **+1 618 205 9924** | **All 10 active CallRail trackers** | Twilio Lookup: carrier "Twilio - SMS/MMS-SVR", CNAM "ARBOR MGMT". It is a **Twilio number, but not in Arbor's Twilio account and not one of Retell's two numbers** — so some other system owns it and relays to the office. |
| +1 618 920 7917 | The app's voice **fallback** on `+16184278164`; also the old destination on several disabled CallRail trackers | — |
| +1 618 836 8004 | The office number recorded in `CLAUDE.md` and the plan | Not referenced by any live CallRail or Twilio config. |

**Still worth chasing down what owns +1 618 205 9924**, since it is now a single point of
failure for every tracked call. It is a Twilio number outside Arbor's own account, so
some third system relays it to the office — knowing which one matters for debugging.

**Follow-up:** the app's existing number `+16184278164` still has its voice *fallback*
pointing at 618-920-7917, which no longer matches the decided destination. It should be
retargeted to +1 618 205 9924 so a primary-webhook outage degrades to the same place a
normal call goes.

## Other CallRail integrations to replace

- **Google Ads conversion actions** fed by CallRail. Handle via the switch described in
  `docs/conversion-export.md`; keep the app's actions secondary until cutover.
- **CallRail form tracking** on arbor-mgmt.com — replaced by `track.js`.
- **Notification emails / webhooks** anyone relies on — must be re-created or explicitly
  replaced by the Leads page.

## Next actions — queued, nothing executed

No live change has been made. Everything below is approved in principle but explicitly
**not yet run** (Justin, 2026-08-04).

**Justin owns:**

1. **Request port-out info + LOA from CallRail support** for all 9 numbers. Free,
   non-committal, and it is the 1–4 week long pole — starting it early costs nothing.
2. Confirm whether the **LSA number (618-366-9977) can be re-pointed** inside the Local
   Services Ads product. If it can, it drops off the port list.
3. Find out what system owns **+1 618 205 9924** — it is now the single destination for
   every tracked call.

**Ready to run on approval:**

4. Ship the **shadow-mode `track.js` tag** on arbor-mgmt.com (see below) — PR prepared.
5. Retarget `+16184278164`'s voice **fallback** from 618-920-7917 to +1 618 205 9924.
6. **The canary cutover:** repoint the Google Ads call asset to `+16184278164`. Must
   update **both** `338816285606` (campaign `23633267649`) **and** `172222076754`
   (account level) — miss the account-level one and 618-414-5907 keeps serving. Chosen
   as the first real cutover because it is a swap, not a port: reversible in minutes and
   only ~4% of call volume.

**No longer needed:** buying a fresh DNI pool. The ported CallRail pool numbers become
the app's pool.

## `track.js` must run in shadow mode — it is NOT inert by default

The plan claimed `track.js` and CallRail's `swap.js` "coexist" because the former does not
need to swap numbers. **That is not what the code does.** `track.js` calls
`/api/dni/assign` on every pageview, and that endpoint's last resort before giving up is
`getFallbackNumber()` — *the oldest active static tracking number*. Arbor has one
(`+16184278164`). So installing the tag as written would:

- rewrite every `a[href^="tel:"]` and `[data-arbor-phone]` element on arbor-mgmt.com to
  618-427-8164, replacing the site's real number (618-205-3094); and
- race CallRail's `swap.js`, which mutates the same links — whichever lands second wins.

Fixed by adding an explicit **shadow mode** to `track.js` (`data-shadow` attribute), which
skips the assign call entirely. Tracking — pageviews, UTMs, click IDs, form capture — is
unaffected. The shadow run is now safe by construction rather than by luck.

**Install for the parallel run:**

```html
<script async src="https://app.arbor-mgmt.com/track.js" data-shadow></script>
```

Drop `data-shadow` at cutover, in the same deploy that removes CallRail's `swap.js`.

## Status against the plan

| Step | State |
|---|---|
| 0 — Inventory | **Done** (this document). Open: print/wraps audit, forwarding destination. |
| 1 — Stand up Twilio in parallel | **Started** — 1 of ~9 numbers provisioned (`+16184278164`). |
| 2 — Website shadow run | **Not started.** `app.arbor-mgmt.com/track.js` is live and serving (HTTP 200), but arbor-mgmt.com carries only CallRail's `swap.js`. |
| 3 — Parallel validation | Not started. |
| 4 — Ports out of CallRail | Not started — **this is the long pole (1–4 weeks); start it early.** |
| 5 — Cut over publishing points | Not started. |
| 6 — Wind-down | Not started. |

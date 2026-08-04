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
| | *(suspected)* print / truck wraps / yard signs | **unverified — needs Justin** |
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
| **618 205 3094** | **PORT to Twilio** | Highest volume (33%), hard-coded on the website, on GBP Edwardsville, and the most likely number on print/wraps. Repeat callers have this one saved. |
| **618 368 2902** | **PORT to Twilio** | GBP primary phone for Edwardsville. Porting keeps the digits, so NAP consistency is untouched and there is no GBP edit to make. |
| **618 350 4451** | **PORT to Twilio** | GBP primary phone for O'Fallon. Same reasoning. |
| **618 366 9977** | **PORT** (default) | 421 calls/90d is far too much volume to risk. LSA phone numbers are managed in the Local Services Ads product, not the Google Ads API — confirm whether the number can simply be re-pointed there before committing to a port. |
| **618 414 5907** | **SWAP, don't port** | Lives in exactly one editable place (a Google Ads call asset). Repoint the asset to a new Twilio number; no port, no downtime. |
| pool ×5 | **DROP** | Pure DNI rotation, published nowhere. The app's own pool replaces them; let them die with the account. |

That is **4 ports** (or 3 if LSA can be re-pointed), **1 asset swap**, and **5 dropped**.

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

## Forwarding destination — OPEN QUESTION

The migration plan assumes calls forward to the office at **+1 618 836 8004**. Live
config disagrees, and three different destinations are in play:

| Destination | Where it is used | Notes |
|---|---|---|
| **+1 618 205 9924** | **All 10 active CallRail trackers** | Twilio Lookup: carrier "Twilio - SMS/MMS-SVR", CNAM "ARBOR MGMT". It is a **Twilio number, but not in Arbor's Twilio account and not one of Retell's two numbers** — so some other system owns it and relays to the office. |
| +1 618 920 7917 | The app's voice **fallback** on `+16184278164`; also the old destination on several disabled CallRail trackers | — |
| +1 618 836 8004 | The office number recorded in `CLAUDE.md` and the plan | Not referenced by any live CallRail or Twilio config. |

**This must be resolved before provisioning the remaining numbers** — it is the value
every new tracking number forwards to, and getting it wrong sends real calls nowhere.

## Other CallRail integrations to replace

- **Google Ads conversion actions** fed by CallRail. Handle via the switch described in
  `docs/conversion-export.md`; keep the app's actions secondary until cutover.
- **CallRail form tracking** on arbor-mgmt.com — replaced by `track.js`.
- **Notification emails / webhooks** anyone relies on — must be re-created or explicitly
  replaced by the Leads page.

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

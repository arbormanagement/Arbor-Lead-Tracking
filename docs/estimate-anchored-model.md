# Estimate-anchored model — implementation plan

Status: **agreed, not started** · Drafted 2026-08-14 · Supersedes nothing yet;
`CLAUDE.md` is still authoritative until each phase lands.

Restructures the app so the **HousecallPro estimate** is the unit of opportunity,
instead of the inbound contact. Also the first step in folding
`reports.arbor-mgmt.com` into this app.

---

## Why

The app currently asks one object — the "lead" — to be two things at once: a record
that *someone contacted us*, and a *business opportunity*. That is where `is_lead`
comes from, and why "how many leads?" has three different answers.

**Three predicates, all live, all different:**

| surface | predicate | texts | human "not a lead" |
|---|---|---|---|
| `/leads` list + counters | `isQualifiedLead` | needs `is_lead = true` | excluded, any type |
| Overview "Captured" | `type ≠ call OR is_lead` | always counted | ignored except calls |
| `/sources` "Leads", `roi_daily` | same | always counted | ignored except calls |
| `/api/leads` | *none* | always counted | counted, **incl. spam** |

`lib/leads/qualified.ts` — which `CLAUDE.md` describes as "the one definition… so the
list and the numbers above it can never disagree" — is referenced in exactly one file,
`app/(dashboard)/leads/page.tsx`.

Two of those disagreements contradict documented intent:

- `CLAUDE.md` states **"A text is NOT presumed to be a lead."** The ROI rollup presumes
  exactly that: it special-cases `call` only, while `QUALIFICATION_REQUIRED` is
  `["call", "sms"]`.
- The manual not-a-lead override is ignored by ROI for every type except calls, though
  it exists specifically so a junk web form can be dropped.

Both inflate the denominator, so leads→qualified reads worse than reality and CPL
reads better.

## What we measured (2026-08-13/14)

| | |
|---|---|
| Estimates created in HCP, last 30d | **~540** |
| Tracked contacts, last 30d | **351** |
| Contacts linked to an estimate | 227 (65%) |
| Estimates with a tracked origin | **~42%** |

**Estimates exceed contacts.** A large share of estimates have no inbound contact
behind them at all — repeat business, referrals, canvassing, estimates written in the
field. No amount of tracking changes that, and today it is invisible because the
lead-anchored view only ever displays the matched subset.

Match rate tracks identifier coverage, not channel quality:

| type | n | phone | email | matched |
|---|---|---|---|---|
| facebook_leadgen | 92 | 92 | 92 | 100% |
| web_form | 27 | 26 | 26 | 74% |
| lsa | 122 | 122 | 0 | 66% |
| call | 110 | 110 | 0 | 32% |

Channels carrying **both** identifiers match roughly twice as well as phone-only ones.
Calls are also genuinely noisier — wrong numbers, vendors, existing customers — which
is the argument against using raw call count as a denominator at all.

---

## Target model

Three layers instead of one.

1. **Contacts / Inbox** — everything that arrived, any channel. This is **demand**.
   Unchanged.
2. **Estimates** — from HousecallPro. This is **opportunity**. One row per estimate;
   stage (created → quoted → won/lost/cancelled) comes entirely from HCP.
3. **Attribution** — links each estimate back to the contact that produced it, which is
   what gives it a source, campaign and click id.

The engine is already estimate-anchored: `matchLeadsToEstimates` loops over estimates
and claims a lead for each. What is lead-anchored is only the **aggregation and display**
on top of it.

---

## Decisions taken

**1. Estimates are owned, not mirrored.**
`CLAUDE.md` currently says *"this app stores no customer data; it links to
HousecallPro."* That is right for a reporting sidecar and wrong for a system of record.
Given the intent to fold in `reports.arbor-mgmt.com` and eventually more, estimates
become **our** opportunity object that HCP happens to populate. Cheap now, a rewrite
later.

**2. Contacts stay as a separate top-line, not replaced.**
110 calls producing 35 estimates is an operational signal about booking rate. An
estimate-anchored funnel hides it by construction. Estimates become the *opportunity*
metric; contacts remain the *demand* metric.

**3. `roi_daily` keeps bucketing on the CONTACT date, not the estimate date.**
Spend is reported per click-day. An estimate written three weeks after the click must
still be credited to the click's day or CPL/ROAS smear across the calendar. This is the
single easiest thing to get wrong in the whole plan.

**4. `is_lead` leaves the money path entirely.**
It stays as the Inbox triage toggle, where it is useful. No metric reads it. That makes
the three-predicate divergence structurally impossible rather than patched.

**5. "Unattributed" is a first-class bucket, not a gap.**
~58% of estimates today. Displaying it is the point — it is the number that says how
much of the business we can actually explain.

**6. Cancelled estimates are EXCLUDED from the close-rate denominator.**
This is the rule the business already operates on, and it is not optional. Feb 2026,
counted both ways:

| | estimates | won | rate |
|---|---|---|---|
| every HCP record | ~114 | 29 | 25% |
| reporting app | 60 | 29 | **48.3%** |

Identical numerator; the denominator is the whole difference.

**Copy this predicate rather than re-deriving it** — verified against
`arbor-reporting/server/storage.ts`, `getEstimatePivotMulti`:

```sql
WHERE e.scheduled_start IS NOT NULL                    -- never booked = never sold
  AND (e.status IS NULL OR e.status NOT IN ('pro canceled', 'user canceled'))
  AND e.scheduled_start >= :from AND e.scheduled_start < :to
GROUP BY date_trunc('month', e.scheduled_start)

conversion_rate = count(*) FILTER (WHERE outcome = 'won') * 100.0 / count(*)
```

Three exclusions, and the third is the one easiest to miss: the window and the grouping
are on **`scheduled_start`, the appointment date — not `created_at`**. "Feb 2026" means
estimates *visited* in February, not created in February. A cohort built on `created_at`
is not the same population and will not reconcile.

Read as a business metric this is plainly right: *of the estimate visits we actually went
out on, what share closed*. Cancelled appointments never happened, unbooked estimates
were never sold, and dating by the visit puts the number in the month the selling
happened.

The filter runs at **query time**; the reporting DB holds the unfiltered rows.

`deriveOutcome` there is logically identical to `mapEstimate` in
`lib/integrations/housecallpro.ts` — same won/lost/open rules, same status vocabulary —
so both systems already agree on the numerator. Only the denominator has to be adopted.

Still worth handling separately: an estimate takes ~30 days to settle, so a trailing
window under-reports — the most recent 100 estimates were 86% undecided. Show cohort
maturity alongside the rate.

---

## Phases

Ordered by dependency. P0 is independent of everything and should not wait.

### P0 — Close the reports exposure · **out of band, do first**
`reports.arbor-mgmt.com` serves `/api/customers` (name, email, phone, address,
revenue — 10,596 rows), estimates, invoices and jobs to unauthenticated requests.
`AUTH_DISABLED=true` overrides the configured Cloudflare Access.
**Verify CF Access works before flipping**, or you lock yourself out. Not a code change
in this repo.

### P1 — Estimates as a first-class object
- `lib/db/schema.ts` — `hcp_estimates` gains the columns a real opportunity object
  needs; keep `raw` for anything not yet modelled.
- Full history is already loaded: **15,234 estimates, 6,742 won, $14,157,647**
  (backfilled 2026-08-14 via `POST /api/sync/hcp?days=3600`).
- Verify: row counts against HCP's own `total_items`.

### P2 — Aggregation moves to estimates
- `lib/sync/attribution.ts` — `rebuildRoiDaily` aggregates estimates, adds an
  unattributed bucket, keeps contact-date bucketing (decision 3).
- Drop `or(ne(leads.type,'call'), eq(leads.isLead,true))` from the ROI path (decision 4).
- Verify: rebuild a known window and reconcile totals against HCP directly.
- **Risk:** reported CPL rises and Captured falls. Expected, not a regression — but it
  breaks month-over-month comparison across the switch. Announce the date.

### P3 — Surfaces
- Overview funnel → **Contacts → Estimates → Quoted → Won**.
- `/leads` → `/estimates`: one row per estimate, with source or "unattributed".
- `/sources` reads the new rollup.
- Retire `lib/leads/qualified.ts` from ROI; keep for the Inbox toggle.

### P4 — Invoice sync *(new data, no equivalent here today)*
The one dataset the reporting app has that this one lacks. July 2026 alone: 189
invoices, $372,667 billed, $95,799 outstanding, 74% collection rate.
- `lib/integrations/housecallpro.ts` — `listInvoices`; `lib/sync/hcp.ts` — persist.
- Same trap as estimates: **verify which timestamp actually moves on payment** before
  choosing a sync window. Do not assume `updated_at`.

### P5 — Report surfaces
Rebuild what `reports.arbor-mgmt.com` provides: estimate/job/invoice pivots, drilldowns,
AR ageing. `/api/automations` there returns `[]` — unused, nothing to migrate.

### P6 — The webhook slot *(constraint, not a feature)*

**HousecallPro allows exactly ONE webhook subscription per account, and it is already
taken by another integration** (confirmed by Justin, 2026-08-14). This is a scarce
shared resource, not something this app can simply subscribe to.

Consequences, in order of importance:

1. **Event-driven ingest is off the table.** Polling is therefore not a stopgap, it is
   the architecture. The rolling `created_at` re-read in `listEstimates` is load-bearing
   permanently — which is why `paginate` throws on truncation rather than warning: there
   is no event stream to catch what a silent gap misses.
2. **Whoever holds the slot must fan out to everyone else.** That is exactly what
   reporting's `/api/webhooks/forward-urls` does — one rule, pointing at
   `arbor-website-est-creation.replit.app/api/webhook/review_request`. Turning reporting
   down without re-homing that **breaks the review-request flow silently**: no error,
   just no review requests.
3. **Taking the slot means inheriting the hub role**, including responsibility for the
   review-request flow's uptime. Worth doing eventually — it is the only path to
   real-time HCP data — but it is an operational burden to take on deliberately, not a
   side effect of a decommission.

Reporting's own webhook table holds **5 events, all 2026-03-18, none processed**
(`estimate.created`, `estimate.sent`, `job.completed`), consistent with it having held
the slot briefly and lost it. Do not read that table as evidence of what HCP emits.

Note that no *approval* event appears in that sample, and option approval is precisely
what broke before — so even with the slot, webhooks may not have solved the original
bug. Confirm the event catalogue before treating the slot as valuable.

### P7 — Parallel run, then decommission
Run both apps and reconcile. Only then turn reporting down. This is the CallRail
decommission pattern from `CLAUDE.md`: shadow, verify live, cut over — and even then
CallRail was not cancelled while recordings still needed archiving.

---

## Explicitly not doing

**Not replacing HousecallPro.** Scheduling, dispatch, invoicing, payments and a field
app for crews are a different order of magnitude. Take over one object at a time.

**Not migrating to Supabase — for now.** It is still Postgres and Drizzle works with it,
so the move itself is cheap. But it does not buy what "AI-forward" needs, and it carries
one specific risk against this codebase's constraints:

- `/api/twilio/voice` must answer in **under 3 seconds** and does DB lookups on the hot
  path. The database currently sits on `postgres.railway.internal` — same project, sub-
  millisecond. Moving it off-platform puts the public internet on that path. This repo
  already removed DB reads from credential resolution for exactly this reason.
- Supabase's transaction-mode pooler does not support the interactive transactions the
  DNI leasing path needs. Session mode or a direct connection works — a real gotcha, not
  a blocker.
- **pgvector** does not require Supabase; it is an extension on any Postgres, Railway's
  included.

The genuine gap Supabase would fill is **multi-user auth** — today it is a single admin
from `ADMIN_EMAIL`/`ADMIN_PASSWORD_HASH`, which does not extend to crew logins. Revisit
if and when that becomes the binding constraint.

**What actually enables AI-forward / generative UI** is not a database vendor. It is a
**bounded, well-typed semantic query layer** the model can call safely — the same
argument `app/api/diagnostics/route.ts` already makes for itself: *"Deliberately a FIXED
set of checks, not a query interface. The obvious version — an endpoint that runs SQL you
hand it — would be an arbitrary-read (and, one typo later, arbitrary-write) backdoor into
a production database holding customer contact details."* That reasoning holds doubly
when the caller is a model. Consolidating the data here (P1–P5) is the prerequisite;
the query layer is the next design conversation.

---

## Open questions

1. ~~Does HCP emit an estimate **approval** webhook?~~ **Closed 2026-08-14** — moot for
   now. HCP permits one webhook subscription per account and it is already held by
   another integration, so polling is the architecture (see P6).
2. Does the reporting DB hold anything beyond customers / estimates / invoices / jobs /
   webhook events? Repo is now cloned (`arbormanagement/arbor-reporting`) —
   `shared/schema.ts` is the place to look before P5.
3. ~~Historical close rate is 44% but ~30% recently — genuine or artefact?~~
   **Closed 2026-08-14 — artefact of MY denominator, not a real collapse.** Counting
   every HCP record gave ~25% for Feb 2026; the reporting app gives 48.3% for the same
   month off the same 29 wins. Its denominator excludes cancelled AND unscheduled
   estimates and is dated by appointment rather than creation — see decision 6 for the
   exact predicate, read from the reporting app's source rather than inferred.

   The business's own trend, from the reporting app:

   | | conversion |
   |---|---|
   | Aug 2019 | 69.9% |
   | Jun 2023 | 50.7% |
   | May 2025 | 48.9% |
   | Feb 2026 | 48.3% |
   | Jun 2026 | 44.8% |

   A real decline 2019→2023 (~70% → ~50%), then broadly flat. Nothing indicates a
   current problem. An earlier draft of this document claimed the rate had "roughly
   halved since 2019 and is still drifting down" — wrong on the level and wrong on the
   recent trend.
4. Facebook leads match at 100% — plausible, since every FB enquiry gets an estimate
   booked, but worth a spot check for over-matching.

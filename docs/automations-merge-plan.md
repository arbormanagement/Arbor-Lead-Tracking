# Migrating Arbor-Automations into Arbor-Lead-Tracking

**Status (2026-08-30): CODE FOR SLICES 1–5 IS BUILT AND VERIFIED on this branch; nothing
is deployed and no cutover has happened.** Every webhook is dormant until its external
config repoints here, and the two paths that could act on their own — the review-sequence
cron and the Facebook HCP write — default OFF behind `REVIEW_WORKFLOW_ENABLED` /
`FB_HCP_WRITE_ENABLED`, so merging to `main` changes nothing observable. Verified:
`tsc`, `next build`, four verify suites (office-hours 29 cases, caller-context 67 checks,
reviews, plus the existing hcp), byte-identical office-status parity against the live
production webhook, and a scratch-Postgres rehearsal of the import (dry/apply/idempotent
re-run), the workflow gate + due-step + persisted retry cap, the click redirect, and the
call-summary idempotency. Remaining: slice 0's open checks, the real import, and the
cutovers — each needing Justin. Written 2026-08-30 from a full read of both
codebases. The goal: one app (this one) owns the entire inbound-lead pipeline — call in,
attribution, Chloe's context, estimate creation, review follow-up — and the
`Arbor-Automations` Express app on Railway is retired.

## Why merge (short version)

The two apps are already in series on the same phone call and can't see each other:

```
customer → LT tracking number → /api/twilio/voice → forward to Chloe (+16182059924)
         → Automations /api/webhook/retell_inbound   (office hours + HCP caller lookup)
         → Automations /api/webhook/retell_estimate  (creates HCP customer + estimate)
         → Automations /api/webhook/call_summary     (emails info@)
         → LT hcp sync rediscovers the estimate up to an hour later and fuzzy-matches
           it back to the lead it came from
```

Concrete costs of the split, each fixed by the merge:

1. **Caller lookup hits HCP live on the telephony hot path** (2.5s budget, E.164 trap,
   fuzzy-`q` re-verification) when LT holds a complete local mirror — ~10.7k customers
   with every phone number in `hcp_customers.phones_e164` (GIN-indexed) plus the
   contacts identity spine that already solved the multi-phone problem.
2. **Estimate→lead attribution is a heuristic that could be a foreign key.** The
   `retell_estimate` webhook knows exactly which call produced the estimate; today that
   knowledge is thrown away and `matchLeadsToEstimates` reconstructs it (second-granularity
   timestamp bound, one-lead-one-estimate rule, ~18% unattributed tail).
3. **The review workflow has no consent layer.** No STOP handling, no opt-out state, no
   `do_not_service` check (tags only — the same gap that put 51 flagged customers on the
   newsletter). Inbound replies are forwarded to email as text; a STOP reply is an email
   Justin reads, not a block. LT already enforces all of this per-contact
   (`lib/messaging/send.ts`, STOP words + Twilio 21610 writeback).
4. **Scheduling is `setInterval` in the web process** with in-memory retry counts and an
   env-var footgun (`ENABLE_REVIEW_WORKFLOW` — "exactly ONE deployment may set this or
   every customer gets texted twice"). LT's cron worker + `sync_runs_one_running_uq`
   eliminates that failure class.
5. **Straight duplication:** two Meta leadgen webhooks (HMAC verify + Graph fetch, both
   repos), two website-form ingest paths, two HCP clients, two phone normalizers.
   Automations' Facebook path also has **no campaign exclusion** — any leadgen event
   becomes an HCP customer + estimate, recruiting applicants included (dormant only
   because the recruiting campaign is paused).

The old reason to keep them apart — "don't couple the telephony hot path to a busy deploy
cadence" — is already void: LT owns `/api/twilio/voice`, which must answer in under 3s or
the call is lost. A bad LT deploy drops calls today. Railway's health-checked deploys keep
the old container serving until the new one passes `/api/health`, and Retell retries the
inbound webhook 3× with a 10s timeout, failing safe to v110's `default_dynamic_variables`.

## Inventory: where every piece of Automations ends up

| Automations piece | Disposition |
|---|---|
| `server/officeHours.ts` (+ tests) | **Port as-is** → `lib/retell/office-hours.ts` (pure, no deps) |
| `server/callerLookup.ts` | **Rebuild on LT's local mirror** → `lib/retell/caller-context.ts`. Keep the directive-sentence rules verbatim (emit a directive, never a fact + gag order; state absences positively; multi-customer number = UNKNOWN) |
| `/api/webhook/retell_inbound` (POST+GET) | Reimplement at the **same path** in LT |
| `/api/webhook/retell_estimate` | Reimplement at same path; **new:** link the created estimate to the live call's lead/contact |
| `/api/webhook/call_summary` | Reimplement at same path. **Keep the info@ email** — it is the only record of estimate cancellations (Chloe's `##Cancel Estimate` calls no function, by design) |
| `/api/webhook/website_lead` | Reimplement at same path; resolve into the contact spine so the HCP estimate links to the form lead `track.js` just captured |
| `/api/webhook/facebook_leads` | **Fold into LT's existing FB pipeline** (`lib/facebook/ingest.ts` + webhook + poller); add the HCP customer+estimate write after ingest, gated on `campaigns.excluded` so applicants never become HCP customers |
| `/api/webhook/review_request` (HCP invoice.paid) | Reimplement at same path against LT tables |
| `server/reviewWorkflow.ts` sequencer | **Rebuild as a cron job** (`review-workflow`, every 5 min, `withSyncRun`-guarded). Persist attempt counts on the row, not in a Map |
| `/track/review` click redirect | Reimplement at same path — **live links in customers' SMS history must resolve forever** |
| `/api/webhook/twilio` (SMS reply → email) | **Delete.** LT's `/api/twilio/sms` already captures, threads, opt-outs, and relays inbound texts |
| `server/email.ts` (SendGrid + failure alerts) | **Port** → `lib/email/sendgrid.ts` (LT has no email module; review follow-up + call summary + alerts need it) |
| `server/twilio.ts` (send + delivery re-check) | **Drop the client** (LT has one); port the **delivery-status re-check + error-code hints** idea into LT's message status handling (LT already receives status callbacks; wire undelivered→alert) |
| `server/housecallpro.ts` (writes) | **Port the write half** → `lib/integrations/housecallpro-write.ts`: `searchCustomerByPhone` (replaced by local mirror), `createCustomer`, `createEstimate`, with the sanitize-or-drop field rules from `.agents/memory/hcp-field-validation.md` (HCP 400s all-or-nothing on bad email/state/phone; drop the field, never lose the lead) |
| `server/catchupCampaign.ts` | **Do not migrate** — one-time campaign, drained. Import its table for click history only |
| Admin one-offs (backfill-reviews, fix-review-urls, resend-summaries, …) | **Do not migrate** — they were migration-era tools themselves |
| React dashboard (client/) | **Do not migrate** — LT's dashboard supersedes it; add a small "Review requests" surface later if wanted |
| `.agents/memory/*` | Fold the two lessons into this repo's CLAUDE.md watch-outs when the relevant slice lands |

Tables to migrate (Automations Postgres → LT Postgres, one-time import). **Decision
(Justin 2026-08-30): lean import — merge only what has a live function; the rest is
dump-only.** The Automations database ceases to exist entirely at retirement; there is no
ongoing sync or second connection at any point, only the one-time import in slice 3.

| Table | Import? | Notes |
|---|---|---|
| `review_requests` | **Yes, fully** | The only table with live state: tracking IDs sit in sent texts, rows are mid-sequence, and the dedupe rules need history. Convert stringly `'true'/'false'` to real booleans; add `attempts` columns |
| `catchup_texts` | Yes (read-only history) | Campaign is drained; rows only serve `/track/review` clicks |
| `service_requests` | **No — dump-only archive** | Historical intake log; LT's leads/form_submissions/facebook_leads replace it going forward. `fb_leadgen_id` dedupe doesn't reach backward (Meta only redelivers recent events, and LT's pipeline has its own key) |
| `call_summaries` | **No — dump-only archive** | LT's `calls` table (recordings + transcripts) is richer. `call_id` idempotency only matters for near-term Retell redeliveries, so post-cutover dedupe starts empty and that's fine |
| `users` | No | Vestigial Replit scaffold |

## The cutover trick: keep every external URL alive

External systems point at `automations.arbor-mgmt.com`. They fall into two classes:

**Repointable via API/config** (switch these to LT's canonical domain one at a time, each
with its own verify step): Retell `create_estimate` custom-function URL and the agent's
`call_summary` webhook (both on the LLM/agent object — API-editable, but a Retell change =
new draft + publish + simulation grade, per the standing Retell process), the HCP
invoice.paid webhook, the Meta app's leadgen callback, the website form's
`website_lead` target.

**Not repointable**: the Retell **inbound** webhook (configured per phone number in the
Retell dashboard only — established via PRs #217/#218, it cannot be set through the API)
and the `/track/review` links already sitting in customers' SMS threads.

So the plan is hybrid:

1. Implement every handler in LT **at the identical legacy path** (`/api/webhook/…`
   singular, `/track/review`). Middleware matcher gains `api/webhook|track/review`
   exclusions.
2. Repoint the repointable integrations to `https://<LT domain>/api/webhook/…` one slice
   at a time, verifying each.
3. Last, move the domain: add `automations.arbor-mgmt.com` as a second custom domain on
   the LT `web` Railway service, remove it from the old service, update the DNS CNAME to
   the new Railway target. By then the domain carries only `retell_inbound` (fails safe —
   a missed webhook degrades to v110's default variables) and `/track/review` clicks
   (a retry-able redirect). Lower the DNS TTL a day ahead; do the swap in the evening.
4. One manual dashboard change remains as belt-and-braces: after the domain move, also
   update the inbound webhook URL on +16185911316 in the Retell dashboard to the LT
   canonical domain, so the legacy hostname can eventually be dropped entirely.

A GET on the same path proves which app is serving: the LT implementation should add a
`"served_by": "lead-tracking"` field to the `retell_inbound` GET response so parity checks
and the cutover are observable (⚠️ remember: a 200 from the old host proves nothing — its
SPA catch-all serves index.html for unmatched routes; always check the body is JSON).

## Slices

Each slice ships and verifies independently; the order is value-over-risk. Nothing sends
a customer-facing message until slice 4, and the double-send class is handled by hard
cutover, never parallel running.

### Slice 0 — Pre-flight discovery (no code)

Findings so far (checked live 2026-08-30):

- ✅ **Postgres versions:** LT runs `postgres-ssl:17` (current major, daily + weekly
  backups on the volume). Automations runs `postgres-ssl:16` — and its volume had **zero
  backup schedules, never backed up once**. Fixed same day: one-off backup taken
  (`62f4002a…`, 16:46 UTC) and a DAILY schedule enabled for the remainder of its life.
  No version-upgrade work is needed anywhere: the merge direction is 16 → 17, `pg_dump`
  restores forward across majors cleanly, and the 16 instance is deleted at retirement.
- ✅ **Both apps use the SAME Twilio account** (`AC9c81b984…` on both Railway services).
  The review sender is **+16183103486**. It has delivered texts since the A2P fix of
  2026-07-24, so it is 10DLC-registered; what remains open is only whether it sits in
  messaging service `MG2fea0b23db4aa369705393147cc857ba`'s sender pool or on a separate
  registration.
- ⚠️ `ENABLE_CATCHUP_CAMPAIGN` is still `"true"` on the Automations service. Harmless
  (the queue is drained, the tick no-ops) but flip it to false along with
  `ENABLE_REVIEW_WORKFLOW` at the slice 4 cutover so nothing on the old box can ever
  send again.

Still to check / decide:

- [ ] Is +16183103486 in the `MG2fea…` sender pool? (Twilio console or API — the Arbor
      MCP has no Twilio integration, so this is checked from LT's credentials or the
      console.)
- [ ] **Which Meta app receives the leadgen webhook today**, and do LT's
      `FACEBOOK_APP_SECRET`/verify token and Automations' `META_APP_SECRET` belong to the
      same app? (Both repos carry a full webhook; only one can be the page's subscriber.)
- [ ] pg_dump the Automations Postgres to Drive (the Railway volume backup covers
      disaster recovery; the dump is the long-term archive that outlives the project)
      and record row counts per table for import verification.
- [ ] Confirm Automations still deploys from `main` with auto-deploy ON
      (`railway_list_deployments` → `meta.branch`) — fixed 2026-08-27, verify it stuck.
- [ ] Enumerate live config: Retell LLM tool URLs (`create_estimate`), agent webhook
      (`call_summary`), HCP webhook registration, website form target + secret, DNS TTL
      on `automations.arbor-mgmt.com`.
- [ ] **Decision (Justin): review-text sender number.** Recommended: import
      +16183103486 into `tracking_numbers` as a static number in a new `outreach` pool
      (not DNI), so replies thread into the inbox and STOP is enforced by the existing
      `/sms` route. Same Twilio account, so this is a plain import, not a port.

### Slice 1 — Retell inbound (office hours + caller context) on LT

The highest-value, lowest-risk slice: removes a live HCP network call from the telephony
hot path.

Build:
- `lib/retell/office-hours.ts` — verbatim port of `server/officeHours.ts`. Port
  `script/officeHours.test.ts` as `scripts/verify-office-hours.ts` (this repo has no test
  runner; follow the `verify:hcp` pattern).
- `lib/retell/caller-context.ts` — same contract as `describeCaller()`, but resolved from
  `hcp_customers` (`phones_e164` overlap) + `contacts` locally. Preserve, as rules:
  - emit a **directive sentence**, never a fact the prompt must conceal (never an address
    count; the 6/6 leak);
  - state absences **positively** ("no email on file") — an inferred absence produced an
    invented email 5/5;
  - ≥2 distinct customers on one number → UNKNOWN;
  - prefer `type: "service"` address, count service locations not array entries, carry
    `street_line_2`;
  - `do_not_service` read/logged but **never shown to Chloe** (Justin 2026-08-27);
  - report which phone field matched (mobile/home/work).
  The generated sentence must be **byte-compatible** with what production emits today —
  simulation test cases inject these strings, and the standing rule is "generate them by
  RUNNING the source." After this slice, that source is here.
- `app/api/webhook/retell_inbound/route.ts` — POST (contract: all dynamic-variable values
  strings; fail-safe = UNAVAILABLE; always 200 with variables) + GET parity endpoint with
  `served_by`. Log every call in the same shape (from/to/open/caller/ms).
- Middleware matcher: exclude `api/webhook`.

Verify:
- `verify-office-hours` green; GET parity diff old vs new host across in-hours, evening,
  weekend, before-open, and a holiday date, plus `?from=` on a known caller, an unknown
  caller, and a shared-number case.
- Latency: the POST must comfortably beat Retell's 10s ceiling; local-DB lookup should
  land well under the old 2.5s HCP budget.

Cutover: none yet — the old app keeps serving until the domain move (slice 6). This slice
just makes LT *able* to serve it, verified on LT's own domain.

### Slice 2 — HCP write module + estimate webhook + call summary

Build:
- `lib/email/sendgrid.ts` — port `sendEmail`/`sendFailureAlert`/`escapeHtml`. Env adds:
  `SENDGRID_API_KEY`, `SENDGRID_FROM_EMAIL`, `SENDGRID_FROM_NAME`, `ALERT_EMAIL_TO`
  (all through `lib/env.ts`, per house rule).
- `lib/integrations/housecallpro-write.ts` — `createCustomer` + `createEstimate` with
  sanitize-or-drop (email/state dropped if unfixable; phone is the key; a lost optional
  field beats a lost lead). Customer search uses the local mirror first, live HCP as
  confirmation before creating (the mirror can be up to an hour stale — never create a
  duplicate customer off a stale miss).
- `app/api/webhook/retell_estimate/route.ts` — same contract (always 200 with a `result`
  string Chloe can speak; `call.from_number` as primary phone). **New:** resolve the
  caller to a contact, find the open lead from the in-flight call (the call arrived
  through `/api/twilio/voice` minutes earlier), and stamp `leads.hcp_estimate_id` +
  `contacts.hcp_customer_id` at creation. Attribution becomes deterministic for
  voice-agent estimates; `matchLeadsToEstimates` remains for everything else.
- `app/api/webhook/call_summary/route.ts` — idempotent on `call_id` via a small
  `retell_call_summaries` log table with a unique on it (starts empty at cutover —
  lean-import decision; Retell only redelivers near-term, so history buys nothing),
  email to info@ preserved verbatim. Optionally also attach the summary to the LT call
  row (match on Retell call metadata / from_number + time) so the inbox thread shows
  it — nice-to-have, not gating.

Verify: dry-run mode first (create against HCP with a test customer, then delete);
`retell_estimate` exercised via curl with a captured production payload; confirm the
estimate lands in HCP **and** the lead link is set; call summary email received.

Cutover: repoint the Retell `create_estimate` tool URL and the agent's `call_summary`
webhook to the LT domain. This is a Retell LLM/agent change → **standard Retell process
applies**: draft version, simulation batch (in-hours AND after-hours, ≥3 samples of any
transfer case, inject `office_status`/`caller_context` generated by running the source),
separate approval from Justin, publish. Old endpoints stay up as dead men until slice 6.

### Slice 3 — Data import (reviews + click history)

Build:
- Drizzle migration: `review_requests` (typed: booleans, timestamps, `attempts_sms1/
  email/sms2` int columns) and `catchup_texts` (as-is, read-only). Nothing else — the
  lean-import decision keeps `service_requests`/`call_summaries` in the Drive dump only.
- `scripts/import-automations-db.ts` — reads a pg_dump/CSV export, converts
  `'true'/'false'` strings, verifies row counts against slice 0's snapshot. Idempotent
  (upsert on tracking_id).
- `app/track/review/route.ts` — click tracking redirect, same URL shape
  (`/track/review?id=<uuid>`), marks clicked + redirects to the county's Google review
  URL. Middleware matcher: exclude `track/review`.

Verify: every imported `tracking_id` resolves; click a test link end-to-end; row counts
match.

### Slice 4 — Review workflow on LT rails ⚠️ (sends real SMS/email)

Build:
- `app/api/webhook/review_request/route.ts` — HCP invoice.paid intake. Same filters
  (job type "tree service" only, SKIP_TAGS, invoice+phone dedupe, 30-day pending window,
  county from city/zip). **Additions:** resolve customer → contact;
  skip when `contacts.sms_opted_out_at` is set; skip when the synced customer's
  `do_not_service IS TRUE` (tags-only filtering is the newsletter bug shape — the flag
  itself was never checked here). Marketing suppression stays a separate control and
  applies; this does not touch the Chloe-never-sees-it rule, which is about the voice
  agent only.
- `lib/reviews/workflow.ts` — the 1min SMS → 24h email → +2d SMS sequence, reading
  delays/copy from the ported logic; per-step attempt counts persisted on the row; each
  step re-checks `clicked` before sending (same as today).
- Outbound sends via a small `lib/messaging/outreach.ts`: consent gate (contact-level),
  send from the designated outreach number, **record the message on the contact's thread**
  so replies land in the inbox with full history instead of a bare email forward. Email
  step via `lib/email/sendgrid.ts` from justin@ (same copy).
- Cron: add `review-workflow` to `scripts/cron.ts` (`*/5 * * * *`) and the `[job]` route,
  wrapped in `withSyncRun` (one-run-at-a-time by construction).

Cutover — **hard, ordered, never parallel** (this is the double-send scenario the old
`.env.example` warns about):
1. Set `ENABLE_REVIEW_WORKFLOW=false` on the old Railway service (its intake webhook
   keeps accepting invoice.paid; sends stop).
2. Re-run the import script to pick up rows created since slice 3.
3. Repoint the HCP webhook to the LT domain.
4. Enable the `review-workflow` cron job.
Gap behavior is benign: requests created during the minutes between 1 and 4 just send a
little late — elapsed-time steps self-heal, exactly like today's restart behavior.

Verify: seed one synthetic review_request for a test phone; watch all three steps fire on
schedule from the right number; reply STOP mid-sequence and confirm the remaining steps
are blocked and the thread shows the opt-out.

### Slice 5 — Website + Facebook lead unification

Build:
- `app/api/webhook/website_lead/route.ts` — `X-Webhook-Secret` check
  (`WEBSITE_LEAD_SECRET` via env.ts), 10-minute phone dedupe, then: resolve contact,
  **link to the form_submission lead `track.js` captured seconds earlier** (same
  phone/email, short window) instead of creating a parallel record, create HCP
  customer+estimate, stamp the lead's `hcp_estimate_id`. Web-form estimates become
  deterministically attributed — this is the path where the same-second timestamp
  collision lived.
- Facebook: extend `lib/facebook/ingest.ts` with a post-ingest HCP write for
  **non-excluded** campaigns only (`created` results; `excluded`/`deferred`/`duplicate`
  never write). Keep a `/api/webhook/facebook_leads` compat route delegating to the same
  ingest so the Meta subscription can move whenever convenient — the 15-min poller
  already backstops both apps.

Cutover: repoint the website form target; move (or leave, until slice 6) the Meta
subscription. Verify with one real form submission and one FB test lead
(`created` → HCP estimate exists, lead linked; a recruiting-form submission → no HCP
write).

### Slice 6 — Domain move + retirement

1. Add `automations.arbor-mgmt.com` to the LT `web` service; remove from the old
   service; update the DNS CNAME (TTL pre-lowered in slice 0). The only traffic still on
   the legacy hostname is `retell_inbound` (fails safe) and `/track/review` clicks.
2. Update the inbound webhook URL on +16185911316 in the Retell dashboard to the LT
   canonical domain (manual, dashboard-only). Verify with `retell_list_calls` →
   `retell_llm_dynamic_variables` on the next real call — the only check that closes the
   loop.
3. Watch one quiet week: `/api/diagnostics` clean, Twilio Monitor Alerts zero
   11200/15003, review sequence firing, call summaries arriving, estimates linking.
4. Scale the old Railway app service to zero (don't delete for a month). Final pg_dump
   to Drive, then the whole "Arbor Automations" Railway project — app service **and the
   Postgres 16 database** — is deleted after the quiet month; the Drive dump is the
   permanent archive. Archive the `Arbor-Automations` repo with a README pointer here.
5. Update `arbor-general/CLAUDE.md`: the Retell webhook section, the "where it should
   live" note (the answer is now this app), and the Infrastructure section.

## New env on the LT `web` service

`SENDGRID_API_KEY`, `SENDGRID_FROM_EMAIL`, `SENDGRID_FROM_NAME`, `ALERT_EMAIL_TO`,
`WEBSITE_LEAD_SECRET`, and — if the Meta apps differ (slice 0) — the Automations
`META_APP_SECRET`/`META_WEBHOOK_VERIFY_TOKEN`/`META_PAGE_ACCESS_TOKEN` under LT's
`FACEBOOK_*` names. All added to `lib/env.ts`; nothing reads `process.env` directly.

## Risks and accepted trade-offs

- **Deploy cadence now touches Chloe's inbound webhook.** Accepted: Railway health-checked
  deploys are zero-downtime, Retell retries 3×/10s, and the fail-safe is
  v110's defaults (UNAVAILABLE — wrong-closed captures the lead; wrong-open wakes on-call,
  which is why the fail-safe points the way it does). Same exposure class as `/voice`,
  which LT already carries.
- **Consent enforcement will block some review texts** to contacts who previously texted
  STOP to any tracking number. That is correct behavior, not a regression — but the
  first week's send count may dip slightly.
- **`do_not_service` gate is new on reviews.** A handful of customers who used to get
  review requests won't. Intentional.
- **The caller-context sentence generator moves.** Any Retell simulation work after
  slice 1 must generate injected strings from `lib/retell/*` here, not from
  Arbor-Automations. Update the CLAUDE.md note the moment slice 1 merges, or a future
  session runs the old source.
- **Local-mirror staleness on caller lookup**: up to ~1h behind HCP for brand-new
  customers. A brand-new customer calling back within the hour reads as unknown —
  today's behavior for any HCP timeout, and strictly better on average. (The
  estimate-webhook path double-checks live before *creating*, where staleness would
  actually cost something.)
- **Two Postgres databases during slices 2–5.** Bounded by the hard-cutover rules above;
  the only table where split-brain could hurt (review_requests) is governed by the
  ENABLE flag ordering in slice 4.

## Explicitly out of scope

- Re-anchoring or changing any ROI/attribution definition (the `Estimate Created`
  double-counting decision is a separate open item and is unaffected — conversion actions
  and the exporter don't move).
- Chloe prompt changes beyond repointing tool/webhook URLs (each of those follows the
  standing Retell draft→simulate→approve→publish process as its own decision).
- The MCP servers (Arbor MCP and LT's own `/api/mcp`) — untouched.
- Building a review-requests dashboard surface (later, if wanted; the data will be in
  the LT DB either way).

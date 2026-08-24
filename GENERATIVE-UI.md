# Generative UI: replacing the dashboard with an MCP tool layer

**Status: Phases 0–1 and 3 BUILT (2026-08-24).** `lib/queries/` +
`lib/api-contracts/` exist and every dashboard page reads through them;
`/api/mcp` serves the full 15-tool catalog behind `MCP_API_TOKEN` — 11 reads
(annotated `readOnlyHint`) plus the four Phase 3 writes (`reply_to_thread`,
`set_thread_state`, `classify_lead`, `trigger_sync`), each wrapping the same
lib function its route uses. (mcp-handler v1 + MCP SDK 1.26 — pinned because
SDK v2 requires zod 4 and the app is on zod 3 via t3-env; revisit when t3-env
moves.) **⚠️ With reply_to_thread present, `MCP_API_TOKEN` can text customers**
— the reply ROUTE stays session-only, but the token is no longer a read-only
credential; guard it like one that spends money. To go live: set
`MCP_API_TOKEN` (≥24 chars) on the Railway `web` service, deploy, then add a
claude.ai custom connector pointing at `https://<app>/api/mcp` with that bearer
token. Verified locally: handshake + tools/list (15 tools, annotations
correct); no token or wrong token never reaches a tool; a session cookie alone
does not authorize. Next: Phase 2 — live with it.

Plan of record (2026-08-23, Justin). Goal: stop maintaining fixed dashboard pages and
work with the data through generative interfaces — Claude chat/artifacts first, a
CopilotKit/AG-UI surface later. The app keeps everything that is not UI: webhooks, DNI,
`track.js`, cron, sync, exports. What changes is who draws the read surfaces.

Decisions already made in reaching this plan:

- **MCP-tools-first, no owned frontend for now.** Claude (chat, artifacts, Claude Code)
  is the client. A CopilotKit/AG-UI app is an expected later phase and consumes the
  same endpoint; nothing here is throwaway for that future.
- **No Supabase migration.** The database stays where it is. The blocker for generative
  UI is the tool layer, not database reachability — and the private-network Postgres
  plus `/api/twilio/voice`'s <3s budget both argue for keeping the DB next to the app.
  Revisit only when a live-push surface (realtime inbox) is actually being built.
- **Tools are semantic, never raw SQL.** Every metric trap this codebase documents
  (`work_status` is not the test for won, `businessDate()` bucketing, campaign
  exclusions, `countableEstimateDate` windowing, `none` as a real filter value) must be
  encoded once, server-side, behind the tool boundary. A generic query tool would
  re-commit those traps silently per generated view.

## Does the business logic need to move into the database?

**No — and the codebase already settled the question.** The load-bearing predicates
*execute* in the database but *live* in the repo, as shared Drizzle SQL fragments:
`isCountableEstimate` / `isCancelledEstimate` / `isDeletedEstimate` /
`countableEstimateDate` (`lib/estimates/countable.ts`) and `landingPathSql`
(`lib/landing-page.ts`) are `SQL` expressions that push down into any query that
composes them. That pattern already delivers everything a database view would —
push-down into WHERE/GROUP BY, one definition every consumer shares — without the
drawback views add: a definition that deploys by migration instead of with the code,
so code and database can disagree about what "countable" means during and after a
deploy.

The existing rule, made explicit:

- Logic must be a **shared SQL fragment** when queries filter, group, or aggregate by
  it (countability, landing path). Both surfaces and tools compose the fragment.
- Logic may stay a **TypeScript function** when it is applied at write time or to rows
  already fetched (`businessDate()` stamps `roi_daily` at sync; `isQualifiedLead`
  gates inbox triage).

Database views/functions would only become necessary if consumers bypassed the app and
ran raw SQL — which is precisely what the MCP boundary exists to prevent. So: nothing
moves. New tools import the same fragments the pages use.

## Architecture

```
Claude chat / artifacts / Claude Code        (now)
CopilotKit + AG-UI agent runtime             (later, same door)
        │  streamable HTTP MCP, Authorization: Bearer <MCP_API_TOKEN>
        ▼
app/api/mcp/route.ts        ← MCP server (stateless), tool registry
        ▼
lib/queries/*               ← extracted, shared query layer (Phase 0)
        ▼
lib/estimates/countable.ts · lib/campaigns.ts · lib/landing-page.ts · lib/tz.ts
        ▼
Postgres (unchanged, private network)
```

The middleware already passes `/api/*` requests carrying a Bearer header through to
their handlers (see `middleware.ts`), and `lib/admin-auth.ts` establishes the pattern:
token auth off entirely unless the env var is set, timing-safe compare, routes opt in
individually. The MCP route follows it with its **own** token (`MCP_API_TOKEN`, via
`lib/env.ts`) rather than reusing `ADMIN_API_TOKEN`, so read-mostly generative access
is revocable independently of the riskier admin routes.

## Phase 0 — extract the query layer (no behavior change)

The dashboard pages currently query inline (`app/(dashboard)/*/page.tsx` and the
`/sources` view components each hit `db` directly). Tools must not duplicate those
queries — duplication is how two surfaces disagree.

1. Create `lib/queries/` and move each surface's reads into named functions:
   - `overview.ts` — the `/` funnel + topline.
   - `estimates.ts` — list + grouped rollups; owns the `filters.ts` semantics
     (including `none`) and `estimates/view.ts` dims.
   - `sources.ts` — channel/campaign views (`roi_daily`, business-date window) and
     page view (`web_sessions` + `leads`, raw-timestamp window) — deliberately two
     functions; their windows differ and must stay different.
   - `inbox.ts` — thread list (channel tabs filter on `conversations.channels`) and
     thread timeline (union of calls / messages / form_submissions / facebook_leads).
   - Reuse what already exists rather than moving it: `/api/leads`' filter logic,
     `sources/drilldown.ts`, `lib/diagnostics/attribution.ts`.
2. Pages import from `lib/queries/` and render; nothing else changes. This is the
   refactor that guarantees a generated dashboard and the old page show the same
   number for as long as both exist.
3. Create `lib/api-contracts/` — zod schemas for every tool's input **and output**.
   Outputs are typed JSON (integer cents, E.164, ISO dates), never prose. These output
   types are the props contracts a future CopilotKit component catalog imports, which
   is what keeps that future build-error-safe instead of blank-screen-safe.

Client-safe rule (same trap as `lib/messaging/channels.ts`): contracts import nothing
that drags node-postgres toward a browser bundle.

## Phase 1 — the MCP endpoint, read-only catalog

Add `@modelcontextprotocol/sdk`. Serve at `app/api/mcp/route.ts`: streamable HTTP,
stateless mode (fits route handlers; no session affinity on Railway), auth as above.

Catalog v1 — intent-named, descriptions carry the traps so the model cannot misuse
what the types allow:

| Tool | Wraps | Notes |
|---|---|---|
| `roi_summary({days, grain})` | `queries/sources` channel/campaign | `roi_daily`, exclusions applied, business-date window. |
| `list_estimates({source?, campaign?, page?, location?, type?, stage?, days, group_by?})` | `queries/estimates` | `isCountableEstimate` / `isLiveEstimate` split preserved; `none` accepted on every filter; windows on `countableEstimateDate`. |
| `estimate_detail({id})` | estimate + linked lead/contact/thread | Names read through the HCP join, never copied. |
| `landing_pages({days})` | `queries/sources` page view | Rate needs non-converting visitors; separate window semantics stated in the description. |
| `source_drilldown({source?, campaign?, page?, days})` | `sources/drilldown.ts` | The `/sources` → `/estimates` join, both directions. |
| `list_threads({channel?, q?, days})` | `queries/inbox` | Contact-centric; recruiting enquiries present by design. |
| `get_thread({id})` | `queries/inbox` | Full timeline incl. transcripts, consent state, `last_endpoint_key`. |
| `list_leads({q?, type?, status?, is_spam?, has_click_id?})` | `/api/leads` Query | Already exists; port, don't fork. |
| `spend_summary({days, platform?})` | `ad_spend` | Excluded campaigns' spend visible but flagged, per the read-time-exclusion rule. |
| `funnel_overview({days})` | `queries/overview` | The `/` page. |
| `diagnostics({section?})` | `/api/diagnostics` + `/attribution` | Read-only; the "is the machine healthy" tool. |

Deliberately absent from v1: a raw SQL tool. If exploration demands one later, it gets
a read-only DB role, row caps, and a description marking its output non-canonical.

Guardrails: every list tool paginates with a hard row cap; responses stay well under
client context budgets; the endpoint is authed so it adds no public write surface;
`export const runtime = "nodejs"`.

Verification: MCP Inspector against local dev; a test asserting tool output equals
the page query's result on the same seeded data (they share `lib/queries`, so this
guards the extraction, then becomes the page-retirement safety net); confirm a
tokenless request 401s and a session cookie alone does not authorize the endpoint.

## Phase 2 — connect and live with it

Add the endpoint as a claude.ai custom connector (streamable HTTP + bearer token);
the same URL serves Claude Desktop and Claude Code. Then use it for real questions
for a few weeks. Build one or two persistent artifact dashboards (overview, sources)
generated from these tools. The dashboard pages keep running — they cost nothing and
are the comparison baseline.

Exit criterion: reaching for `/sources` or `/` out of habit has actually stopped.

## Phase 3 — write tools (small, each mirroring an existing route)

| Tool | Mirrors | Gate |
|---|---|---|
| `reply_to_thread({thread_id, body})` | `/api/inbox/[id]/reply` | Consent enforced in `lib/messaging/send.ts` (opt-out blocks the send server-side — never delegated to the model); replies from `last_endpoint_key`. |
| `set_thread_state({thread_id, state})` | `/api/inbox/[id]/state` | |
| `classify_lead({lead_id, is_lead})` | `/api/leads/[id]/classify` | The Lead/Not toggle. |
| `trigger_sync({job})` | `/api/sync/[job]` | Passes no `sinceDays` — each job owns its window policy; `withSyncRun` already serializes. |

No tool for buying numbers, editing routing, or credentials in this phase — those are
rare, riskier, and the settings pages (or admin routes) still exist. Mark write tools
with MCP annotations (`destructiveHint` etc.) so clients confirm appropriately.

## Phase 4 — retire pages by observed disuse

Order: settings read surfaces → `/sources` and `/` (once artifact dashboards have
replaced the habit) → `/estimates` → `/inbox` **last, possibly never**: it is the one
live, interactive, push-shaped surface, and pull-based generative UI replaces it worst.
The text-relay number covers real-time notification; `reply_to_thread` covers response.
Judge disuse honestly (a page nobody opened in a month), delete the page, keep the
query function — the tools still use it. `/login` and the session cookie go only when
the last page does.

## Phase 5 — the CopilotKit/AG-UI future (out of scope, kept aligned)

When a hosted generative surface is wanted (office staff, live inbox, shared state):

- The agent runtime points at this same MCP endpoint. The agent stays thin —
  orchestration and rendering only; queries and invariants stay behind the boundary.
  The private-network Postgres enforces this: an externally hosted runtime has no
  other door.
- The component catalog's props types import from `lib/api-contracts/`.
- Realtime push (live inbox) is decided then — AG-UI's own stream, or a change feed;
  that is also the point at which the Supabase question may be reopened, weighed
  against keeping `/voice` on a private network.

## Risks and watch-outs

- **Endpoint auth is the whole wall.** `MCP_API_TOKEN` unset ⇒ endpoint off (same
  fail-closed shape as `ADMIN_API_TOKEN`). Rotation is an env change; never a DB row.
- **Token budget.** ~15 tools ≈ a few thousand tokens of schema per turn — fine.
  Growth pressure goes into filter parameters on existing tools, not new near-duplicate
  tools ("pie chart vs donut chart" selection errors apply to tools too).
- **Two windows will not reconcile at edges** (business-date vs raw-timestamp — the
  existing `/sources` caveat). Tool descriptions state which window they use, so a
  generated view that mixes them is a caught mistake, not a silent one.
- **Cost surfaces:** each generated dashboard is model tokens instead of a cached page
  render. Acceptable for one user; worth rechecking if staff start using it daily
  (that is also the Phase 5 trigger).
- **Do not** point a generic DB MCP server at the database as a shortcut — it bypasses
  every predicate above. That is the failure mode this plan exists to avoid.

ALTER TABLE "hcp_customers" ADD COLUMN "company" text;--> statement-breakpoint
ALTER TABLE "hcp_customers" ADD COLUMN "notifications_enabled" boolean;--> statement-breakpoint
ALTER TABLE "hcp_customers" ADD COLUMN "lead_source_raw" text;--> statement-breakpoint
ALTER TABLE "hcp_customers" ADD COLUMN "notes" text;--> statement-breakpoint
ALTER TABLE "hcp_customers" ADD COLUMN "kind" text;--> statement-breakpoint
ALTER TABLE "hcp_customers" ADD COLUMN "tags" text[];--> statement-breakpoint
ALTER TABLE "hcp_customers" ADD COLUMN "do_not_service" boolean;--> statement-breakpoint
ALTER TABLE "hcp_estimates" ADD COLUMN "scheduled_end_hcp" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "hcp_estimates" ADD COLUMN "arrival_window_minutes" integer;--> statement-breakpoint
ALTER TABLE "hcp_estimates" ADD COLUMN "on_my_way_at_hcp" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "hcp_estimates" ADD COLUMN "started_at_hcp" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "hcp_estimates" ADD COLUMN "completed_at_hcp" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "hcp_estimates" ADD COLUMN "assigned_route_template_id" text;--> statement-breakpoint
ALTER TABLE "hcp_invoices" ADD COLUMN "due_concept" text;--> statement-breakpoint
ALTER TABLE "hcp_invoices" ADD COLUMN "display_due_concept" text;--> statement-breakpoint
ALTER TABLE "hcp_jobs" ADD COLUMN "on_my_way_at_hcp" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "hcp_jobs" ADD COLUMN "started_at_hcp" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "hcp_jobs" ADD COLUMN "scheduled_end" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "hcp_jobs" ADD COLUMN "arrival_window_minutes" integer;--> statement-breakpoint
ALTER TABLE "hcp_jobs" ADD COLUMN "appointments" jsonb;--> statement-breakpoint
ALTER TABLE "hcp_jobs" ADD COLUMN "notes" text;--> statement-breakpoint
ALTER TABLE "hcp_jobs" ADD COLUMN "job_type_id" text;--> statement-breakpoint
ALTER TABLE "hcp_jobs" ADD COLUMN "business_unit" text;--> statement-breakpoint
ALTER TABLE "hcp_jobs" ADD COLUMN "locked_at_hcp" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "hcp_jobs" ADD COLUMN "assigned_route_template_id" text;--> statement-breakpoint
ALTER TABLE "hcp_jobs" ADD COLUMN "recurrence_number" integer;--> statement-breakpoint
ALTER TABLE "hcp_jobs" ADD COLUMN "recurrence_rule" jsonb;--> statement-breakpoint
ALTER TABLE "hcp_jobs" ADD COLUMN "recurrence_status" text;--> statement-breakpoint
ALTER TABLE "hcp_jobs" ADD COLUMN "recurrence_id" text;--> statement-breakpoint
CREATE INDEX "hcp_customers_do_not_service_idx" ON "hcp_customers" USING btree ("do_not_service");--> statement-breakpoint
CREATE INDEX "hcp_jobs_started_hcp_idx" ON "hcp_jobs" USING btree ("started_at_hcp");--> statement-breakpoint
CREATE INDEX "hcp_jobs_recurrence_idx" ON "hcp_jobs" USING btree ("recurrence_id");--> statement-breakpoint
-- ── Backfill from `raw` ──────────────────────────────────────────────────────
-- Every column added above except `hcp_customers.do_not_service` and
-- `hcp_jobs.appointments` is already sitting in the stored payload: the sync has
-- always kept the full HCP response in `raw`, it just never projected these out.
-- So this is a backfill, not a re-sync, and the history fills in immediately
-- rather than waiting for a crawl lap.
--
-- The two exceptions are genuinely absent from `raw`, because HCP only returns
-- them when the request asks for them (`expand[]=do_not_service`,
-- `expand[]=appointments`). Those populate as the sync re-reads each row with the
-- expand now in place. `do_not_service` stays NULL = UNKNOWN until then, which is
-- the correct reading — never "safe to contact".
UPDATE "hcp_jobs" SET
  "on_my_way_at_hcp" = nullif(raw->'work_timestamps'->>'on_my_way_at', '')::timestamptz,
  "started_at_hcp" = nullif(raw->'work_timestamps'->>'started_at', '')::timestamptz,
  "scheduled_end" = nullif(raw->'schedule'->>'scheduled_end', '')::timestamptz,
  "arrival_window_minutes" = CASE
    WHEN jsonb_typeof(raw->'schedule'->'arrival_window') = 'number'
    THEN (raw->'schedule'->>'arrival_window')::int END,
  "notes" = nullif(raw->>'notes', ''),
  "job_type_id" = raw->'job_fields'->'job_type'->>'id',
  "business_unit" = raw->'job_fields'->>'business_unit',
  "locked_at_hcp" = nullif(raw->>'locked_at', '')::timestamptz,
  "assigned_route_template_id" = raw->>'assigned_route_template_id',
  "recurrence_number" = CASE
    WHEN jsonb_typeof(raw->'recurrence_number') = 'number' THEN (raw->>'recurrence_number')::int END,
  "recurrence_rule" = CASE WHEN raw->'recurrence_rule' = 'null'::jsonb THEN NULL ELSE raw->'recurrence_rule' END,
  "recurrence_status" = raw->>'recurrence_status',
  "recurrence_id" = raw->>'recurrence_id'
WHERE raw IS NOT NULL;
--> statement-breakpoint
UPDATE "hcp_customers" SET
  "company" = nullif(raw->>'company', ''),
  "notifications_enabled" = CASE
    WHEN jsonb_typeof(raw->'notifications_enabled') = 'boolean'
    THEN (raw->>'notifications_enabled')::boolean END,
  "lead_source_raw" = nullif(raw->>'lead_source', ''),
  "notes" = nullif(raw->>'notes', ''),
  "kind" = nullif(raw->>'kind', ''),
  "tags" = CASE WHEN jsonb_typeof(raw->'tags') = 'array'
    THEN ARRAY(SELECT jsonb_array_elements_text(raw->'tags')) END
WHERE raw IS NOT NULL;
--> statement-breakpoint
UPDATE "hcp_invoices" SET
  "due_concept" = nullif(raw->>'due_concept', ''),
  "display_due_concept" = nullif(raw->>'display_due_concept', '')
WHERE raw IS NOT NULL;
--> statement-breakpoint
UPDATE "hcp_estimates" SET
  "scheduled_end_hcp" = nullif(raw->'schedule'->>'scheduled_end', '')::timestamptz,
  "arrival_window_minutes" = CASE
    WHEN jsonb_typeof(raw->'schedule'->'arrival_window') = 'number'
    THEN (raw->'schedule'->>'arrival_window')::int END,
  "on_my_way_at_hcp" = nullif(raw->'work_timestamps'->>'on_my_way_at', '')::timestamptz,
  "started_at_hcp" = nullif(raw->'work_timestamps'->>'started_at', '')::timestamptz,
  "completed_at_hcp" = nullif(raw->'work_timestamps'->>'completed_at', '')::timestamptz,
  "assigned_route_template_id" = raw->>'assigned_route_template_id'
WHERE raw IS NOT NULL;

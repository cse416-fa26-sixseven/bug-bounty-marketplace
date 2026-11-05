-- Auditor-reported findings (US5): an auditor holding a contract's claim can
-- report a finding Slither missed, together with its PoC
-- (POST /api/auditor/findings).
--   source                 'slither' (worker) or 'auditor'.
--   title                  the auditor's short title; NULL for Slither findings.
--   reported_by_auditor_id the reporting auditor; NULL for Slither findings.
-- An auditor finding keeps the NOT NULL Slither columns filled:
-- slither_detector = 'auditor-reported', slither_confidence = 'n/a',
-- raw_output = the submitted report, llm_explanation = the auditor's
-- description, explanation_source = 'auditor'.
--
-- Re-runs on every boot, so each ALTER is guarded by a catalog check (see the
-- note in 0002 on ACCESS EXCLUSIVE locks).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = 'findings'
       AND column_name = 'source'
  ) THEN
    ALTER TABLE findings
      ADD COLUMN source TEXT NOT NULL DEFAULT 'slither'
        CONSTRAINT findings_source_check CHECK (source IN ('slither', 'auditor')),
      ADD COLUMN title TEXT,
      ADD COLUMN reported_by_auditor_id TEXT,
      ADD CONSTRAINT findings_auditor_origin_check CHECK (
        source = 'slither' OR (title IS NOT NULL AND reported_by_auditor_id IS NOT NULL));
  END IF;
  -- explanation_source gains 'auditor'. The inline CHECK from 0002 is named
  -- findings_explanation_source_check by Postgres.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'findings_explanation_source_origin_check'
       AND conrelid = 'findings'::regclass
  ) THEN
    ALTER TABLE findings
      DROP CONSTRAINT IF EXISTS findings_explanation_source_check,
      ADD CONSTRAINT findings_explanation_source_origin_check
        CHECK (explanation_source IN ('llm', 'slither', 'auditor'));
  END IF;
END
$$;

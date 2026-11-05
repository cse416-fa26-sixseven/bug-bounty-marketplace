-- When the arbiter's ruling window closes, copied from DisputeResolution when
-- the dispute is recorded. The payout keeper lapses Pending disputes past it,
-- so a dispute the arbiter never rules on does not freeze the payout forever.
-- NULL for disputes recorded before this column; the keeper reads those from
-- the chain and fills it in. Guarded by a catalog check like 0005: ALTER TABLE
-- takes an ACCESS EXCLUSIVE lock even when the column already exists.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = 'disputes'
       AND column_name = 'rule_by'
  ) THEN
    ALTER TABLE disputes ADD COLUMN rule_by TIMESTAMPTZ;
  END IF;
END
$$;

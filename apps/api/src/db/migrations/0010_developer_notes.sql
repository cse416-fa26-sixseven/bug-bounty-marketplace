-- Developer notes on findings (R16). Written only by the contract's developer
-- through PUT /api/findings/:id/note; both columns are NULL when there is no
-- note. Re-runs on every boot, so the ALTER is guarded by a catalog check
-- (see the note in 0002 on ACCESS EXCLUSIVE locks).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = 'findings'
       AND column_name = 'developer_note'
  ) THEN
    ALTER TABLE findings
      ADD COLUMN developer_note TEXT,
      ADD COLUMN developer_note_updated_at TIMESTAMPTZ,
      ADD CONSTRAINT findings_developer_note_check
        CHECK ((developer_note IS NULL) = (developer_note_updated_at IS NULL));
  END IF;
END
$$;

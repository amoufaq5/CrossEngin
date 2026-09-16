-- Apply with the migration role; never with the API role. Safe on existing installations.
ALTER TABLE meta.operate_design_jobs ADD COLUMN IF NOT EXISTS lease_token UUID;
ALTER TABLE meta.operate_design_jobs ADD COLUMN IF NOT EXISTS lease_until TIMESTAMPTZ;
ALTER TABLE meta.operate_design_jobs ADD COLUMN IF NOT EXISTS run_count INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_design_jobs_claim ON meta.operate_design_jobs (tenant_id, status, lease_until, created_at);
-- Duplicate entry numbers require operator reconciliation; the migration intentionally fails if found.
CREATE UNIQUE INDEX IF NOT EXISTS operate_journal_posting_identity
  ON meta.operate_entity_records (tenant_id, (document->>'entry_number'))
  WHERE entity = 'JournalEntry' AND document->>'entry_number' IS NOT NULL;

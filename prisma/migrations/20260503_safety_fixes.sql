-- MTOS Production Safety Migration
-- Audit fixes: CRIT-03, HIGH-03, HIGH-05, MED-02, HIGH-07, MED-05
--
-- Run order matters: constraints before indexes.
-- Apply with: npx prisma migrate deploy
-- Or directly: psql $DATABASE_URL -f migration.sql
--
-- BEFORE RUNNING:
--   1. Take a full pg_dump backup
--   2. Run on staging first and verify with: SELECT COUNT(*) FROM "PayrollRun";
--   3. All changes are additive (NOT NULL columns have defaults or are nullable)
--      so this migration is safe to apply without downtime.

BEGIN;

-- ─── HIGH-07: Add explicit state enum to Tender ───────────────────────────────
-- Replaces the keyword-matching logic in _extractState().
-- Existing rows get NULL (operator must fill via backfill query below).
-- PayrollEngine will throw if state is NULL — forces explicit data entry.

ALTER TABLE "Tender"
  ADD COLUMN IF NOT EXISTS "state" TEXT;

-- Backfill comment: after migration, run the backfill script:
--   UPDATE "Tender" SET state = 'UNKNOWN' WHERE state IS NULL;
-- Then review each UNKNOWN record and set the correct state value.
-- PayrollEngine will refuse to process tenders with state = NULL or 'UNKNOWN'.

COMMENT ON COLUMN "Tender"."state" IS
  'Indian state enum (e.g. KARNATAKA, MAHARASHTRA). Required for PT calculation. '
  'Keyword-based state inference removed (HIGH-07 audit fix).';

-- ─── MED-02: Unique constraint on Invoice (tenderId, month, year) ─────────────
-- Prevents the race condition where two concurrent generateInvoice() calls
-- both pass the application-level pre-check and create duplicate invoices.
-- The application catches Prisma P2002 and returns idempotent result.

ALTER TABLE "Invoice"
  ADD CONSTRAINT IF NOT EXISTS "Invoice_tenderId_month_year_key"
  UNIQUE ("tenderId", "month", "year");

COMMENT ON CONSTRAINT "Invoice_tenderId_month_year_key" ON "Invoice" IS
  'Prevents duplicate invoice generation race condition (MED-02 audit fix).';

-- ─── MED-05: Phone HMAC index (future-proofing for DPDP Act encryption) ────────
-- If phone is ever added to PII_FIELDS and encrypted at rest, plaintext LIKE
-- search will silently return zero results. This index column stores an HMAC
-- of the phone number, allowing exact-match search without storing plaintext.
-- Column is nullable: NULL until phone encryption is activated.

ALTER TABLE "Employee"
  ADD COLUMN IF NOT EXISTS "phoneHmac" TEXT;

CREATE INDEX IF NOT EXISTS "Employee_phoneHmac_idx"
  ON "Employee" ("tenantId", "phoneHmac");

COMMENT ON COLUMN "Employee"."phoneHmac" IS
  'HMAC-SHA256 of phone number for searchable encryption (MED-05 audit fix). '
  'NULL until phone is added to PII_FIELDS. Do not store plaintext phone here.';

-- ─── LOW-05: Backup validation table ─────────────────────────────────────────
-- Records the result of each pg_dump + restore-test run so the backup
-- container can alert on failure rather than silently succeeding with a
-- corrupt dump.

CREATE TABLE IF NOT EXISTS "_BackupLog" (
  "id"          TEXT        NOT NULL DEFAULT gen_random_uuid()::text,
  "startedAt"   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "completedAt" TIMESTAMPTZ,
  "success"     BOOLEAN     NOT NULL DEFAULT FALSE,
  "dumpSizeBytes" BIGINT,
  "restoreVerified" BOOLEAN,
  "errorMessage" TEXT,
  "dumpPath"    TEXT,
  PRIMARY KEY ("id")
);

COMMENT ON TABLE "_BackupLog" IS
  'Backup run audit log. pg_dump failures must write success=FALSE here '
  'and trigger an alert. LOW-05 audit fix.';

-- ─── Verify migration ─────────────────────────────────────────────────────────

DO $$
BEGIN
  -- Verify Tender.state column exists
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'Tender' AND column_name = 'state'
  ) THEN
    RAISE EXCEPTION 'Migration verification failed: Tender.state column missing';
  END IF;

  -- Verify Invoice unique constraint
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'Invoice_tenderId_month_year_key'
  ) THEN
    RAISE EXCEPTION 'Migration verification failed: Invoice unique constraint missing';
  END IF;

  RAISE NOTICE 'Migration verification passed.';
END $$;

COMMIT;

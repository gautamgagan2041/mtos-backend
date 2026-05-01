-- ─── MTOS Schema v3.1 additions ──────────────────────────────────────────────
-- Additive migration only. All existing fields unchanged.
-- All new fields have defaults so no existing row breaks.
-- NOTE: All id/fk columns use TEXT to match Prisma's uuid-as-text convention.

-- Step 1: Create ComponentNature enum
CREATE TYPE "ComponentNature" AS ENUM (
  'EARNING',
  'DEDUCTION',
  'EMPLOYER_COST',
  'PROVISION',
  'TENDER_COST'
);

-- Step 2: Add nature to pay_components (default EARNING preserves all existing rows)
ALTER TABLE "pay_components"
  ADD COLUMN "nature" "ComponentNature" NOT NULL DEFAULT 'EARNING';

-- Step 3: Patch known statutory/deduction components to correct nature
UPDATE "pay_components" SET "nature" = 'DEDUCTION'
  WHERE "code" IN ('PF_EE','ESIC_EE','PT','LWF','TDS','PF','ESIC','ADVANCE','LOAN','LOAN_EMI');

UPDATE "pay_components" SET "nature" = 'PROVISION'
  WHERE "code" IN ('BONUS','LEAVE_ENCASH','FESTIVAL_BONUS');

UPDATE "pay_components" SET "nature" = 'TENDER_COST'
  WHERE "code" IN ('UNIFORM','WASHING');

-- Step 4: Add nature_override to salary_structure_components (nullable)
ALTER TABLE "salary_structure_components"
  ADD COLUMN "nature_override" "ComponentNature";

-- Step 5: Add provision + tender cost fields to payroll_rows (all default 0)
ALTER TABLE "payroll_rows"
  ADD COLUMN "bonus_provision"      DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "gratuity_provision"   DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "leave_wage_provision" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "uniform_cost"         DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "washing_cost"         DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "reliever_cost"        DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "total_employer_cost"  DOUBLE PRECISION NOT NULL DEFAULT 0;

-- Step 6: Add layered cost summary to payroll_runs (all default 0)
ALTER TABLE "payroll_runs"
  ADD COLUMN "total_provisions"      DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "total_tender_costs"    DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "total_employer_costs"  DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "total_cost_to_client"  DOUBLE PRECISION NOT NULL DEFAULT 0;

-- Step 7: Create tender_component_overrides table
-- Uses TEXT for all id/fk columns — matches Prisma uuid-as-text convention
CREATE TABLE "tender_component_overrides" (
  "id"                       TEXT NOT NULL,
  "tender_id"                TEXT NOT NULL,
  "salary_structure_comp_id" TEXT NOT NULL,
  "tenant_id"                TEXT NOT NULL,
  "is_enabled"               BOOLEAN,
  "value_override"           DOUBLE PRECISION,
  "formula_override"         TEXT,
  "notes"                    TEXT,
  "created_at"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "tender_component_overrides_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "tender_component_overrides_tender_id_fkey"
    FOREIGN KEY ("tender_id") REFERENCES "tenders"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "tender_component_overrides_salary_structure_comp_id_fkey"
    FOREIGN KEY ("salary_structure_comp_id") REFERENCES "salary_structure_components"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "tender_component_overrides_tender_id_salary_structure_comp_id_key"
    UNIQUE ("tender_id", "salary_structure_comp_id")
);

CREATE INDEX "idx_tco_tenant" ON "tender_component_overrides"("tenant_id");

// ─── MTOS Schema v3.1 additions ───────────────────────────────────────────────
// THIS IS AN ADDITIVE MIGRATION ONLY.
// All existing fields remain unchanged.
// New fields have defaults so no existing row breaks.
//
// Changes in this migration:
// 1. Add ComponentNature enum
// 2. Add `nature` field to PayComponent (default=EARNING — preserves all existing rows)
// 3. Add `nature` field to SalaryStructureComponent (nullable — inherits from component)
// 4. Add gratuity provision fields to PayrollRow
// 5. Add relieverAmount to PayrollRun
// 6. Add TenderComponentOverride model (per-tender rate/toggle overrides)
// 7. Add CostSheet model (layer-breakdown output per payroll run)

// ─── Add to schema.prisma ─────────────────────────────────────────────────────

// NEW ENUM — add alongside existing ComponentType and CalculationType
/*
enum ComponentNature {
  EARNING         // reaches employee bank account — on payslip
  DEDUCTION       // deducted from employee — on payslip
  EMPLOYER_COST   // paid to government — NOT on employee payslip
  PROVISION       // accrued liability — billed to client, paid to employee later
  TENDER_COST     // business cost — on client invoice only, never on payslip
}
*/

// ─── Changes to PayComponent model ────────────────────────────────────────────
/*
model PayComponent {
  // ... all existing fields unchanged ...

  // NEW FIELD — determines which output layer this component feeds
  // Default = EARNING so all existing components are unaffected
  nature       ComponentNature @default(EARNING)

  // ... rest of model unchanged ...
}
*/

// ─── Changes to SalaryStructureComponent model ────────────────────────────────
/*
model SalaryStructureComponent {
  // ... all existing fields unchanged ...

  // NEW FIELD — overrides component.nature for this specific structure
  // null = use the component's default nature
  natureOverride ComponentNature? @map("nature_override")

  // ... rest of model unchanged ...
}
*/

// ─── New model: TenderComponentOverride ───────────────────────────────────────
// Per-tender overrides for component rate and enabled state.
// This is the "component toggle per tender" feature.
// A row only exists when a tender deviates from the structure default.
// If no override row exists → use SalaryStructureComponent value.
/*
model TenderComponentOverride {
  id                     String   @id @default(uuid())
  tenderId               String   @map("tender_id")
  salaryStructureCompId  String   @map("salary_structure_comp_id")
  tenantId               String   @map("tenant_id")

  // null = use structure default, set to override
  isEnabled     Boolean? @map("is_enabled")
  valueOverride Float?   @map("value_override")
  formulaOverride String? @map("formula_override")
  notes         String?

  createdAt DateTime @default(now()) @map("created_at")
  updatedAt DateTime @updatedAt @map("updated_at")

  tender         Tender                   @relation(fields: [tenderId], references: [id])
  structureComp  SalaryStructureComponent @relation(fields: [salaryStructureCompId], references: [id])

  @@unique([tenderId, salaryStructureCompId])
  @@index([tenantId])
  @@map("tender_component_overrides")
}
*/

// ─── Changes to PayrollRow model ─────────────────────────────────────────────
// New provision + tender cost fields
// All default(0) so existing rows are unaffected
/*
model PayrollRow {
  // ... all existing fields unchanged ...

  // NEW PROVISION FIELDS — layer 3
  bonusProvision    Float @default(0) @map("bonus_provision")
  gratuityProvision Float @default(0) @map("gratuity_provision")
  leaveWageProvision Float @default(0) @map("leave_wage_provision")

  // NEW TENDER COST FIELDS — layer 4 (on cost sheet, not payslip)
  uniformCost       Float @default(0) @map("uniform_cost")
  washingCost       Float @default(0) @map("washing_cost")
  relieverCost      Float @default(0) @map("reliever_cost")

  // NEW EMPLOYER COST SUMMARY — layer 2 (was scattered, now explicit)
  totalEmployerCost Float @default(0) @map("total_employer_cost")

  // ... rest of model unchanged ...
}
*/

// ─── Changes to PayrollRun model ─────────────────────────────────────────────
/*
model PayrollRun {
  // ... all existing fields unchanged ...

  // NEW — layered summary for dashboard and reporting
  totalProvisions   Float @default(0) @map("total_provisions")
  totalTenderCosts  Float @default(0) @map("total_tender_costs")
  totalEmployerCosts Float @default(0) @map("total_employer_costs")
  totalCostToClient Float @default(0) @map("total_cost_to_client")

  // ... rest of model unchanged ...
}
*/

// ─── Migration SQL (run this as a Prisma migration) ──────────────────────────
// File: prisma/migrations/YYYYMMDD_v31_component_nature/migration.sql

const MIGRATION_SQL = `
-- Step 1: Create ComponentNature enum
CREATE TYPE "ComponentNature" AS ENUM (
  'EARNING',
  'DEDUCTION',
  'EMPLOYER_COST',
  'PROVISION',
  'TENDER_COST'
);

-- Step 2: Add nature to PayComponent
-- Default = EARNING preserves all existing rows
ALTER TABLE pay_components
  ADD COLUMN nature "ComponentNature" NOT NULL DEFAULT 'EARNING';

-- Step 3: Patch known statutory components to correct nature
UPDATE pay_components SET nature = 'DEDUCTION'
  WHERE code IN ('PF_EE', 'ESIC_EE', 'PT', 'LWF', 'TDS', 'PF', 'ESIC', 'ADVANCE', 'LOAN', 'LOAN_EMI');

UPDATE pay_components SET nature = 'PROVISION'
  WHERE code IN ('BONUS', 'LEAVE_ENCASH', 'FESTIVAL_BONUS');

UPDATE pay_components SET nature = 'TENDER_COST'
  WHERE code IN ('UNIFORM', 'WASHING');

-- Note: GRATUITY does not exist yet — it will be added via seed

-- Step 4: Add nature_override to SalaryStructureComponent (nullable)
ALTER TABLE salary_structure_components
  ADD COLUMN nature_override "ComponentNature";

-- Step 5: Add provision + tender cost fields to PayrollRow (all default 0)
ALTER TABLE payroll_rows
  ADD COLUMN bonus_provision DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN gratuity_provision DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN leave_wage_provision DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN uniform_cost DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN washing_cost DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN reliever_cost DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN total_employer_cost DOUBLE PRECISION NOT NULL DEFAULT 0;

-- Step 6: Add layered summary to PayrollRun (all default 0)
ALTER TABLE payroll_runs
  ADD COLUMN total_provisions DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN total_tender_costs DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN total_employer_costs DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN total_cost_to_client DOUBLE PRECISION NOT NULL DEFAULT 0;

-- Step 7: Create TenderComponentOverride table
CREATE TABLE tender_component_overrides (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tender_id                 UUID NOT NULL REFERENCES tenders(id) ON DELETE CASCADE,
  salary_structure_comp_id  UUID NOT NULL REFERENCES salary_structure_components(id) ON DELETE CASCADE,
  tenant_id                 UUID NOT NULL,
  is_enabled                BOOLEAN,
  value_override            DOUBLE PRECISION,
  formula_override          TEXT,
  notes                     TEXT,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tender_id, salary_structure_comp_id)
);

CREATE INDEX idx_tco_tenant ON tender_component_overrides(tenant_id);
`;

module.exports = { MIGRATION_SQL };

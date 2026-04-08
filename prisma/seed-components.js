'use strict';

// prisma/seed-tender-components.js
// ─────────────────────────────────────────────────────────────────────────────
// Seeds the NEW components introduced by the four-layer architecture.
// Run AFTER the v3.1 migration has been applied.
//
// SAFE: uses upsert — running this multiple times is idempotent.
// DOES NOT touch existing components.
//
// New components added:
//   GRATUITY     — 4.81% of BASIC+VDA, nature=PROVISION
//   LEAVE_WAGES  — 5.77% of BASIC+VDA, nature=PROVISION
//   RELIEVER     — (SUBTOTAL/6), nature=TENDER_COST
//   ESIC_ER      — 3.25% of gross, nature=EMPLOYER_COST
//   PF_ER        — 12% of PF wage, nature=EMPLOYER_COST
//   EDLI         — 0.5% of PF wage, nature=EMPLOYER_COST
//   PF_ADMIN     — 0.5% of PF wage, nature=EMPLOYER_COST
//
// Nature patches for existing components:
//   BONUS        → PROVISION  (was EARNING — billed to client, not always monthly pay)
//   UNIFORM      → TENDER_COST (was EARNING — not on employee payslip)
//   WASHING      → TENDER_COST (was EARNING — not on employee payslip)
//
// ⚠️ IMPORTANT: BONUS nature change is logged but NOT automatically applied.
// You must review which tenders pay bonus monthly vs annually before patching.

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// New components to add (nature field now exists after migration)
const NEW_COMPONENTS = [
  // ── Provisions ──────────────────────────────────────────────────────────────
  {
    code:        'GRATUITY',
    name:        'Gratuity Provision',
    type:        'EARNING',        // shown as "cost" line, not deduction
    nature:      'PROVISION',
    isStatutory: true,
    displayOrder: 19,
    description: '4.81% of Basic+VDA. Accrued monthly, payable after 5 years service.',
  },
  {
    code:        'LEAVE_WAGES',
    name:        'Leave Wages Provision',
    type:        'EARNING',
    nature:      'PROVISION',
    isStatutory: true,
    displayOrder: 20,
    description: '5.77% of Basic+VDA (15 days earned leave per year = 15/26/12 ≈ 4.8%). Varies by state shops act.',
  },

  // ── Tender Costs ─────────────────────────────────────────────────────────────
  {
    code:        'RELIEVER',
    name:        'Reliever Charges',
    type:        'EARNING',
    nature:      'TENDER_COST',
    isStatutory: false,
    displayOrder: 30,
    description: '1/6 of subtotal. Cost of relief employee for weekly offs. Never on payslip.',
  },

  // ── Employer Costs ────────────────────────────────────────────────────────────
  // Note: PF_ER, EDLI, PF_ADMIN are auto-calculated from pfEngine.
  // These components exist for display/reporting — values are overridden by engine.
  {
    code:        'ESIC_ER',
    name:        'ESIC Employer Contribution',
    type:        'EARNING',
    nature:      'EMPLOYER_COST',
    isStatutory: true,
    displayOrder: 31,
    description: '3.25% of gross salary (if ESIC applicable). Employer pays to ESIC, not employee.',
  },
  {
    code:        'PF_ER_DISPLAY',
    name:        'PF Employer Contribution',
    type:        'EARNING',
    nature:      'EMPLOYER_COST',
    isStatutory: true,
    displayOrder: 32,
    description: '12% of PF wage (3.67% EPF + 8.33% EPS). Display component — calculated by pfEngine.',
  },
  {
    code:        'EDLI_DISPLAY',
    name:        'EDLI Contribution',
    type:        'EARNING',
    nature:      'EMPLOYER_COST',
    isStatutory: true,
    displayOrder: 33,
    description: '0.5% of PF wage. Life insurance contribution. Display component — calculated by pfEngine.',
  },
  {
    code:        'PF_ADMIN_DISPLAY',
    name:        'PF Admin Charges',
    type:        'EARNING',
    nature:      'EMPLOYER_COST',
    isStatutory: true,
    displayOrder: 34,
    description: '0.5% of PF wage. EPF administration fee. Display component — calculated by pfEngine.',
  },
];

// Nature patches for existing components
// Key: component code, Value: new nature
// These change the REPORTING nature but not the calculation.
const NATURE_PATCHES = {
  // UNIFORM and WASHING are business costs, not employee earnings.
  // They appear on the client invoice, NOT on the employee payslip.
  'UNIFORM':  'TENDER_COST',
  'WASHING':  'TENDER_COST',

  // Statutory deductions — already correct type but add explicit nature
  'PF_EE':    'DEDUCTION',
  'ESIC_EE':  'DEDUCTION',
  'PT':       'DEDUCTION',
  'LWF':      'DEDUCTION',
  'TDS':      'DEDUCTION',
  'ADVANCE':  'DEDUCTION',
  'LOAN':     'DEDUCTION',
  'LOAN_EMI': 'DEDUCTION',

  // BONUS: nature=PROVISION.
  // ⚠️ WARNING: This does NOT change whether bonus is paid monthly or annually.
  // It only affects which layer bonus appears in on the cost sheet.
  // If your client pays bonus monthly (shows on payslip), leave BONUS as EARNING.
  // If your client provisions bonus and pays at year-end, set to PROVISION.
  // We set PROVISION here as default — override per-tender if needed.
  'BONUS':    'PROVISION',
};

async function main() {
  console.log('\nSeeding tender-grade components (v3.1)...\n');

  const tenants = await prisma.tenant.findMany({ select: { id: true, name: true } });
  if (!tenants.length) {
    console.error('No tenants found. Run seed.js first.');
    process.exit(1);
  }

  for (const tenant of tenants) {
    console.log(`\nTenant: ${tenant.name}`);

    // 1. Upsert new components
    for (const comp of NEW_COMPONENTS) {
      await prisma.payComponent.upsert({
        where:  { tenantId_code: { tenantId: tenant.id, code: comp.code } },
        update: {
          name:        comp.name,
          nature:      comp.nature,
          displayOrder: comp.displayOrder,
          description: comp.description,
          isActive:    true,
        },
        create: {
          tenantId:    tenant.id,
          code:        comp.code,
          name:        comp.name,
          type:        comp.type,
          nature:      comp.nature,
          isStatutory: comp.isStatutory,
          displayOrder: comp.displayOrder,
          description: comp.description,
          isActive:    true,
        },
      });
      console.log(`  + ${comp.code} (${comp.nature})`);
    }

    // 2. Patch natures on existing components
    for (const [code, nature] of Object.entries(NATURE_PATCHES)) {
      const result = await prisma.payComponent.updateMany({
        where: { tenantId: tenant.id, code },
        data:  { nature },
      });
      if (result.count > 0) {
        console.log(`  ~ ${code} → nature=${nature}`);
      }
    }
  }

  console.log('\nDone. Run payroll to see layered output.\n');
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());

/*
  Warnings:

  - You are about to alter the column `night_shifts` on the `attendance` table. The data in that column could be lost. The data in that column will be cast from `DoublePrecision` to `Decimal(14,2)`.
  - You are about to alter the column `ot_hours` on the `attendance` table. The data in that column could be lost. The data in that column will be cast from `DoublePrecision` to `Decimal(14,2)`.
  - You are about to alter the column `cgst_rate` on the `billing_configs` table. The data in that column could be lost. The data in that column will be cast from `DoublePrecision` to `Decimal(14,2)`.
  - You are about to alter the column `sgst_rate` on the `billing_configs` table. The data in that column could be lost. The data in that column will be cast from `DoublePrecision` to `Decimal(14,2)`.
  - You are about to alter the column `igst_rate` on the `billing_configs` table. The data in that column could be lost. The data in that column will be cast from `DoublePrecision` to `Decimal(14,2)`.
  - You are about to alter the column `service_charge_rate` on the `billing_configs` table. The data in that column could be lost. The data in that column will be cast from `DoublePrecision` to `Decimal(14,2)`.
  - You are about to alter the column `amount` on the `esic_filing_records` table. The data in that column could be lost. The data in that column will be cast from `DoublePrecision` to `Decimal(14,2)`.
  - You are about to alter the column `gross_at_start` on the `esic_periods` table. The data in that column could be lost. The data in that column will be cast from `DoublePrecision` to `Decimal(14,2)`.
  - You are about to alter the column `monthly_rate` on the `invoice_line_items` table. The data in that column could be lost. The data in that column will be cast from `DoublePrecision` to `Decimal(14,2)`.
  - You are about to alter the column `amount` on the `invoice_line_items` table. The data in that column could be lost. The data in that column will be cast from `DoublePrecision` to `Decimal(14,2)`.
  - You are about to alter the column `service_charge` on the `invoices` table. The data in that column could be lost. The data in that column will be cast from `DoublePrecision` to `Decimal(14,2)`.
  - You are about to alter the column `taxable_value` on the `invoices` table. The data in that column could be lost. The data in that column will be cast from `DoublePrecision` to `Decimal(14,2)`.
  - You are about to alter the column `cgst` on the `invoices` table. The data in that column could be lost. The data in that column will be cast from `DoublePrecision` to `Decimal(14,2)`.
  - You are about to alter the column `sgst` on the `invoices` table. The data in that column could be lost. The data in that column will be cast from `DoublePrecision` to `Decimal(14,2)`.
  - You are about to alter the column `grand_total` on the `invoices` table. The data in that column could be lost. The data in that column will be cast from `DoublePrecision` to `Decimal(14,2)`.
  - You are about to alter the column `paid_amount` on the `invoices` table. The data in that column could be lost. The data in that column will be cast from `DoublePrecision` to `Decimal(14,2)`.
  - You are about to alter the column `igst` on the `invoices` table. The data in that column could be lost. The data in that column will be cast from `DoublePrecision` to `Decimal(14,2)`.
  - You are about to alter the column `subtotal` on the `invoices` table. The data in that column could be lost. The data in that column will be cast from `DoublePrecision` to `Decimal(14,2)`.
  - You are about to alter the column `monthly_rate` on the `manpower_requirements` table. The data in that column could be lost. The data in that column will be cast from `DoublePrecision` to `Decimal(14,2)`.
  - You are about to alter the column `net_pay` on the `payment_disbursements` table. The data in that column could be lost. The data in that column will be cast from `DoublePrecision` to `Decimal(14,2)`.
  - You are about to alter the column `computed_value` on the `payroll_row_components` table. The data in that column could be lost. The data in that column will be cast from `DoublePrecision` to `Decimal(14,2)`.
  - You are about to alter the column `payable_basic` on the `payroll_rows` table. The data in that column could be lost. The data in that column will be cast from `DoublePrecision` to `Decimal(14,2)`.
  - You are about to alter the column `hra` on the `payroll_rows` table. The data in that column could be lost. The data in that column will be cast from `DoublePrecision` to `Decimal(14,2)`.
  - You are about to alter the column `washing_allow` on the `payroll_rows` table. The data in that column could be lost. The data in that column will be cast from `DoublePrecision` to `Decimal(14,2)`.
  - You are about to alter the column `bonus` on the `payroll_rows` table. The data in that column could be lost. The data in that column will be cast from `DoublePrecision` to `Decimal(14,2)`.
  - You are about to alter the column `uniform_allow` on the `payroll_rows` table. The data in that column could be lost. The data in that column will be cast from `DoublePrecision` to `Decimal(14,2)`.
  - You are about to alter the column `extra_duty_amt` on the `payroll_rows` table. The data in that column could be lost. The data in that column will be cast from `DoublePrecision` to `Decimal(14,2)`.
  - You are about to alter the column `pf_wage` on the `payroll_rows` table. The data in that column could be lost. The data in that column will be cast from `DoublePrecision` to `Decimal(14,2)`.
  - You are about to alter the column `pf_er` on the `payroll_rows` table. The data in that column could be lost. The data in that column will be cast from `DoublePrecision` to `Decimal(14,2)`.
  - You are about to alter the column `esic_er` on the `payroll_rows` table. The data in that column could be lost. The data in that column will be cast from `DoublePrecision` to `Decimal(14,2)`.
  - You are about to alter the column `total_deductions` on the `payroll_rows` table. The data in that column could be lost. The data in that column will be cast from `DoublePrecision` to `Decimal(14,2)`.
  - You are about to alter the column `admin_charge` on the `payroll_rows` table. The data in that column could be lost. The data in that column will be cast from `DoublePrecision` to `Decimal(14,2)`.
  - You are about to alter the column `edli` on the `payroll_rows` table. The data in that column could be lost. The data in that column will be cast from `DoublePrecision` to `Decimal(14,2)`.
  - You are about to alter the column `er_epf` on the `payroll_rows` table. The data in that column could be lost. The data in that column will be cast from `DoublePrecision` to `Decimal(14,2)`.
  - You are about to alter the column `er_eps` on the `payroll_rows` table. The data in that column could be lost. The data in that column will be cast from `DoublePrecision` to `Decimal(14,2)`.
  - You are about to alter the column `pt` on the `payroll_rows` table. The data in that column could be lost. The data in that column will be cast from `DoublePrecision` to `Decimal(14,2)`.
  - You are about to alter the column `vda_payable` on the `payroll_rows` table. The data in that column could be lost. The data in that column will be cast from `DoublePrecision` to `Decimal(14,2)`.
  - You are about to alter the column `bonus_provision` on the `payroll_rows` table. The data in that column could be lost. The data in that column will be cast from `DoublePrecision` to `Decimal(14,2)`.
  - You are about to alter the column `gratuity_provision` on the `payroll_rows` table. The data in that column could be lost. The data in that column will be cast from `DoublePrecision` to `Decimal(14,2)`.
  - You are about to alter the column `leave_wage_provision` on the `payroll_rows` table. The data in that column could be lost. The data in that column will be cast from `DoublePrecision` to `Decimal(14,2)`.
  - You are about to alter the column `uniform_cost` on the `payroll_rows` table. The data in that column could be lost. The data in that column will be cast from `DoublePrecision` to `Decimal(14,2)`.
  - You are about to alter the column `washing_cost` on the `payroll_rows` table. The data in that column could be lost. The data in that column will be cast from `DoublePrecision` to `Decimal(14,2)`.
  - You are about to alter the column `reliever_cost` on the `payroll_rows` table. The data in that column could be lost. The data in that column will be cast from `DoublePrecision` to `Decimal(14,2)`.
  - You are about to alter the column `total_employer_cost` on the `payroll_rows` table. The data in that column could be lost. The data in that column will be cast from `DoublePrecision` to `Decimal(14,2)`.
  - You are about to alter the column `total_pf_ee` on the `payroll_runs` table. The data in that column could be lost. The data in that column will be cast from `DoublePrecision` to `Decimal(14,2)`.
  - You are about to alter the column `total_pf_er` on the `payroll_runs` table. The data in that column could be lost. The data in that column will be cast from `DoublePrecision` to `Decimal(14,2)`.
  - You are about to alter the column `total_esic` on the `payroll_runs` table. The data in that column could be lost. The data in that column will be cast from `DoublePrecision` to `Decimal(14,2)`.
  - You are about to alter the column `total_pt` on the `payroll_runs` table. The data in that column could be lost. The data in that column will be cast from `DoublePrecision` to `Decimal(14,2)`.
  - You are about to alter the column `total_provisions` on the `payroll_runs` table. The data in that column could be lost. The data in that column will be cast from `DoublePrecision` to `Decimal(14,2)`.
  - You are about to alter the column `total_tender_costs` on the `payroll_runs` table. The data in that column could be lost. The data in that column will be cast from `DoublePrecision` to `Decimal(14,2)`.
  - You are about to alter the column `total_employer_costs` on the `payroll_runs` table. The data in that column could be lost. The data in that column will be cast from `DoublePrecision` to `Decimal(14,2)`.
  - You are about to alter the column `total_cost_to_client` on the `payroll_runs` table. The data in that column could be lost. The data in that column will be cast from `DoublePrecision` to `Decimal(14,2)`.
  - You are about to alter the column `amount` on the `pf_filing_records` table. The data in that column could be lost. The data in that column will be cast from `DoublePrecision` to `Decimal(14,2)`.
  - You are about to alter the column `min_salary` on the `professional_tax_slabs` table. The data in that column could be lost. The data in that column will be cast from `DoublePrecision` to `Decimal(14,2)`.
  - You are about to alter the column `max_salary` on the `professional_tax_slabs` table. The data in that column could be lost. The data in that column will be cast from `DoublePrecision` to `Decimal(14,2)`.
  - You are about to alter the column `pt_amount` on the `professional_tax_slabs` table. The data in that column could be lost. The data in that column will be cast from `DoublePrecision` to `Decimal(14,2)`.
  - You are about to alter the column `value` on the `salary_structure_components` table. The data in that column could be lost. The data in that column will be cast from `DoublePrecision` to `Decimal(14,2)`.
  - You are about to alter the column `threshold` on the `salary_structure_components` table. The data in that column could be lost. The data in that column will be cast from `DoublePrecision` to `Decimal(14,2)`.
  - You are about to alter the column `threshold_bonus` on the `salary_structure_components` table. The data in that column could be lost. The data in that column will be cast from `DoublePrecision` to `Decimal(14,2)`.
  - You are about to alter the column `value_override` on the `tender_component_overrides` table. The data in that column could be lost. The data in that column will be cast from `DoublePrecision` to `Decimal(14,2)`.
  - You are about to alter the column `basic_salary` on the `tender_salary_structures` table. The data in that column could be lost. The data in that column will be cast from `DoublePrecision` to `Decimal(14,2)`.
  - You are about to alter the column `vda` on the `tender_salary_structures` table. The data in that column could be lost. The data in that column will be cast from `DoublePrecision` to `Decimal(14,2)`.
  - You are about to alter the column `hra_value` on the `tender_salary_structures` table. The data in that column could be lost. The data in that column will be cast from `DoublePrecision` to `Decimal(14,2)`.
  - You are about to alter the column `hra_minimum` on the `tender_salary_structures` table. The data in that column could be lost. The data in that column will be cast from `DoublePrecision` to `Decimal(14,2)`.
  - You are about to alter the column `washing_rate` on the `tender_salary_structures` table. The data in that column could be lost. The data in that column will be cast from `DoublePrecision` to `Decimal(14,2)`.
  - You are about to alter the column `bonus_rate` on the `tender_salary_structures` table. The data in that column could be lost. The data in that column will be cast from `DoublePrecision` to `Decimal(14,2)`.
  - You are about to alter the column `uniform_rate` on the `tender_salary_structures` table. The data in that column could be lost. The data in that column will be cast from `DoublePrecision` to `Decimal(14,2)`.
  - You are about to alter the column `pf_cap` on the `tender_salary_structures` table. The data in that column could be lost. The data in that column will be cast from `DoublePrecision` to `Decimal(14,2)`.
  - You are about to alter the column `pf_ee_rate` on the `tender_salary_structures` table. The data in that column could be lost. The data in that column will be cast from `DoublePrecision` to `Decimal(14,2)`.
  - You are about to alter the column `pf_er_rate` on the `tender_salary_structures` table. The data in that column could be lost. The data in that column will be cast from `DoublePrecision` to `Decimal(14,2)`.
  - You are about to alter the column `esic_threshold` on the `tender_salary_structures` table. The data in that column could be lost. The data in that column will be cast from `DoublePrecision` to `Decimal(14,2)`.
  - You are about to alter the column `esic_ee_rate` on the `tender_salary_structures` table. The data in that column could be lost. The data in that column will be cast from `DoublePrecision` to `Decimal(14,2)`.
  - You are about to alter the column `esic_er_rate` on the `tender_salary_structures` table. The data in that column could be lost. The data in that column will be cast from `DoublePrecision` to `Decimal(14,2)`.
  - A unique constraint covering the columns `[tenant_id,entity_id,alert_type]` on the table `compliance_alerts` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[tenant_id,tender_id,docType]` on the table `compliance_documents` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[tender_id,employee_id]` on the table `tender_employees` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "attendance" ALTER COLUMN "night_shifts" SET DATA TYPE DECIMAL(14,2),
ALTER COLUMN "ot_hours" SET DATA TYPE DECIMAL(14,2);

-- AlterTable
ALTER TABLE "billing_configs" ALTER COLUMN "cgst_rate" SET DATA TYPE DECIMAL(14,2),
ALTER COLUMN "sgst_rate" SET DATA TYPE DECIMAL(14,2),
ALTER COLUMN "igst_rate" SET DATA TYPE DECIMAL(14,2),
ALTER COLUMN "service_charge_rate" SET DATA TYPE DECIMAL(14,2);

-- AlterTable
ALTER TABLE "esic_filing_records" ALTER COLUMN "amount" SET DATA TYPE DECIMAL(14,2);

-- AlterTable
ALTER TABLE "esic_periods" ALTER COLUMN "gross_at_start" SET DATA TYPE DECIMAL(14,2);

-- AlterTable
ALTER TABLE "invoice_line_items" ALTER COLUMN "monthly_rate" SET DATA TYPE DECIMAL(14,2),
ALTER COLUMN "amount" SET DATA TYPE DECIMAL(14,2);

-- AlterTable
ALTER TABLE "invoices" ALTER COLUMN "service_charge" SET DATA TYPE DECIMAL(14,2),
ALTER COLUMN "taxable_value" SET DATA TYPE DECIMAL(14,2),
ALTER COLUMN "cgst" SET DATA TYPE DECIMAL(14,2),
ALTER COLUMN "sgst" SET DATA TYPE DECIMAL(14,2),
ALTER COLUMN "grand_total" SET DATA TYPE DECIMAL(14,2),
ALTER COLUMN "paid_amount" SET DATA TYPE DECIMAL(14,2),
ALTER COLUMN "igst" SET DATA TYPE DECIMAL(14,2),
ALTER COLUMN "subtotal" SET DATA TYPE DECIMAL(14,2);

-- AlterTable
ALTER TABLE "manpower_requirements" ALTER COLUMN "monthly_rate" SET DATA TYPE DECIMAL(14,2);

-- AlterTable
ALTER TABLE "payment_disbursements" ALTER COLUMN "net_pay" SET DATA TYPE DECIMAL(14,2);

-- AlterTable
ALTER TABLE "payroll_row_components" ALTER COLUMN "computed_value" SET DATA TYPE DECIMAL(14,2);

-- AlterTable
ALTER TABLE "payroll_rows" ALTER COLUMN "payable_basic" SET DATA TYPE DECIMAL(14,2),
ALTER COLUMN "hra" SET DATA TYPE DECIMAL(14,2),
ALTER COLUMN "washing_allow" SET DATA TYPE DECIMAL(14,2),
ALTER COLUMN "bonus" SET DATA TYPE DECIMAL(14,2),
ALTER COLUMN "uniform_allow" SET DATA TYPE DECIMAL(14,2),
ALTER COLUMN "extra_duty_amt" SET DATA TYPE DECIMAL(14,2),
ALTER COLUMN "pf_wage" SET DATA TYPE DECIMAL(14,2),
ALTER COLUMN "pf_er" SET DATA TYPE DECIMAL(14,2),
ALTER COLUMN "esic_er" SET DATA TYPE DECIMAL(14,2),
ALTER COLUMN "total_deductions" SET DATA TYPE DECIMAL(14,2),
ALTER COLUMN "admin_charge" SET DATA TYPE DECIMAL(14,2),
ALTER COLUMN "edli" SET DATA TYPE DECIMAL(14,2),
ALTER COLUMN "er_epf" SET DATA TYPE DECIMAL(14,2),
ALTER COLUMN "er_eps" SET DATA TYPE DECIMAL(14,2),
ALTER COLUMN "pt" SET DATA TYPE DECIMAL(14,2),
ALTER COLUMN "vda_payable" SET DATA TYPE DECIMAL(14,2),
ALTER COLUMN "bonus_provision" SET DATA TYPE DECIMAL(14,2),
ALTER COLUMN "gratuity_provision" SET DATA TYPE DECIMAL(14,2),
ALTER COLUMN "leave_wage_provision" SET DATA TYPE DECIMAL(14,2),
ALTER COLUMN "uniform_cost" SET DATA TYPE DECIMAL(14,2),
ALTER COLUMN "washing_cost" SET DATA TYPE DECIMAL(14,2),
ALTER COLUMN "reliever_cost" SET DATA TYPE DECIMAL(14,2),
ALTER COLUMN "total_employer_cost" SET DATA TYPE DECIMAL(14,2);

-- AlterTable
ALTER TABLE "payroll_runs" ALTER COLUMN "total_pf_ee" SET DATA TYPE DECIMAL(14,2),
ALTER COLUMN "total_pf_er" SET DATA TYPE DECIMAL(14,2),
ALTER COLUMN "total_esic" SET DATA TYPE DECIMAL(14,2),
ALTER COLUMN "total_pt" SET DATA TYPE DECIMAL(14,2),
ALTER COLUMN "total_provisions" SET DATA TYPE DECIMAL(14,2),
ALTER COLUMN "total_tender_costs" SET DATA TYPE DECIMAL(14,2),
ALTER COLUMN "total_employer_costs" SET DATA TYPE DECIMAL(14,2),
ALTER COLUMN "total_cost_to_client" SET DATA TYPE DECIMAL(14,2);

-- AlterTable
ALTER TABLE "pf_filing_records" ALTER COLUMN "amount" SET DATA TYPE DECIMAL(14,2);

-- AlterTable
ALTER TABLE "professional_tax_slabs" ALTER COLUMN "min_salary" SET DATA TYPE DECIMAL(14,2),
ALTER COLUMN "max_salary" SET DATA TYPE DECIMAL(14,2),
ALTER COLUMN "pt_amount" SET DATA TYPE DECIMAL(14,2);

-- AlterTable
ALTER TABLE "salary_structure_components" ALTER COLUMN "value" SET DATA TYPE DECIMAL(14,2),
ALTER COLUMN "threshold" SET DATA TYPE DECIMAL(14,2),
ALTER COLUMN "threshold_bonus" SET DATA TYPE DECIMAL(14,2);

-- AlterTable
ALTER TABLE "tender_component_overrides" ALTER COLUMN "value_override" SET DATA TYPE DECIMAL(14,2),
ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "tender_salary_structures" ALTER COLUMN "basic_salary" SET DATA TYPE DECIMAL(14,2),
ALTER COLUMN "vda" SET DATA TYPE DECIMAL(14,2),
ALTER COLUMN "hra_value" SET DATA TYPE DECIMAL(14,2),
ALTER COLUMN "hra_minimum" SET DATA TYPE DECIMAL(14,2),
ALTER COLUMN "washing_rate" SET DATA TYPE DECIMAL(14,2),
ALTER COLUMN "bonus_rate" SET DATA TYPE DECIMAL(14,2),
ALTER COLUMN "uniform_rate" SET DATA TYPE DECIMAL(14,2),
ALTER COLUMN "pf_cap" SET DATA TYPE DECIMAL(14,2),
ALTER COLUMN "pf_ee_rate" SET DATA TYPE DECIMAL(14,2),
ALTER COLUMN "pf_er_rate" SET DATA TYPE DECIMAL(14,2),
ALTER COLUMN "esic_threshold" SET DATA TYPE DECIMAL(14,2),
ALTER COLUMN "esic_ee_rate" SET DATA TYPE DECIMAL(14,2),
ALTER COLUMN "esic_er_rate" SET DATA TYPE DECIMAL(14,2);

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "failed_attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "last_user_agent" TEXT,
ADD COLUMN     "lock_until" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "user_agent" TEXT,
    "ip_address" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_loans" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "remaining_amount" DECIMAL(14,2) NOT NULL,
    "emi_amount" DECIMAL(14,2) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "start_month" INTEGER NOT NULL,
    "start_year" INTEGER NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "employee_loans_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "refresh_tokens_user_id_idx" ON "refresh_tokens"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "compliance_alerts_tenant_id_entity_id_alert_type_key" ON "compliance_alerts"("tenant_id", "entity_id", "alert_type");

-- CreateIndex
CREATE UNIQUE INDEX "compliance_documents_tenant_id_tender_id_docType_key" ON "compliance_documents"("tenant_id", "tender_id", "docType");

-- CreateIndex
CREATE UNIQUE INDEX "tender_employees_tender_id_employee_id_key" ON "tender_employees"("tender_id", "employee_id");

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_loans" ADD CONSTRAINT "employee_loans_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_loans" ADD CONSTRAINT "employee_loans_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "idx_tco_tenant" RENAME TO "tender_component_overrides_tenant_id_idx";

-- RenameIndex
ALTER INDEX "tender_component_overrides_tender_id_salary_structure_comp_id_k" RENAME TO "tender_component_overrides_tender_id_salary_structure_comp__key";

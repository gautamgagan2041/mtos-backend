/*
  Warnings:

  - You are about to drop the column `payroll_run_id` on the `invoices` table. All the data in the column will be lost.
  - You are about to drop the column `sg_amount` on the `invoices` table. All the data in the column will be lost.
  - You are about to drop the column `sup_amount` on the `invoices` table. All the data in the column will be lost.
  - You are about to drop the column `total_amount` on the `invoices` table. All the data in the column will be lost.
  - The `status` column on the `invoices` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - You are about to drop the column `include_in_esic` on the `pay_components` table. All the data in the column will be lost.
  - You are about to drop the column `include_in_pf` on the `pay_components` table. All the data in the column will be lost.
  - You are about to drop the column `is_base` on the `pay_components` table. All the data in the column will be lost.
  - You are about to drop the column `basic_salary` on the `payroll_rows` table. All the data in the column will be lost.
  - You are about to drop the column `total_payable` on the `payroll_rows` table. All the data in the column will be lost.
  - You are about to drop the column `cgst_rate` on the `tender_salary_structures` table. All the data in the column will be lost.
  - You are about to drop the column `invoice_prefix` on the `tender_salary_structures` table. All the data in the column will be lost.
  - You are about to drop the column `service_charge` on the `tender_salary_structures` table. All the data in the column will be lost.
  - You are about to drop the column `sgst_rate` on the `tender_salary_structures` table. All the data in the column will be lost.
  - You are about to drop the column `sanctioned_strength` on the `tenders` table. All the data in the column will be lost.
  - You are about to drop the `payslip_components` table. If the table is not empty, all the data it contains will be lost.
  - A unique constraint covering the columns `[tenant_id,invoice_no]` on the table `invoices` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `tenant_id` to the `attendance` table without a default value. This is not possible if the table is not empty.
  - Changed the type of `month` on the `attendance` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Changed the type of `month` on the `esic_filing_records` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Added the required column `gst_mode` to the `invoices` table without a default value. This is not possible if the table is not empty.
  - Added the required column `period_end` to the `invoices` table without a default value. This is not possible if the table is not empty.
  - Added the required column `period_start` to the `invoices` table without a default value. This is not possible if the table is not empty.
  - Added the required column `tenant_id` to the `invoices` table without a default value. This is not possible if the table is not empty.
  - Changed the type of `month` on the `invoices` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Added the required column `updated_at` to the `pay_components` table without a default value. This is not possible if the table is not empty.
  - Changed the type of `type` on the `pay_components` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Made the column `display_order` on table `pay_components` required. This step will fail if there are existing NULL values in that column.
  - Added the required column `tenant_id` to the `payroll_runs` table without a default value. This is not possible if the table is not empty.
  - Changed the type of `month` on the `payroll_runs` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Changed the type of `month` on the `pf_filing_records` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Changed the type of `calculation_type` on the `salary_structure_components` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.

*/
-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('DRAFT', 'SENT', 'PAID', 'PARTIALLY_PAID', 'OVERDUE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "GstMode" AS ENUM ('EXCLUDED', 'INCLUDED', 'REVERSE_CHARGE', 'NONE');

-- CreateEnum
CREATE TYPE "ComponentType" AS ENUM ('EARNING', 'DEDUCTION');

-- CreateEnum
CREATE TYPE "CalculationType" AS ENUM ('FIXED', 'PERCENT_BASIC', 'PER_DAY', 'PER_HOUR', 'PER_SHIFT', 'OT_BASED', 'ATTENDANCE_BASED', 'FORMULA', 'MANUAL');

-- CreateEnum
CREATE TYPE "DisbursementStatus" AS ENUM ('PENDING', 'TRANSFERRED', 'FAILED', 'ON_HOLD');

-- DropForeignKey
ALTER TABLE "invoices" DROP CONSTRAINT "invoices_payroll_run_id_fkey";

-- DropForeignKey
ALTER TABLE "payslip_components" DROP CONSTRAINT "payslip_components_payroll_row_id_fkey";

-- DropIndex
DROP INDEX "invoices_tender_id_invoice_no_key";

-- AlterTable
ALTER TABLE "attendance" ADD COLUMN     "night_shifts" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "ot_hours" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "tenant_id" TEXT NOT NULL,
DROP COLUMN "month",
ADD COLUMN     "month" INTEGER NOT NULL;

-- AlterTable
ALTER TABLE "esic_filing_records" DROP COLUMN "month",
ADD COLUMN     "month" INTEGER NOT NULL;

-- AlterTable
ALTER TABLE "invoices" DROP COLUMN "payroll_run_id",
DROP COLUMN "sg_amount",
DROP COLUMN "sup_amount",
DROP COLUMN "total_amount",
ADD COLUMN     "gst_mode" "GstMode" NOT NULL,
ADD COLUMN     "igst" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "period_end" TIMESTAMP(3) NOT NULL,
ADD COLUMN     "period_start" TIMESTAMP(3) NOT NULL,
ADD COLUMN     "subtotal" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "tenant_id" TEXT NOT NULL,
DROP COLUMN "month",
ADD COLUMN     "month" INTEGER NOT NULL,
DROP COLUMN "status",
ADD COLUMN     "status" "InvoiceStatus" NOT NULL DEFAULT 'DRAFT';

-- AlterTable
ALTER TABLE "pay_components" DROP COLUMN "include_in_esic",
DROP COLUMN "include_in_pf",
DROP COLUMN "is_base",
ADD COLUMN     "description" TEXT,
ADD COLUMN     "is_active" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "updated_at" TIMESTAMP(3) NOT NULL,
DROP COLUMN "type",
ADD COLUMN     "type" "ComponentType" NOT NULL,
ALTER COLUMN "display_order" SET NOT NULL,
ALTER COLUMN "display_order" SET DEFAULT 0;

-- AlterTable
ALTER TABLE "payroll_rows" DROP COLUMN "basic_salary",
DROP COLUMN "total_payable",
ADD COLUMN     "admin_charge" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "edli" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "er_epf" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "er_eps" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "gross_earnings" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "pt" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "vda_payable" DOUBLE PRECISION,
ALTER COLUMN "rank" DROP NOT NULL,
ALTER COLUMN "work_days" SET DEFAULT 0,
ALTER COLUMN "payable_basic" DROP NOT NULL,
ALTER COLUMN "hra" DROP NOT NULL,
ALTER COLUMN "washing_allow" DROP NOT NULL,
ALTER COLUMN "bonus" DROP NOT NULL,
ALTER COLUMN "uniform_allow" DROP NOT NULL,
ALTER COLUMN "extra_duty_amt" DROP NOT NULL,
ALTER COLUMN "extra_duty_amt" DROP DEFAULT,
ALTER COLUMN "pf_wage" SET DEFAULT 0,
ALTER COLUMN "pf_ee" SET DEFAULT 0,
ALTER COLUMN "pf_er" SET DEFAULT 0,
ALTER COLUMN "esic_ee" SET DEFAULT 0,
ALTER COLUMN "esic_er" SET DEFAULT 0,
ALTER COLUMN "total_deductions" SET DEFAULT 0,
ALTER COLUMN "net_pay" SET DEFAULT 0;

-- AlterTable
ALTER TABLE "payroll_runs" ADD COLUMN     "tenant_id" TEXT NOT NULL,
ADD COLUMN     "total_pt" DOUBLE PRECISION NOT NULL DEFAULT 0,
DROP COLUMN "month",
ADD COLUMN     "month" INTEGER NOT NULL;

-- AlterTable
ALTER TABLE "pf_filing_records" DROP COLUMN "month",
ADD COLUMN     "month" INTEGER NOT NULL;

-- AlterTable
ALTER TABLE "salary_structure_components" ADD COLUMN     "formula" TEXT,
ADD COLUMN     "is_active" BOOLEAN NOT NULL DEFAULT true,
DROP COLUMN "calculation_type",
ADD COLUMN     "calculation_type" "CalculationType" NOT NULL,
ALTER COLUMN "threshold" SET DATA TYPE DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "salary_structures" ADD COLUMN     "is_active" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "rank" TEXT;

-- AlterTable
ALTER TABLE "tender_employees" ADD COLUMN     "is_reliever" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "tender_salary_structures" DROP COLUMN "cgst_rate",
DROP COLUMN "invoice_prefix",
DROP COLUMN "service_charge",
DROP COLUMN "sgst_rate",
ALTER COLUMN "pf_er_rate" SET DEFAULT 0.12;

-- AlterTable
ALTER TABLE "tenders" DROP COLUMN "sanctioned_strength",
ADD COLUMN     "salary_structure_id" TEXT;

-- DropTable
DROP TABLE "payslip_components";

-- CreateTable
CREATE TABLE "billing_configs" (
    "id" TEXT NOT NULL,
    "tender_id" TEXT NOT NULL,
    "gst_mode" "GstMode" NOT NULL DEFAULT 'REVERSE_CHARGE',
    "cgst_rate" DOUBLE PRECISION NOT NULL DEFAULT 0.09,
    "sgst_rate" DOUBLE PRECISION NOT NULL DEFAULT 0.09,
    "igst_rate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "service_charge_rate" DOUBLE PRECISION NOT NULL DEFAULT 0.10,
    "include_service_charge" BOOLEAN NOT NULL DEFAULT true,
    "invoice_prefix" TEXT NOT NULL DEFAULT 'INV',
    "sac_code" TEXT NOT NULL DEFAULT '998525',
    "payment_terms_days" INTEGER NOT NULL DEFAULT 30,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "billing_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "manpower_requirements" (
    "id" TEXT NOT NULL,
    "tender_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "category_code" TEXT NOT NULL,
    "category_name" TEXT NOT NULL,
    "required_posts" INTEGER NOT NULL,
    "monthly_rate" DOUBLE PRECISION NOT NULL,
    "effective_from" TIMESTAMP(3) NOT NULL,
    "effective_to" TIMESTAMP(3),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "manpower_requirements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_line_items" (
    "id" TEXT NOT NULL,
    "invoice_id" TEXT NOT NULL,
    "category_code" TEXT NOT NULL,
    "category_name" TEXT NOT NULL,
    "required_posts" INTEGER NOT NULL,
    "monthly_rate" DOUBLE PRECISION NOT NULL,
    "working_days" INTEGER NOT NULL,
    "standard_days" INTEGER NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "sac_code" TEXT NOT NULL,
    "display_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoice_line_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_sequences" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "fy" TEXT NOT NULL,
    "last_seq" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "invoice_sequences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_row_components" (
    "id" TEXT NOT NULL,
    "row_id" TEXT NOT NULL,
    "component_id" TEXT NOT NULL,
    "component_name" TEXT NOT NULL,
    "component_code" TEXT NOT NULL,
    "type" "ComponentType" NOT NULL,
    "calculation_type" "CalculationType" NOT NULL,
    "computed_value" DOUBLE PRECISION NOT NULL DEFAULT 0,

    CONSTRAINT "payroll_row_components_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_disbursements" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "net_pay" DOUBLE PRECISION NOT NULL,
    "bank_account" TEXT,
    "ifsc_code" TEXT,
    "bank_name" TEXT,
    "status" "DisbursementStatus" NOT NULL DEFAULT 'PENDING',
    "utr_no" TEXT,
    "transferred_at" TIMESTAMP(3),
    "transferred_by" TEXT,
    "failure_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_disbursements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "professional_tax_configs" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "professional_tax_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "professional_tax_slabs" (
    "id" TEXT NOT NULL,
    "config_id" TEXT NOT NULL,
    "min_salary" DOUBLE PRECISION NOT NULL,
    "max_salary" DOUBLE PRECISION,
    "pt_amount" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "professional_tax_slabs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "esic_periods" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "period_start" TIMESTAMP(3) NOT NULL,
    "period_end" TIMESTAMP(3) NOT NULL,
    "eligible" BOOLEAN NOT NULL,
    "gross_at_start" DOUBLE PRECISION,
    "exit_date" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "esic_periods_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "billing_configs_tender_id_key" ON "billing_configs"("tender_id");

-- CreateIndex
CREATE INDEX "manpower_requirements_tender_id_idx" ON "manpower_requirements"("tender_id");

-- CreateIndex
CREATE INDEX "manpower_requirements_tenant_id_idx" ON "manpower_requirements"("tenant_id");

-- CreateIndex
CREATE INDEX "invoice_line_items_invoice_id_idx" ON "invoice_line_items"("invoice_id");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_sequences_tenant_id_prefix_fy_key" ON "invoice_sequences"("tenant_id", "prefix", "fy");

-- CreateIndex
CREATE INDEX "payroll_row_components_row_id_idx" ON "payroll_row_components"("row_id");

-- CreateIndex
CREATE INDEX "payment_disbursements_tenant_id_idx" ON "payment_disbursements"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_disbursements_run_id_employee_id_key" ON "payment_disbursements"("run_id", "employee_id");

-- CreateIndex
CREATE UNIQUE INDEX "professional_tax_configs_tenant_id_state_key" ON "professional_tax_configs"("tenant_id", "state");

-- CreateIndex
CREATE INDEX "professional_tax_slabs_config_id_idx" ON "professional_tax_slabs"("config_id");

-- CreateIndex
CREATE INDEX "esic_periods_tenant_id_idx" ON "esic_periods"("tenant_id");

-- CreateIndex
CREATE INDEX "esic_periods_employee_id_idx" ON "esic_periods"("employee_id");

-- CreateIndex
CREATE UNIQUE INDEX "esic_periods_tenant_id_employee_id_period_start_key" ON "esic_periods"("tenant_id", "employee_id", "period_start");

-- CreateIndex
CREATE INDEX "attendance_tenant_id_idx" ON "attendance"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_tender_employee_id_month_year_key" ON "attendance"("tender_employee_id", "month", "year");

-- CreateIndex
CREATE INDEX "invoices_tenant_id_idx" ON "invoices"("tenant_id");

-- CreateIndex
CREATE INDEX "invoices_tender_id_month_year_idx" ON "invoices"("tender_id", "month", "year");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_tenant_id_invoice_no_key" ON "invoices"("tenant_id", "invoice_no");

-- CreateIndex
CREATE INDEX "payroll_rows_run_id_idx" ON "payroll_rows"("run_id");

-- CreateIndex
CREATE INDEX "payroll_rows_employee_id_idx" ON "payroll_rows"("employee_id");

-- CreateIndex
CREATE INDEX "payroll_runs_tenant_id_idx" ON "payroll_runs"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_runs_tender_id_month_year_key" ON "payroll_runs"("tender_id", "month", "year");

-- AddForeignKey
ALTER TABLE "tenders" ADD CONSTRAINT "tenders_salary_structure_id_fkey" FOREIGN KEY ("salary_structure_id") REFERENCES "salary_structures"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_configs" ADD CONSTRAINT "billing_configs_tender_id_fkey" FOREIGN KEY ("tender_id") REFERENCES "tenders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "manpower_requirements" ADD CONSTRAINT "manpower_requirements_tender_id_fkey" FOREIGN KEY ("tender_id") REFERENCES "tenders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_line_items" ADD CONSTRAINT "invoice_line_items_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_sequences" ADD CONSTRAINT "invoice_sequences_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_row_components" ADD CONSTRAINT "payroll_row_components_row_id_fkey" FOREIGN KEY ("row_id") REFERENCES "payroll_rows"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_row_components" ADD CONSTRAINT "payroll_row_components_component_id_fkey" FOREIGN KEY ("component_id") REFERENCES "pay_components"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_disbursements" ADD CONSTRAINT "payment_disbursements_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_disbursements" ADD CONSTRAINT "payment_disbursements_transferred_by_fkey" FOREIGN KEY ("transferred_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "professional_tax_configs" ADD CONSTRAINT "professional_tax_configs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "professional_tax_slabs" ADD CONSTRAINT "professional_tax_slabs_config_id_fkey" FOREIGN KEY ("config_id") REFERENCES "professional_tax_configs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "esic_periods" ADD CONSTRAINT "esic_periods_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "esic_periods" ADD CONSTRAINT "esic_periods_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('SUPER_ADMIN', 'COMPANY_ADMIN', 'HR_MANAGER', 'ACCOUNTS', 'SUPERVISOR', 'COMPLIANCE');

-- CreateEnum
CREATE TYPE "TenantPlan" AS ENUM ('STARTER', 'PROFESSIONAL', 'BUSINESS', 'ENTERPRISE');

-- CreateEnum
CREATE TYPE "TenantStatus" AS ENUM ('ACTIVE', 'TRIAL', 'SUSPENDED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TenderStatus" AS ENUM ('ACTIVE', 'EXPIRED', 'RENEWED', 'TERMINATED');

-- CreateEnum
CREATE TYPE "EmployeeStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'EXITED', 'REPLACED');

-- CreateEnum
CREATE TYPE "PayrollStatus" AS ENUM ('DRAFT', 'PROCESSING', 'COMPLETED', 'LOCKED');

-- CreateEnum
CREATE TYPE "ComplianceDocType" AS ENUM ('LABOUR_LICENSE', 'PASARA_LICENSE', 'RENT_AGREEMENT', 'TENDER_AGREEMENT', 'INSURANCE', 'FIRE_NOC', 'SHOP_ESTABLISHMENT', 'PF_REGISTRATION', 'ESIC_REGISTRATION', 'OTHER');

-- CreateEnum
CREATE TYPE "AlertSeverity" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "AlertType" AS ENUM ('COMPLIANCE_EXPIRY_90D', 'COMPLIANCE_EXPIRY_60D', 'COMPLIANCE_EXPIRY_30D', 'COMPLIANCE_EXPIRED', 'PF_NOT_FILED', 'ESIC_NOT_FILED', 'EMPLOYEE_EXIT_PF_ACTIVE', 'MISSING_DOCUMENT', 'VACANCY_CREATED', 'TENDER_EXPIRING');

-- CreateEnum
CREATE TYPE "PFRule" AS ENUM ('BASIC_ONLY', 'BASIC_VDA', 'CAPPED', 'ACTUAL');

-- CreateEnum
CREATE TYPE "ExitReason" AS ENUM ('RESIGNATION', 'TERMINATION', 'COMPLETION', 'ABSCONDING', 'MEDICAL', 'OTHER');

-- CreateEnum
CREATE TYPE "AuditAction" AS ENUM ('CREATE', 'UPDATE', 'DELETE', 'LOGIN', 'LOGOUT', 'PAYROLL_RUN', 'PAYROLL_LOCK', 'DOCUMENT_UPLOAD', 'DOCUMENT_DELETE', 'PASSWORD_CHANGE', 'EMPLOYEE_EXIT', 'EMPLOYEE_REPLACE', 'INVOICE_GENERATE', 'COMPLIANCE_RESOLVE');

-- CreateEnum
CREATE TYPE "StorageProvider" AS ENUM ('LOCAL', 'S3', 'GCS');

-- CreateTable
CREATE TABLE "tenants" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "gstin" TEXT,
    "pan" TEXT,
    "epf_reg_no" TEXT,
    "esic_reg_no" TEXT,
    "address" TEXT,
    "city" TEXT,
    "state" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "logo_url" TEXT,
    "plan" "TenantPlan" NOT NULL DEFAULT 'STARTER',
    "status" "TenantStatus" NOT NULL DEFAULT 'TRIAL',
    "trial_ends_at" TIMESTAMP(3),
    "billing_email" TEXT,
    "max_employees" INTEGER NOT NULL DEFAULT 100,
    "storage_provider" "StorageProvider" NOT NULL DEFAULT 'LOCAL',
    "s3_bucket" TEXT,
    "s3_region" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'HR_MANAGER',
    "phone" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_login" TIMESTAMP(3),
    "last_ip" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clients" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "short_name" TEXT,
    "gstin" TEXT,
    "address" TEXT,
    "state" TEXT,
    "state_code" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "clients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenders" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "location" TEXT,
    "start_date" TIMESTAMP(3) NOT NULL,
    "end_date" TIMESTAMP(3) NOT NULL,
    "sanctioned_strength" INTEGER NOT NULL DEFAULT 0,
    "status" "TenderStatus" NOT NULL DEFAULT 'ACTIVE',
    "po_number" TEXT,
    "work_order" TEXT,
    "description" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tender_salary_structures" (
    "id" TEXT NOT NULL,
    "tender_id" TEXT NOT NULL,
    "rank" TEXT NOT NULL,
    "basic_salary" DOUBLE PRECISION NOT NULL,
    "vda" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "hra_type" TEXT NOT NULL DEFAULT 'percentage',
    "hra_value" DOUBLE PRECISION NOT NULL DEFAULT 0.08,
    "hra_minimum" DOUBLE PRECISION NOT NULL DEFAULT 1800,
    "washing_rate" DOUBLE PRECISION NOT NULL DEFAULT 0.03,
    "bonus_rate" DOUBLE PRECISION NOT NULL DEFAULT 0.0833,
    "bonus_enabled" BOOLEAN NOT NULL DEFAULT true,
    "uniform_rate" DOUBLE PRECISION NOT NULL DEFAULT 0.05,
    "pf_rule" "PFRule" NOT NULL DEFAULT 'CAPPED',
    "pf_cap" DOUBLE PRECISION NOT NULL DEFAULT 15000,
    "pf_ee_rate" DOUBLE PRECISION NOT NULL DEFAULT 0.12,
    "pf_er_rate" DOUBLE PRECISION NOT NULL DEFAULT 0.13,
    "esic_enabled" BOOLEAN NOT NULL DEFAULT true,
    "esic_threshold" DOUBLE PRECISION NOT NULL DEFAULT 21000,
    "esic_ee_rate" DOUBLE PRECISION NOT NULL DEFAULT 0.0075,
    "esic_er_rate" DOUBLE PRECISION NOT NULL DEFAULT 0.0325,
    "base_divisor" INTEGER NOT NULL DEFAULT 26,
    "service_charge" DOUBLE PRECISION NOT NULL DEFAULT 0.10,
    "cgst_rate" DOUBLE PRECISION NOT NULL DEFAULT 0.09,
    "sgst_rate" DOUBLE PRECISION NOT NULL DEFAULT 0.09,
    "invoice_prefix" TEXT NOT NULL DEFAULT 'INV/25-26/',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tender_salary_structures_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employees" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "sr" INTEGER,
    "name" TEXT NOT NULL,
    "father_name" TEXT,
    "dob" TIMESTAMP(3),
    "gender" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "address" TEXT,
    "aadhaar" TEXT,
    "pan" TEXT,
    "uan" TEXT,
    "pf_number" TEXT,
    "esic_number" TEXT,
    "bank_account" TEXT,
    "ifsc_code" TEXT,
    "bank_name" TEXT,
    "status" "EmployeeStatus" NOT NULL DEFAULT 'ACTIVE',
    "photo_url" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "employees_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tender_employees" (
    "id" TEXT NOT NULL,
    "tender_id" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "rank" TEXT NOT NULL,
    "joining_date" TIMESTAMP(3) NOT NULL,
    "exit_date" TIMESTAMP(3),
    "exit_reason" "ExitReason",
    "exit_note" TEXT,
    "pf_exit_filed" BOOLEAN NOT NULL DEFAULT false,
    "esic_exit_filed" BOOLEAN NOT NULL DEFAULT false,
    "supervisor_id" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tender_employees_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "replacements" (
    "id" TEXT NOT NULL,
    "tender_id" TEXT NOT NULL,
    "exited_employee_id" TEXT NOT NULL,
    "replacement_employee_id" TEXT NOT NULL,
    "replaced_on" TIMESTAMP(3) NOT NULL,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "replacements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_documents" (
    "id" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "doc_type" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "file_key" TEXT NOT NULL,
    "file_size" INTEGER,
    "mime_type" TEXT,
    "storage_provider" "StorageProvider" NOT NULL DEFAULT 'LOCAL',
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "uploaded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employee_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance" (
    "id" TEXT NOT NULL,
    "tender_employee_id" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "present_days" INTEGER NOT NULL DEFAULT 0,
    "extra_duty_days" INTEGER NOT NULL DEFAULT 0,
    "split_days" INTEGER NOT NULL DEFAULT 0,
    "split_rank" TEXT,
    "daily_data" JSONB,
    "is_locked" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "attendance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_runs" (
    "id" TEXT NOT NULL,
    "tender_id" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "status" "PayrollStatus" NOT NULL DEFAULT 'DRAFT',
    "total_gross" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "total_net" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "total_pf_ee" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "total_pf_er" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "total_esic" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "run_by" TEXT NOT NULL,
    "locked_at" TIMESTAMP(3),
    "locked_by" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payroll_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_rows" (
    "id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "attendance_id" TEXT,
    "rank" TEXT NOT NULL,
    "work_days" INTEGER NOT NULL,
    "extra_duty_days" INTEGER NOT NULL DEFAULT 0,
    "is_split_row" BOOLEAN NOT NULL DEFAULT false,
    "basic_salary" DOUBLE PRECISION NOT NULL,
    "payable_basic" DOUBLE PRECISION NOT NULL,
    "hra" DOUBLE PRECISION NOT NULL,
    "washing_allow" DOUBLE PRECISION NOT NULL,
    "bonus" DOUBLE PRECISION NOT NULL,
    "uniform_allow" DOUBLE PRECISION NOT NULL,
    "extra_duty_amt" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "total_payable" DOUBLE PRECISION NOT NULL,
    "pf_wage" DOUBLE PRECISION NOT NULL,
    "pf_ee" DOUBLE PRECISION NOT NULL,
    "pf_er" DOUBLE PRECISION NOT NULL,
    "esic_ee" DOUBLE PRECISION NOT NULL,
    "esic_er" DOUBLE PRECISION NOT NULL,
    "total_deductions" DOUBLE PRECISION NOT NULL,
    "net_pay" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "payroll_rows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoices" (
    "id" TEXT NOT NULL,
    "tender_id" TEXT NOT NULL,
    "payroll_run_id" TEXT,
    "invoice_no" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "sup_amount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "sg_amount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "total_amount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "service_charge" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "taxable_value" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "cgst" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "sgst" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "grand_total" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "paid_on" TIMESTAMP(3),
    "paid_amount" DOUBLE PRECISION,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "compliance_documents" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "tender_id" TEXT,
    "docType" "ComplianceDocType" NOT NULL,
    "name" TEXT NOT NULL,
    "issue_date" TIMESTAMP(3),
    "expiry_date" TIMESTAMP(3),
    "file_key" TEXT,
    "file_name" TEXT,
    "file_size" INTEGER,
    "storage_provider" "StorageProvider" NOT NULL DEFAULT 'LOCAL',
    "notes" TEXT,
    "uploaded_by" TEXT,
    "alert_90_sent" BOOLEAN NOT NULL DEFAULT false,
    "alert_60_sent" BOOLEAN NOT NULL DEFAULT false,
    "alert_30_sent" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "compliance_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "compliance_alerts" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "tender_id" TEXT,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "alert_type" "AlertType" NOT NULL,
    "severity" "AlertSeverity" NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "is_resolved" BOOLEAN NOT NULL DEFAULT false,
    "resolved_at" TIMESTAMP(3),
    "resolved_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "compliance_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tender_documents" (
    "id" TEXT NOT NULL,
    "tender_id" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "file_key" TEXT NOT NULL,
    "file_size" INTEGER,
    "mime_type" TEXT,
    "storage_provider" "StorageProvider" NOT NULL DEFAULT 'LOCAL',
    "uploaded_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tender_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT,
    "user_id" TEXT NOT NULL,
    "action" "AuditAction" NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT,
    "old_values" JSONB,
    "new_values" JSONB,
    "metadata" JSONB,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pf_filing_records" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "tender_id" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "challan_no" TEXT,
    "amount" DOUBLE PRECISION NOT NULL,
    "filed_date" TIMESTAMP(3) NOT NULL,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pf_filing_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "esic_filing_records" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "tender_id" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "challan_no" TEXT,
    "amount" DOUBLE PRECISION NOT NULL,
    "filed_date" TIMESTAMP(3) NOT NULL,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "esic_filing_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pay_components" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "is_statutory" BOOLEAN NOT NULL DEFAULT false,
    "is_base" BOOLEAN NOT NULL DEFAULT false,
    "include_in_pf" BOOLEAN NOT NULL DEFAULT false,
    "include_in_esic" BOOLEAN NOT NULL DEFAULT false,
    "display_order" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pay_components_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "salary_structures" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "salary_structures_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "salary_structure_components" (
    "id" TEXT NOT NULL,
    "salary_structure_id" TEXT NOT NULL,
    "component_id" TEXT NOT NULL,
    "calculation_type" TEXT NOT NULL,
    "value" DOUBLE PRECISION,
    "threshold" INTEGER,
    "threshold_bonus" DOUBLE PRECISION,

    CONSTRAINT "salary_structure_components_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payslip_components" (
    "id" TEXT NOT NULL,
    "payroll_row_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "type" TEXT NOT NULL,

    CONSTRAINT "payslip_components_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenants_slug_key" ON "tenants"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_tenant_id_idx" ON "users"("tenant_id");

-- CreateIndex
CREATE INDEX "clients_tenant_id_idx" ON "clients"("tenant_id");

-- CreateIndex
CREATE INDEX "tenders_tenant_id_idx" ON "tenders"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "tenders_tenant_id_code_key" ON "tenders"("tenant_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "tender_salary_structures_tender_id_rank_key" ON "tender_salary_structures"("tender_id", "rank");

-- CreateIndex
CREATE INDEX "employees_tenant_id_idx" ON "employees"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "employees_tenant_id_uan_key" ON "employees"("tenant_id", "uan");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_tender_employee_id_month_year_key" ON "attendance"("tender_employee_id", "month", "year");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_runs_tender_id_month_year_key" ON "payroll_runs"("tender_id", "month", "year");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_tender_id_invoice_no_key" ON "invoices"("tender_id", "invoice_no");

-- CreateIndex
CREATE INDEX "compliance_documents_tenant_id_idx" ON "compliance_documents"("tenant_id");

-- CreateIndex
CREATE INDEX "compliance_alerts_tenant_id_idx" ON "compliance_alerts"("tenant_id");

-- CreateIndex
CREATE INDEX "audit_logs_tenant_id_created_at_idx" ON "audit_logs"("tenant_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_entity_type_entity_id_idx" ON "audit_logs"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "pf_filing_records_tenant_id_idx" ON "pf_filing_records"("tenant_id");

-- CreateIndex
CREATE INDEX "esic_filing_records_tenant_id_idx" ON "esic_filing_records"("tenant_id");

-- CreateIndex
CREATE INDEX "pay_components_tenant_id_idx" ON "pay_components"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "pay_components_tenant_id_code_key" ON "pay_components"("tenant_id", "code");

-- CreateIndex
CREATE INDEX "salary_structures_tenant_id_idx" ON "salary_structures"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "salary_structure_components_salary_structure_id_component_i_key" ON "salary_structure_components"("salary_structure_id", "component_id");

-- CreateIndex
CREATE INDEX "payslip_components_payroll_row_id_idx" ON "payslip_components"("payroll_row_id");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clients" ADD CONSTRAINT "clients_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenders" ADD CONSTRAINT "tenders_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenders" ADD CONSTRAINT "tenders_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tender_salary_structures" ADD CONSTRAINT "tender_salary_structures_tender_id_fkey" FOREIGN KEY ("tender_id") REFERENCES "tenders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tender_employees" ADD CONSTRAINT "tender_employees_tender_id_fkey" FOREIGN KEY ("tender_id") REFERENCES "tenders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tender_employees" ADD CONSTRAINT "tender_employees_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tender_employees" ADD CONSTRAINT "tender_employees_supervisor_id_fkey" FOREIGN KEY ("supervisor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "replacements" ADD CONSTRAINT "replacements_exited_employee_id_fkey" FOREIGN KEY ("exited_employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "replacements" ADD CONSTRAINT "replacements_replacement_employee_id_fkey" FOREIGN KEY ("replacement_employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_documents" ADD CONSTRAINT "employee_documents_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance" ADD CONSTRAINT "attendance_tender_employee_id_fkey" FOREIGN KEY ("tender_employee_id") REFERENCES "tender_employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_tender_id_fkey" FOREIGN KEY ("tender_id") REFERENCES "tenders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_run_by_fkey" FOREIGN KEY ("run_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_rows" ADD CONSTRAINT "payroll_rows_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "payroll_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_rows" ADD CONSTRAINT "payroll_rows_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_rows" ADD CONSTRAINT "payroll_rows_attendance_id_fkey" FOREIGN KEY ("attendance_id") REFERENCES "attendance"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_tender_id_fkey" FOREIGN KEY ("tender_id") REFERENCES "tenders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_payroll_run_id_fkey" FOREIGN KEY ("payroll_run_id") REFERENCES "payroll_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compliance_documents" ADD CONSTRAINT "compliance_documents_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compliance_documents" ADD CONSTRAINT "compliance_documents_tender_id_fkey" FOREIGN KEY ("tender_id") REFERENCES "tenders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compliance_documents" ADD CONSTRAINT "compliance_documents_uploaded_by_fkey" FOREIGN KEY ("uploaded_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compliance_alerts" ADD CONSTRAINT "compliance_alerts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compliance_alerts" ADD CONSTRAINT "compliance_alerts_tender_id_fkey" FOREIGN KEY ("tender_id") REFERENCES "tenders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tender_documents" ADD CONSTRAINT "tender_documents_tender_id_fkey" FOREIGN KEY ("tender_id") REFERENCES "tenders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pf_filing_records" ADD CONSTRAINT "pf_filing_records_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "esic_filing_records" ADD CONSTRAINT "esic_filing_records_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pay_components" ADD CONSTRAINT "pay_components_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salary_structures" ADD CONSTRAINT "salary_structures_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salary_structure_components" ADD CONSTRAINT "salary_structure_components_salary_structure_id_fkey" FOREIGN KEY ("salary_structure_id") REFERENCES "salary_structures"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salary_structure_components" ADD CONSTRAINT "salary_structure_components_component_id_fkey" FOREIGN KEY ("component_id") REFERENCES "pay_components"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payslip_components" ADD CONSTRAINT "payslip_components_payroll_row_id_fkey" FOREIGN KEY ("payroll_row_id") REFERENCES "payroll_rows"("id") ON DELETE CASCADE ON UPDATE CASCADE;

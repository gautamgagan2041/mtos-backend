'use strict';

/**
 * pfECR.js — PF Electronic Challan-cum-Return (ECR) File Generator
 *
 * EPFO ECR File Format Specification (Version 2.0):
 * https://www.epfindia.gov.in/site_docs/PDFs/Downloads_PDFs/ECR2.0UserManual.pdf
 *
 * File Format: Tilde (~) delimited text file
 * Extension:   .txt
 * Encoding:    UTF-8
 *
 * HEADER LINE:
 *   #~#~ECR~ESTABLISHMENT_ID~WAGE_MONTH~TOTAL_MEMBERS~TOTAL_EE~TOTAL_ER~TOTAL_NCP_DAYS
 *
 * DATA LINES (one per employee):
 *   UAN~MemberName~Gross~EPF_Wages~EPS_Wages~EDLIWages~EE_EPF~EE_EPS(0)~ER_EPF~ER_EPS~NCP_Days~Refund_of_Advance
 *
 * USAGE:
 *   const { generateECR } = require('./pfECR');
 *   const { content, filename } = await generateECR(runId, tenantId);
 *   res.setHeader('Content-Type', 'text/plain');
 *   res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
 *   res.send(content);
 */

const prisma = require('../../../config/database');

const MONTHS = [
  '', 'JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN',
  'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC',
];

const r2 = n => Math.round((n || 0) * 100) / 100;
const r0 = n => Math.round(n || 0);

/**
 * generateECR — Generate EPFO ECR 2.0 file content
 *
 * @param {string} runId    - PayrollRun ID
 * @param {string} tenantId - Tenant ID
 * @returns {{ content: string, filename: string, summary: object }}
 */
async function generateECR(runId, tenantId) {
  // ── Load payroll run with all required data
  const run = await prisma.payrollRun.findFirst({
    where: { id: runId, tenantId },
    include: {
      rows: {
        include: {
          employee: {
            select: {
              id: true, name: true, uan: true,
              pfNumber: true, sr: true,
            },
          },
        },
        orderBy: { employee: { sr: 'asc' } },
      },
      tender: {
        include: { client: { select: { name: true } } },
      },
    },
  });

  if (!run) throw new Error('Payroll run not found');
  if (run.status === 'DRAFT' || run.status === 'PROCESSING') {
    throw new Error('Payroll run must be COMPLETED or LOCKED before generating ECR');
  }

  // ── Load tenant PF details
  const tenant = await prisma.tenant.findUnique({
    where:  { id: tenantId },
    select: { epfRegNo: true, name: true },
  });

  if (!tenant?.epfRegNo) {
    throw new Error(
      'EPF Registration Number not set. ' +
      'Go to Company Settings → Compliance to add your EPFO establishment code.'
    );
  }

  // ── Aggregate per employee (handle split rows)
  const empMap = {};
  for (const row of run.rows) {
    const emp = row.employee;
    if (!emp.uan) continue; // Skip employees without UAN (non-PF employees)

    const id = emp.id;
    if (!empMap[id]) {
      empMap[id] = {
        uan:        emp.uan,
        name:       _sanitizeName(emp.name),
        grossWages: 0,
        epfWages:   0,
        epsWages:   0,
        edliWages:  0,
        eeEPF:      0,       // Employee 12%
        eeEPS:      0,       // Always 0 in ECR (goes to ER split)
        erEPF:      0,       // Employer EPF (3.67%)
        erEPS:      0,       // Employer EPS (8.33%)
        ncpDays:    0,       // Non-contributing period days
        refundAdvance: 0,
        workDays:   row.workDays || 0,
      };
    }

    const e = empMap[id];
    e.grossWages += row.grossEarnings;
    e.epfWages   += row.pfWage;
    e.epsWages   += Math.min(row.pfWage, 15000); // EPS wage cap
    e.edliWages  += row.pfWage;
    e.eeEPF      += row.pfEE;
    e.erEPF      += row.erEPF || 0;
    e.erEPS      += row.erEPS || 0;
    e.workDays   += row.workDays || 0;
  }

  const employees = Object.values(empMap);

  if (employees.length === 0) {
    throw new Error(
      'No employees with UAN found in this payroll run. ' +
      'Ensure employees have UAN numbers entered in their profiles.'
    );
  }

  // ── Calculate totals for header
  const totals = employees.reduce((acc, e) => ({
    totalEE:  acc.totalEE  + e.eeEPF,
    totalER:  acc.totalER  + e.erEPF + e.erEPS,
    members:  acc.members  + 1,
  }), { totalEE: 0, totalER: 0, members: 0 });

  // ── Build wage month string: MAR/2026
  const wageMonth = `${MONTHS[run.month]}/${run.year}`;

  // ── Generate ECR content
  const lines = [];

  // Header line
  lines.push([
    '#~#~ECR',
    tenant.epfRegNo,
    wageMonth,
    totals.members,
    r0(totals.totalEE),
    r0(totals.totalER),
    0, // NCP days total (placeholder)
  ].join('~'));

  // Data lines — one per employee
  for (const e of employees) {
    const ncpDays = Math.max(0, 26 - e.workDays); // Days not worked in month

    lines.push([
      e.uan,                          // UAN
      e.name,                         // Member Name
      r0(e.grossWages),               // Gross Wages
      r0(e.epfWages),                 // EPF Wages
      r0(e.epsWages),                 // EPS Wages
      r0(e.edliWages),                // EDLI Wages
      r0(e.eeEPF),                    // EE EPF contribution
      0,                              // EE EPS (always 0 in ECR — it's ER split)
      r0(e.erEPF),                    // ER EPF contribution (3.67%)
      r0(e.erEPS),                    // ER EPS contribution (8.33%)
      ncpDays,                        // NCP Days
      e.refundAdvance,                // Refund of Advance (usually 0)
    ].join('~'));
  }

  const content  = lines.join('\r\n'); // EPFO requires CRLF
  const filename = `ECR_${tenant.epfRegNo}_${MONTHS[run.month]}${run.year}.txt`;

  return {
    content,
    filename,
    summary: {
      establishmentId: tenant.epfRegNo,
      wageMonth,
      totalMembers:    totals.members,
      totalEE:         r2(totals.totalEE),
      totalER:         r2(totals.totalER),
      totalChallan:    r2(totals.totalEE + totals.totalER),
    },
  };
}

/**
 * generateESICReturn — Generate ESIC monthly return data
 *
 * ESIC return format: CSV with fields defined by ESIC portal
 */
async function generateESICReturn(runId, tenantId) {
  const run = await prisma.payrollRun.findFirst({
    where: { id: runId, tenantId },
    include: {
      rows: {
        include: {
          employee: {
            select: { id: true, name: true, esicNumber: true, sr: true },
          },
        },
        orderBy: { employee: { sr: 'asc' } },
      },
    },
  });

  if (!run) throw new Error('Payroll run not found');

  const tenant = await prisma.tenant.findUnique({
    where:  { id: tenantId },
    select: { esicRegNo: true, name: true },
  });

  if (!tenant?.esicRegNo) {
    throw new Error('ESIC Registration Number not set in Company Settings.');
  }

  const rows = [];

  // Group by employee for split-row handling
  const empMap = {};
  for (const row of run.rows) {
    const emp = row.employee;
    if (!emp.esicNumber) continue;

    const id = emp.id;
    if (!empMap[id]) {
      empMap[id] = {
        esicNumber: emp.esicNumber,
        name:       emp.name,
        grossWages: 0,
        esicEE:     0,
        esicER:     0,
        workDays:   0,
      };
    }
    empMap[id].grossWages += row.grossEarnings;
    empMap[id].esicEE     += row.esicEE;
    empMap[id].esicER     += row.esicER;
    empMap[id].workDays   += row.workDays || 0;
  }

  // CSV header
  rows.push([
    'IP_Number', 'IP_Name', 'No_of_Days_Contributed',
    'Total_Monthly_Wages', 'ESIC_Employee_Contribution', 'ESIC_Employer_Contribution',
    'Total_Contribution',
  ].join(','));

  for (const e of Object.values(empMap)) {
    if (e.esicEE === 0 && e.esicER === 0) continue; // Not ESIC eligible this month

    rows.push([
      e.esicNumber,
      `"${e.name}"`,
      e.workDays,
      r2(e.grossWages),
      r2(e.esicEE),
      r2(e.esicER),
      r2(e.esicEE + e.esicER),
    ].join(','));
  }

  const totalESICEE = r2(Object.values(empMap).reduce((s, e) => s + e.esicEE, 0));
  const totalESICER = r2(Object.values(empMap).reduce((s, e) => s + e.esicER, 0));

  const content  = rows.join('\r\n');
  const filename = `ESIC_Return_${MONTHS[run.month]}${run.year}.csv`;

  return {
    content,
    filename,
    summary: {
      esicRegNo: tenant.esicRegNo,
      wageMonth: `${MONTHS[run.month]}/${run.year}`,
      totalMembers: Object.values(empMap).filter(e => e.esicEE > 0).length,
      totalESICEE,
      totalESICER,
      totalChallan: r2(totalESICEE + totalESICER),
    },
  };
}

// ── Helpers ────────────────────────────────────────────────────────

function _sanitizeName(name) {
  if (!name) return 'UNKNOWN';
  // ECR spec: remove special chars, max 50 chars, uppercase
  return name
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, '')
    .trim()
    .slice(0, 50);
}

module.exports = { generateECR, generateESICReturn };

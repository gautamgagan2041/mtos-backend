'use strict';

/**
 * payslip.js — HTML Payslip Generator
 *
 * DEPENDENCIES:
 *   npm install puppeteer  (for PDF generation)
 *   OR use wkhtmltopdf     (lighter weight, no Chrome)
 *
 * USAGE:
 *   const { generatePayslipHTML, generatePayslipPDF } = require('./payslip');
 *
 *   // Single payslip PDF:
 *   const pdf = await generatePayslipPDF(runId, employeeId, tenantId);
 *   res.setHeader('Content-Type', 'application/pdf');
 *   res.setHeader('Content-Disposition', `attachment; filename="Payslip_${empName}_${month}.pdf"`);
 *   res.send(pdf);
 *
 *   // All payslips as ZIP (bulk download):
 *   const zip = await generateAllPayslipsZip(runId, tenantId);
 *   res.setHeader('Content-Type', 'application/zip');
 *   res.send(zip);
 */

const prisma = require('../../../config/database');
const { decryptPII } = require('../../../utils/encryption');

const MONTHS = [
  '', 'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const r2 = n => Math.round((n || 0) * 100) / 100;
const fmt = n => new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n || 0);

/**
 * getPayslipData — Load all data needed for a single employee payslip
 */
async function getPayslipData(runId, employeeId, tenantId) {
  const run = await prisma.payrollRun.findFirst({
    where: { id: runId, tenantId },
    include: {
      tender: {
        include: { client: { select: { name: true, gstin: true, address: true } } },
      },
    },
  });

  if (!run) throw new Error('Payroll run not found');

  const row = await prisma.payrollRow.findFirst({
    where: { runId, employeeId },
    include: {
      employee: true,
      components: {
        include: {
          component: {
            select: { name: true, code: true, type: true, nature: true, displayOrder: true },
          },
        },
        orderBy: { component: { displayOrder: 'asc' } },
      },
    },
  });

  if (!row) throw new Error('Employee payroll row not found in this run');

  const tenant = await prisma.tenant.findUnique({
    where:  { id: tenantId },
    select: { name: true, address: true, epfRegNo: true, esicRegNo: true, logoUrl: true },
  });

  // Decrypt PII fields for payslip display
  const employee = decryptPII(row.employee);

  // Separate earnings and deductions from component breakdown
  const earnings   = row.components.filter(c => c.component.type === 'EARNING' && c.component.nature === 'EARNING');
  const deductions = row.components.filter(c => c.component.type === 'DEDUCTION');

  // Add statutory deductions not in components (PF EE, ESIC EE, PT)
  const statutoryDeductions = [];
  if (row.pfEE  > 0) statutoryDeductions.push({ name: 'PF Employee',   code: 'PF_EE',   amount: row.pfEE  });
  if (row.esicEE > 0) statutoryDeductions.push({ name: 'ESIC Employee', code: 'ESIC_EE', amount: row.esicEE });
  if (row.pt     > 0) statutoryDeductions.push({ name: 'Prof. Tax',     code: 'PT',      amount: row.pt    });

  return {
    tenant,
    run,
    row,
    employee,
    earnings:   earnings.map(c => ({ name: c.component.name, amount: c.computedValue })),
    deductions: [
      ...deductions.map(c => ({ name: c.component.name, amount: c.computedValue })),
      ...statutoryDeductions,
    ],
  };
}

/**
 * generatePayslipHTML — Generate HTML string for a payslip
 * This can be rendered in browser or converted to PDF via Puppeteer
 */
async function generatePayslipHTML(runId, employeeId, tenantId) {
  const data = await getPayslipData(runId, employeeId, tenantId);
  return _renderPayslipHTML(data);
}

/**
 * generatePayslipPDF — Generate PDF Buffer using Puppeteer
 * Requires: npm install puppeteer
 */
async function generatePayslipPDF(runId, employeeId, tenantId) {
  let puppeteer;
  try {
    puppeteer = require('puppeteer');
  } catch {
    throw new Error(
      'PDF generation requires puppeteer. Run: npm install puppeteer'
    );
  }

  const html = await generatePayslipHTML(runId, employeeId, tenantId);

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'], // Required for Docker
  });

  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const pdf = await page.pdf({
      format:            'A4',
      printBackground:   true,
      margin:            { top: '10mm', bottom: '10mm', left: '10mm', right: '10mm' },
    });
    return pdf;
  } finally {
    await browser.close();
  }
}

// ── HTML Template ──────────────────────────────────────────────────

function _renderPayslipHTML(data) {
  const { tenant, run, row, employee, earnings, deductions } = data;

  const monthYear   = `${MONTHS[run.month]} ${run.year}`;
  const totalEarning = r2(earnings.reduce((s, e) => s + e.amount, 0));
  const totalDeduct  = r2(deductions.reduce((s, d) => s + d.amount, 0));

  const earningsRows = earnings.map(e =>
    `<tr><td>${e.name}</td><td class="amount">₹ ${fmt(e.amount)}</td></tr>`
  ).join('');

  const deductionRows = deductions.map(d =>
    `<tr><td>${d.name}</td><td class="amount">₹ ${fmt(d.amount)}</td></tr>`
  ).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'Segoe UI', Arial, sans-serif; font-size: 12px; color: #1a1a1a; background: #fff; }
  .container { width: 210mm; min-height: 297mm; padding: 12mm; }
  
  .header { display: flex; justify-content: space-between; align-items: center; 
            border-bottom: 3px solid #1e40af; padding-bottom: 10px; margin-bottom: 16px; }
  .company-name { font-size: 20px; font-weight: 700; color: #1e40af; }
  .company-details { font-size: 10px; color: #555; margin-top: 4px; }
  .payslip-title { text-align: right; }
  .payslip-title h2 { font-size: 16px; color: #1e40af; font-weight: 700; }
  .payslip-title .period { background: #1e40af; color: white; padding: 3px 10px; 
                           border-radius: 4px; font-size: 11px; margin-top: 4px; display: inline-block; }
  
  .info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 16px; }
  .info-section { background: #f8faff; border: 1px solid #dbeafe; border-radius: 6px; padding: 10px; }
  .info-section h4 { font-size: 10px; text-transform: uppercase; color: #6b7280; margin-bottom: 8px; letter-spacing: 0.5px; }
  .info-row { display: flex; justify-content: space-between; margin-bottom: 4px; font-size: 11px; }
  .info-row .label { color: #6b7280; }
  .info-row .value { font-weight: 600; color: #1a1a1a; }
  
  .earnings-deductions { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 16px; }
  .section { border: 1px solid #e5e7eb; border-radius: 6px; overflow: hidden; }
  .section-header { padding: 8px 12px; font-weight: 700; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; }
  .earnings .section-header { background: #ecfdf5; color: #065f46; }
  .deductions .section-header { background: #fef2f2; color: #991b1b; }
  
  table { width: 100%; border-collapse: collapse; }
  td { padding: 6px 12px; font-size: 11px; border-bottom: 1px solid #f3f4f6; }
  td.amount { text-align: right; font-weight: 500; }
  tr:last-child td { border-bottom: none; }
  
  .section-total { padding: 8px 12px; display: flex; justify-content: space-between; font-weight: 700; font-size: 12px; }
  .earnings .section-total { background: #ecfdf5; color: #065f46; }
  .deductions .section-total { background: #fef2f2; color: #991b1b; }
  
  .net-pay-bar { background: linear-gradient(135deg, #1e40af, #3b82f6); color: white;
                 border-radius: 8px; padding: 16px 20px; display: flex; 
                 justify-content: space-between; align-items: center; margin-bottom: 16px; }
  .net-pay-bar .label { font-size: 14px; font-weight: 600; opacity: 0.9; }
  .net-pay-bar .amount { font-size: 24px; font-weight: 700; }
  .net-pay-bar .words { font-size: 10px; opacity: 0.8; margin-top: 2px; }
  
  .statutory { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 16px; }
  .statutory-item { background: #fffbeb; border: 1px solid #fde68a; border-radius: 6px; padding: 10px; }
  .statutory-item h4 { font-size: 10px; color: #92400e; margin-bottom: 4px; }
  .statutory-item .val { font-size: 13px; font-weight: 700; color: #78350f; }
  
  .footer { border-top: 1px solid #e5e7eb; padding-top: 10px; font-size: 9px; color: #9ca3af; 
            display: flex; justify-content: space-between; }
  .confidential { background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 4px; 
                  padding: 6px 12px; font-size: 9px; color: #9ca3af; text-align: center; margin-bottom: 12px; }
</style>
</head>
<body>
<div class="container">
  
  <div class="header">
    <div>
      <div class="company-name">${_esc(tenant.name)}</div>
      <div class="company-details">${_esc(tenant.address || '')}</div>
      ${tenant.epfRegNo  ? `<div class="company-details">EPF: ${tenant.epfRegNo}</div>`  : ''}
      ${tenant.esicRegNo ? `<div class="company-details">ESIC: ${tenant.esicRegNo}</div>` : ''}
    </div>
    <div class="payslip-title">
      <h2>SALARY SLIP</h2>
      <div class="period">${monthYear}</div>
    </div>
  </div>
  
  <div class="info-grid">
    <div class="info-section">
      <h4>Employee Details</h4>
      <div class="info-row"><span class="label">Name</span><span class="value">${_esc(employee.name)}</span></div>
      ${employee.uan       ? `<div class="info-row"><span class="label">UAN</span><span class="value">${employee.uan}</span></div>` : ''}
      ${employee.esicNumber ? `<div class="info-row"><span class="label">ESIC No.</span><span class="value">${employee.esicNumber}</span></div>` : ''}
      ${employee.pan       ? `<div class="info-row"><span class="label">PAN</span><span class="value">${employee.pan}</span></div>` : ''}
      <div class="info-row"><span class="label">Bank</span><span class="value">${_esc(employee.bankName || 'N/A')}</span></div>
      <div class="info-row"><span class="label">Account</span><span class="value">${_maskAccount(employee.bankAccount)}</span></div>
    </div>
    <div class="info-section">
      <h4>Employment Details</h4>
      <div class="info-row"><span class="label">Designation</span><span class="value">${_esc(row.rank || 'N/A')}</span></div>
      <div class="info-row"><span class="label">Department</span><span class="value">${_esc(run.tender?.client?.name || 'N/A')}</span></div>
      <div class="info-row"><span class="label">Days Worked</span><span class="value">${row.workDays || 0} days</span></div>
      <div class="info-row"><span class="label">Pay Period</span><span class="value">${monthYear}</span></div>
    </div>
  </div>
  
  <div class="earnings-deductions">
    <div class="section earnings">
      <div class="section-header">Earnings</div>
      <table>
        <tbody>${earningsRows}</tbody>
      </table>
      <div class="section-total">
        <span>Total Earnings</span>
        <span>₹ ${fmt(totalEarning)}</span>
      </div>
    </div>
    <div class="section deductions">
      <div class="section-header">Deductions</div>
      <table>
        <tbody>${deductionRows}</tbody>
      </table>
      <div class="section-total">
        <span>Total Deductions</span>
        <span>₹ ${fmt(totalDeduct)}</span>
      </div>
    </div>
  </div>
  
  <div class="net-pay-bar">
    <div>
      <div class="label">Net Pay (Take Home)</div>
      <div class="words">${_amountInWords(row.netPay)}</div>
    </div>
    <div class="amount">₹ ${fmt(row.netPay)}</div>
  </div>
  
  <div class="statutory">
    <div class="statutory-item">
      <h4>PF Contribution (Employee)</h4>
      <div class="val">₹ ${fmt(row.pfEE)}</div>
    </div>
    <div class="statutory-item">
      <h4>PF Contribution (Employer)</h4>
      <div class="val">₹ ${fmt(row.pfER)}</div>
    </div>
    <div class="statutory-item">
      <h4>ESIC Contribution (Employee)</h4>
      <div class="val">₹ ${fmt(row.esicEE)}</div>
    </div>
    <div class="statutory-item">
      <h4>ESIC Contribution (Employer)</h4>
      <div class="val">₹ ${fmt(row.esicER)}</div>
    </div>
  </div>
  
  <div class="confidential">
    ⚠️ This is a computer-generated payslip. No signature required.
    Queries: Contact HR Department.
  </div>
  
  <div class="footer">
    <span>Generated on: ${new Date().toLocaleDateString('en-IN')}</span>
    <span>This payslip is confidential. Do not share.</span>
    <span>${_esc(tenant.name)}</span>
  </div>
  
</div>
</body>
</html>`;
}

// ── Helpers ────────────────────────────────────────────────────────

function _esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function _maskAccount(account) {
  if (!account) return 'N/A';
  const s = String(account);
  return s.length > 4 ? `XXXX${s.slice(-4)}` : s;
}

function _amountInWords(amount) {
  // Simple Indian number-to-words (extend as needed)
  if (!amount || amount <= 0) return 'Zero Rupees Only';
  const whole = Math.floor(amount);
  return `Rupees ${_numToWords(whole)} Only`;
}

const ONES  = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
               'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen',
               'Seventeen', 'Eighteen', 'Nineteen'];
const TENS  = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function _numToWords(n) {
  if (n === 0)  return 'Zero';
  if (n < 20)   return ONES[n];
  if (n < 100)  return TENS[Math.floor(n / 10)] + (n % 10 ? ' ' + ONES[n % 10] : '');
  if (n < 1000) return ONES[Math.floor(n / 100)] + ' Hundred' + (n % 100 ? ' ' + _numToWords(n % 100) : '');
  if (n < 100000) return _numToWords(Math.floor(n / 1000)) + ' Thousand' + (n % 1000 ? ' ' + _numToWords(n % 1000) : '');
  if (n < 10000000) return _numToWords(Math.floor(n / 100000)) + ' Lakh' + (n % 100000 ? ' ' + _numToWords(n % 100000) : '');
  return _numToWords(Math.floor(n / 10000000)) + ' Crore' + (n % 10000000 ? ' ' + _numToWords(n % 10000000) : '');
}

module.exports = { generatePayslipHTML, generatePayslipPDF, getPayslipData };

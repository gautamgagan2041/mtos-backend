// src/services/cronService.js
const cron = require('node-cron');
const prisma = require('../config/database');

/**
 * Check compliance documents for expiry and create alerts
 */
async function checkComplianceExpiry() {
  console.log('⏰ Running compliance expiry check...');
  const now = new Date();

  const docs = await prisma.complianceDocument.findMany({
    where: { isActive: true, expiryDate: { not: null } },
  });

  for (const doc of docs) {
    const daysLeft = Math.ceil((new Date(doc.expiryDate) - now) / (1000 * 60 * 60 * 24));

    // 90 day alert
    if (daysLeft <= 90 && daysLeft > 60 && !doc.alert90Sent) {
      await createAlert(doc, 'COMPLIANCE_EXPIRY_90D', 'MEDIUM', daysLeft);
      await prisma.complianceDocument.update({ where: { id: doc.id }, data: { alert90Sent: true } });
    }
    // 60 day alert
    if (daysLeft <= 60 && daysLeft > 30 && !doc.alert60Sent) {
      await createAlert(doc, 'COMPLIANCE_EXPIRY_60D', 'HIGH', daysLeft);
      await prisma.complianceDocument.update({ where: { id: doc.id }, data: { alert60Sent: true } });
    }
    // 30 day alert
    if (daysLeft <= 30 && daysLeft > 0 && !doc.alert30Sent) {
      await createAlert(doc, 'COMPLIANCE_EXPIRY_30D', 'CRITICAL', daysLeft);
      await prisma.complianceDocument.update({ where: { id: doc.id }, data: { alert30Sent: true } });
    }
    // Expired
    if (daysLeft <= 0) {
      await createAlert(doc, 'COMPLIANCE_EXPIRED', 'CRITICAL', daysLeft);
    }
  }
  console.log('✅ Compliance check complete');
}

async function createAlert(doc, alertType, severity, daysLeft) {
  const existing = await prisma.complianceAlert.findFirst({
    where: { entityId: doc.id, alertType, isResolved: false },
  });
  if (existing) return;

  const messages = {
    COMPLIANCE_EXPIRY_90D: `Document expires in ${daysLeft} days`,
    COMPLIANCE_EXPIRY_60D: `URGENT: Document expires in ${daysLeft} days`,
    COMPLIANCE_EXPIRY_30D: `CRITICAL: Document expires in ${daysLeft} days — Renew immediately!`,
    COMPLIANCE_EXPIRED: `Document has EXPIRED ${Math.abs(daysLeft)} days ago`,
  };

  await prisma.complianceAlert.create({
    data: {
      tenderId: doc.tenderId,
      entityType: 'COMPLIANCE_DOC',
      entityId: doc.id,
      alertType,
      severity,
      title: `${doc.name}`,
      message: messages[alertType] || `Alert for ${doc.name}`,
    },
  });
}

/**
 * Check for PF/ESIC compliance issues on employee exits
 */
async function checkEmployeeComplianceAlerts() {
  console.log('⏰ Running employee compliance check...');
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  // Employees exited but PF exit not filed
  const exitedWithoutPFClosure = await prisma.tenderEmployee.findMany({
    where: {
      exitDate: { not: null, lte: thirtyDaysAgo },
      pfExitFiled: false,
      isActive: false,
    },
    include: { employee: true, tender: true },
  });

  for (const te of exitedWithoutPFClosure) {
    const existing = await prisma.complianceAlert.findFirst({
      where: { entityId: te.id, alertType: 'EMPLOYEE_EXIT_PF_ACTIVE', isResolved: false },
    });
    if (!existing) {
      await prisma.complianceAlert.create({
        data: {
          tenderId: te.tenderId,
          entityType: 'EMPLOYEE',
          entityId: te.id,
          alertType: 'EMPLOYEE_EXIT_PF_ACTIVE',
          severity: 'HIGH',
          title: `PF Exit Not Filed — ${te.employee.name}`,
          message: `${te.employee.name} exited on ${te.exitDate?.toDateString()} but PF exit has not been filed with EPFO.`,
        },
      });
    }
  }

  console.log('✅ Employee compliance check complete');
}

function setupCronJobs() {
  // Run at 6:00 AM every day
  cron.schedule('0 6 * * *', () => {
    checkComplianceExpiry().catch(console.error);
    checkEmployeeComplianceAlerts().catch(console.error);
  });
  console.log('⏰ Cron jobs scheduled: Daily at 6:00 AM');
}

module.exports = { setupCronJobs, checkComplianceExpiry };

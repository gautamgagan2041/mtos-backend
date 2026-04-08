const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const tender = await prisma.tender.findUnique({
    where: { id: 'tender-iocl-lkh-2526' },
    select: { id: true, name: true, salaryStructureId: true },
  });
  console.log(JSON.stringify(tender, null, 2));
  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
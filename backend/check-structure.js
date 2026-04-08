const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const structures = await prisma.salaryStructure.findMany({
    include: {
      components: {
        include: { component: true },
        orderBy: { component: { displayOrder: 'asc' } },
      },
    },
  });

  structures.forEach(s => {
    console.log('\nStructure:', s.name, '| id:', s.id);
    if (!s.components.length) {
      console.log('  NO COMPONENTS');
      return;
    }
    s.components.forEach(c => {
      console.log(
        ' ', c.component.code.padEnd(12),
        '|', c.calculationType.padEnd(18),
        '| value:', c.value,
        '| formula:', c.formula,
        '| active:', c.isActive
      );
    });
  });

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });

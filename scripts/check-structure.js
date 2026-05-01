const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
async function main() {
  const structures = await prisma.salaryStructure.findMany({
    include: {
      components: {
        include: { component: true }
      }
    }
  });
  structures.forEach(s => {
    console.log('Structure:', s.name);
    s.components.forEach(c => {
      console.log(' ', c.component.code, '|', c.calculationType, '| value:', c.value, '| formula:', c.formula);
    });
  });
  await prisma.$disconnect();
}
main();

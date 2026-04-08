const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  // Get the structure
  const structure = await prisma.salaryStructure.findFirst({
    where: { name: 'security guards' },
    include: { components: { include: { component: true } } },
  });

  if (!structure) {
    console.log('Structure not found');
    return;
  }

  console.log('Fixing structure:', structure.name);

  for (const sc of structure.components) {
    const code = sc.component.code;

    if (code === 'ESIC_EE') {
      // ESIC EE = 0.75% of gross — but we handle this in engine
      // Set value to 0.75 so PERCENT_BASIC shows correctly
      await prisma.salaryStructureComponent.update({
        where: { id: sc.id },
        data: { value: 0.75 },
      });
      console.log('Fixed ESIC_EE: value set to 0.75');
    }

    if (code === 'PF_EE') {
      // PF_EE should NOT be a fixed component in structure
      // The engine calculates PF automatically from pfEngine
      // Deactivate this component — engine handles it
      await prisma.salaryStructureComponent.update({
        where: { id: sc.id },
        data: { isActive: false },
      });
      console.log('Deactivated PF_EE from structure — engine handles PF automatically');
    }
  }

  console.log('Done. Re-run payroll to see correct values.');
  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
/**
 * Marca como PERDIDAS las SIMs que siguen en poder de una persona que ya no trabaja.
 *
 * Asana: https://app.asana.com/1/12709793723059/project/1213523434401320/task/1217743599033214
 * Isaac Mayoral confirmó el 2026-08-28: "No se recuperaron".
 *
 *   npx tsx scripts/marcar-sims-perdidas-bait.ts --org-id=<id> --staff-id=<id> --staff-id=<id>
 *   ... --apply --actor-staff-id=<id> --expect-changes=<n>
 *
 * Sin --apply no escribe nada.
 *
 * 🔴 Por qué existe este script y no se usa `serializedInventoryService.markAsDamaged`:
 * esa función busca por la llave compuesta `venueId_serialNumber`, y las SIMs de este
 * cliente viven a nivel ORGANIZACIÓN (`venueId = null`), así que nunca las encontraría.
 * Aquí se replica EXACTAMENTE el mismo efecto que aplica esa función —estado DAMAGED
 * ("dañado o perdido"), custodia de vuelta al admin y asignaciones limpias— pero
 * localizando cada artículo por su id.
 */
import prisma from '../src/utils/prismaClient'

const arg = (name: string): string | undefined => process.argv.find(a => a.startsWith(`--${name}=`))?.split('=')[1]
const argAll = (name: string): string[] =>
  process.argv.filter(a => a.startsWith(`--${name}=`)).map(a => a.split('=')[1]).filter(Boolean)

const VALID_EXACT = ['--apply']
const VALID_PREFIX = ['--org-id=', '--staff-id=', '--actor-staff-id=', '--expect-changes=']

function validarBanderas(): void {
  const desconocidas = process.argv
    .slice(2)
    .filter(a => a.startsWith('--') && !VALID_EXACT.includes(a) && !VALID_PREFIX.some(p => a.startsWith(p)))
  if (desconocidas.length) {
    throw new Error(`Bandera(s) no reconocida(s): ${desconocidas.join(', ')}.\nVálidas: ${[...VALID_EXACT, ...VALID_PREFIX].join(', ')}`)
  }
}

const ORG_ID = arg('org-id')
const STAFF_IDS = argAll('staff-id')
const APPLY = process.argv.includes('--apply')

async function main() {
  validarBanderas()
  if (!ORG_ID) throw new Error('Falta --org-id=<id de la organización>')
  if (!STAFF_IDS.length) throw new Error('Falta al menos un --staff-id=<id>')

  console.log(`\n=== Marcar SIMs como perdidas (${APPLY ? 'APPLY' : 'DRY-RUN'}) ===\n`)

  const org = await prisma.organization.findUnique({ where: { id: ORG_ID }, select: { id: true, name: true } })
  if (!org) throw new Error(`No encontré la organización ${ORG_ID}`)
  console.log(`Organización: ${org.name} (${org.id})\n`)

  const personas = await prisma.staff.findMany({
    where: { id: { in: STAFF_IDS }, organizations: { some: { organizationId: org.id } } },
    select: { id: true, firstName: true, lastName: true, active: true },
  })
  const faltantes = STAFF_IDS.filter(id => !personas.some(p => p.id === id))
  if (faltantes.length) throw new Error(`Estas personas no existen o no pertenecen a la organización: ${faltantes.join(', ')}`)

  // Sólo lo que la persona TODAVÍA trae: ni vendido, ni ya marcado como perdido.
  const porPersona = await Promise.all(
    personas.map(async persona => {
      const items = await prisma.serializedItem.findMany({
        where: {
          organizationId: org.id,
          assignedPromoterId: persona.id,
          custodyState: { not: 'SOLD' },
          status: { notIn: ['SOLD', 'DAMAGED'] },
        },
        select: { id: true, serialNumber: true, status: true, custodyState: true },
      })
      return { persona, items }
    }),
  )

  let total = 0
  for (const { persona, items } of porPersona) {
    const nombre = `${persona.firstName} ${persona.lastName}`
    console.log(`— ${nombre}${persona.active ? '' : ' (cuenta ya inactiva)'}: ${items.length} SIM(s) —`)
    if (items.length) {
      const estados = [...new Set(items.map(i => `${i.status}/${i.custodyState}`))].join(', ')
      console.log(`   estados actuales: ${estados}`)
      console.log(`   ejemplos: ${items.slice(0, 3).map(i => i.serialNumber).join(', ')}${items.length > 3 ? ' …' : ''}`)
    }
    total += items.length
  }

  console.log(`\n=== Resumen ===\nSIMs a marcar como perdidas: ${total}`)

  const esperadas = arg('expect-changes')
  if (esperadas !== undefined) {
    const n = Number(esperadas)
    if (!Number.isInteger(n) || n < 0) throw new Error('--expect-changes debe ser un entero mayor o igual a 0')
    if (n !== total) throw new Error(`Esperaba ${n} SIMs y el plan tiene ${total}. Revisa antes de aplicar.`)
    console.log(`Coincide con --expect-changes=${n} ✓`)
  }

  if (!APPLY) {
    console.log('\nDry-run: no se modificó nada. Corre con --apply para escribir.')
    return
  }

  if (esperadas === undefined) {
    console.log('\n⚠️  Aplicando SIN --expect-changes: nada verifica que sea el mismo número que revisaste.')
  }

  const actorId = arg('actor-staff-id')
  if (!actorId) throw new Error('Falta --actor-staff-id=<id> — la bitácora necesita saber quién ejecutó el cambio')
  const actor = await prisma.staff.findFirst({
    where: { id: actorId, organizations: { some: { organizationId: org.id } } },
    select: { id: true },
  })
  if (!actor) throw new Error(`El actor ${actorId} no existe o no pertenece a esta organización`)

  for (const { persona, items } of porPersona) {
    if (!items.length) continue

    // Mismo efecto que serializedInventoryService.markAsDamaged, pero por id:
    // fuera de la cadena vendible y la custodia regresa al admin.
    await prisma.serializedItem.updateMany({
      where: { id: { in: items.map(i => i.id) } },
      data: {
        status: 'DAMAGED',
        custodyState: 'ADMIN_HELD',
        assignedSupervisorId: null,
        assignedSupervisorAt: null,
        assignedPromoterId: null,
        assignedPromoterAt: null,
        promoterAcceptedAt: null,
        promoterRejectedAt: null,
      },
    })

    // Una fila por PERSONA, con los seriales dentro: es lo que un dueño audita
    // ("se dieron por perdidas 93 SIMs de X"), sin inflar la bitácora con 141 filas.
    await prisma.activityLog.create({
      data: {
        action: 'SIM_MARCADA_PERDIDA',
        entity: 'Staff',
        entityId: persona.id,
        staffId: actor.id,
        actorStaffId: actor.id,
        actorType: 'HUMAN',
        organizationId: org.id,
        data: {
          origen: 'marcar-sims-perdidas-bait',
          motivo: 'La persona dejó la empresa y las SIMs no se recuperaron (confirmado por el cliente en Asana)',
          promotor: `${persona.firstName} ${persona.lastName}`,
          cantidad: items.length,
          seriales: items.map(i => i.serialNumber),
        },
      },
    })

    console.log(`  ✓ ${persona.firstName} ${persona.lastName}: ${items.length} marcadas como perdidas`)
  }

  console.log(`\n✅ Listo. ${total} SIM(s) marcadas como perdidas.`)
}

main()
  .catch(error => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())

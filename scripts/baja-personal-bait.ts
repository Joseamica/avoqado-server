/**
 * Da de baja personal de PlayTelecom (u otra organización) de forma segura: NUNCA borra filas,
 * sólo desactiva. Re-ejecutable e idempotente — correrlo dos veces sobre la misma persona ya dada
 * de baja no produce cambios ni ActivityLog duplicado.
 *
 *   npx tsx scripts/baja-personal-bait.ts --org-id=<id> --staff-ids=<id1,id2,...>            # dry-run
 *   npx tsx scripts/baja-personal-bait.ts --org-id=<id> --staff-ids=<...> \
 *     --apply --actor-staff-id=<id>                                                          # escribe
 *
 * Por cada persona:
 *   - Verifica que pertenezca a la organización que se pasa (vía StaffOrganization). Si no, se
 *     reporta y se OMITE — nunca se toca a alguien de otra organización.
 *   - Pone Staff.active=false y TODAS sus filas StaffVenue.active=false, estampando endDate con
 *     la fecha actual en esas filas (mismo patrón que el conciliador: active=false + endDate,
 *     nunca un DELETE — hay órdenes, pagos, verificaciones de venta e inventario serializado con
 *     llave foránea a la persona).
 *   - Antes de aplicar, cuenta y reporta cuántas SIMs tiene en custodia
 *     (SerializedItem.assignedPromoterId, custodyState != SOLD) y cuántas ventas sin verificar.
 *     Si alguna persona trae SIMs en custodia, --apply ABORTA ENTERO (nada se escribe) con un
 *     mensaje explicando que hay que recogerlas primero — salvo que se pase --permitir-con-sims.
 *     Las ventas pendientes son informativas: nunca bloquean (la verificación sigue viva contra
 *     la organización, no contra si la persona sigue activa).
 *   - Escribe una fila de ActivityLog por persona (actor, organización, detalle: tiendas que
 *     dejó, SIMs en custodia, ventas pendientes).
 *
 * --apply exige --actor-staff-id (debe ser una persona real de la organización; queda en
 * ActivityLog.staffId/actorStaffId), igual que el conciliador.
 *
 * Banderas:
 *   --permitir-con-sims   deja aplicar aunque alguna persona traiga SIMs en custodia. Úsala sólo
 *                         cuando ya se resolvió qué pasa con esas SIMs (recolectadas o aceptado
 *                         el riesgo) — por defecto el script ABORTA para evitar perder el rastro
 *                         de custodia física.
 */
import { SaleVerificationStatus } from '@prisma/client'
import prisma from '../src/utils/prismaClient'

const arg = (name: string): string | undefined => process.argv.find(a => a.startsWith(`--${name}=`))?.split('=')[1]

const VALID_FLAG_PREFIXES = ['--org-id=', '--staff-ids=', '--actor-staff-id=']
const VALID_FLAG_EXACT = ['--apply', '--permitir-con-sims']

function validarBanderas(argv: string[]): void {
  const desconocidas = argv.filter(
    a => a.startsWith('--') && !VALID_FLAG_EXACT.includes(a) && !VALID_FLAG_PREFIXES.some(prefix => a.startsWith(prefix)),
  )
  if (desconocidas.length) {
    throw new Error(
      `Bandera(s) no reconocida(s): ${desconocidas.join(', ')}.\n` + `Válidas: ${[...VALID_FLAG_EXACT, ...VALID_FLAG_PREFIXES].join(', ')}`,
    )
  }
}

// Mismos estados "finales" que el conciliador (conciliar-estructura-bait.ts): la venta se contó
// (COMPLETED), se perdió (REJECTED) o no requería revisión (SKIPPED). PENDING/PROCESSING/FAILED
// siguen abiertos — FAILED especialmente, porque "Revisar" espera que el promotor corrija.
const FINAL_SALE_VERIFICATION_STATUSES: SaleVerificationStatus[] = [
  SaleVerificationStatus.COMPLETED,
  SaleVerificationStatus.REJECTED,
  SaleVerificationStatus.SKIPPED,
]

const ORG_ID = arg('org-id')
const APPLY = process.argv.includes('--apply')
const PERMITIR_CON_SIMS = process.argv.includes('--permitir-con-sims')
const STAFF_IDS = [
  ...new Set(
    (arg('staff-ids') ?? '')
      .split(',')
      .map(id => id.trim())
      .filter(Boolean),
  ),
]

interface Candidato {
  id: string
  nombre: string
  active: boolean
  staffVenues: Array<{ id: string; venueId: string; venueName: string; active: boolean }>
  simsEnCustodia: number
  ventasPendientes: number
}

async function main() {
  validarBanderas(process.argv.slice(2))

  if (!ORG_ID) throw new Error('Falta --org-id=<id de la organización>')
  if (!STAFF_IDS.length) throw new Error('Falta --staff-ids=<id1,id2,...>')

  console.log(`\n=== Baja de personal BAIT (${APPLY ? 'APPLY' : 'DRY-RUN'}) ===`)

  const org = await prisma.organization.findUnique({ where: { id: ORG_ID }, select: { id: true, name: true } })
  if (!org) throw new Error(`No encontré la organización ${ORG_ID}`)
  console.log(`Organización: ${org.name} (${org.id})`)
  console.log(`Personas solicitadas: ${STAFF_IDS.length}\n`)

  const staffRows = await prisma.staff.findMany({
    where: { id: { in: STAFF_IDS } },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      active: true,
      organizations: { where: { organizationId: org.id }, select: { organizationId: true } },
    },
  })
  const staffById = new Map(staffRows.map(s => [s.id, s]))

  const omitidos: Array<{ id: string; razon: string }> = []
  const candidatos: Candidato[] = []

  for (const id of STAFF_IDS) {
    const staff = staffById.get(id)
    if (!staff) {
      omitidos.push({ id, razon: 'No existe ningún Staff con ese id' })
      continue
    }
    if (staff.organizations.length === 0) {
      omitidos.push({ id, razon: `No pertenece a la organización "${org.name}" — se omite, nunca se toca a alguien de otra org` })
      continue
    }

    const staffVenues = await prisma.staffVenue.findMany({
      where: { staffId: id },
      select: { id: true, venueId: true, active: true, venue: { select: { name: true } } },
    })
    const simsEnCustodia = await prisma.serializedItem.count({ where: { assignedPromoterId: id, custodyState: { not: 'SOLD' } } })
    const ventasPendientes = await prisma.saleVerification.count({
      where: { staffId: id, status: { notIn: FINAL_SALE_VERIFICATION_STATUSES } },
    })

    candidatos.push({
      id,
      nombre: `${staff.firstName} ${staff.lastName}`,
      active: staff.active,
      staffVenues: staffVenues.map(sv => ({ id: sv.id, venueId: sv.venueId, venueName: sv.venue.name, active: sv.active })),
      simsEnCustodia,
      ventasPendientes,
    })
  }

  if (omitidos.length) {
    console.log(`— Omitidas (${omitidos.length}) — se reportan, NUNCA se tocan —`)
    for (const o of omitidos) console.log(`  ! ${o.id}: ${o.razon}`)
    console.log()
  }

  console.log(`— Se darían de baja (${candidatos.length}) —`)
  for (const c of candidatos) {
    const tiendasActivas = c.staffVenues.filter(sv => sv.active)
    const yaDeBaja = !c.active && tiendasActivas.length === 0
    console.log(
      `  · ${c.nombre} (${c.id})${yaDeBaja ? ' — YA ESTÁ DE BAJA, sin cambios que aplicar' : ''}\n` +
        `      tiendas activas que deja: ${tiendasActivas.length} (${tiendasActivas.map(sv => sv.venueName).join(', ') || '(ninguna)'})\n` +
        `      SIMs en custodia: ${c.simsEnCustodia}${c.simsEnCustodia > 0 ? ' 🔴' : ''} · ventas sin verificar: ${c.ventasPendientes}`,
    )
  }
  console.log()

  const conSims = candidatos.filter(c => c.simsEnCustodia > 0)
  if (conSims.length) {
    console.log(`🔴 ${conSims.length} persona(s) traen SIMs en custodia — recójelas antes de dar de baja, o pasa --permitir-con-sims:`)
    for (const c of conSims) console.log(`  ⨯ ${c.nombre} (${c.id}): ${c.simsEnCustodia} SIM(s)`)
    console.log()
  }

  if (!APPLY) {
    console.log('Dry-run: no se modificó nada. Corre con --apply para escribir.')
    return
  }

  const actorId = arg('actor-staff-id')
  if (!actorId) throw new Error('Falta --actor-staff-id=<id> — ActivityLog necesita saber quién ejecutó el cambio')

  // Igual que el conciliador: valida ANTES de escribir nada que el actor sea una persona real de
  // ESTA organización. Sin esto, un --actor-staff-id mal tecleado revienta hasta el primer
  // ActivityLog.create (FK), con la primera mutación YA escrita y sin quedar auditada.
  const actor = await prisma.staff.findFirst({
    where: { id: actorId, organizations: { some: { organizationId: org.id } } },
    select: { id: true },
  })
  if (!actor) {
    throw new Error(
      `--actor-staff-id=${actorId} no corresponde a una persona de la organización "${org.name}" (${org.id}). ` +
        `Verifica el id antes de reintentar.`,
    )
  }

  // Aborta TODO el --apply si alguien trae SIMs en custodia — nada se escribe, ni para las
  // personas sin SIMs. Es la misma filosofía que "sin tienda tras aplicar" del conciliador:
  // mejor frenar entero y que el operador decida, que aplicar a medias.
  if (conSims.length && !PERMITIR_CON_SIMS) {
    const nombres = conSims.map(c => `${c.nombre} (${c.id}): ${c.simsEnCustodia} SIM(s)`).join('; ')
    throw new Error(
      `${conSims.length} persona(s) traen SIMs en custodia: ${nombres}. ` +
        `Recógelas primero (reasígnalas a otro promotor o al supervisor) antes de dar de baja. ` +
        `Si ya resolviste qué pasa con ellas, vuelve a correr con --permitir-con-sims.`,
    )
  }

  let aplicados = 0
  let saltados = 0
  for (const c of candidatos) {
    const tiendasActivas = c.staffVenues.filter(sv => sv.active)
    const yaDeBaja = !c.active && tiendasActivas.length === 0
    if (yaDeBaja) {
      saltados++
      continue
    }

    await prisma.$transaction(async tx => {
      await tx.staff.update({ where: { id: c.id }, data: { active: false } })
      if (tiendasActivas.length) {
        // pin: null — el PIN se devuelve a la tienda al dar de baja; retenerlo bloquea
        // reasignarlo (el @@unique([venueId, pin]) cuenta también filas inactivas).
        await tx.staffVenue.updateMany({
          where: { staffId: c.id, active: true },
          data: { active: false, endDate: new Date(), pin: null },
        })
      }
      await tx.activityLog.create({
        data: {
          action: 'STAFF_DEACTIVATED',
          entity: 'Staff',
          entityId: c.id,
          staffId: actorId,
          actorType: 'HUMAN',
          actorStaffId: actorId,
          organizationId: org.id,
          data: {
            origen: 'baja-personal-bait',
            staffName: c.nombre,
            tiendasDesactivadas: tiendasActivas.map(sv => sv.venueName),
            simsEnCustodiaAlMomento: c.simsEnCustodia,
            ventasPendientesAlMomento: c.ventasPendientes,
            permitirConSims: PERMITIR_CON_SIMS,
          },
        },
      })
    })
    aplicados++
  }

  console.log(`\n✅ Dadas de baja ${aplicados} persona(s).${saltados ? ` ${saltados} ya estaban de baja (sin cambios).` : ''}`)
}

main()
  .catch(error => {
    console.error(error)
    // process.exitCode (no process.exit): ver la misma nota en conciliar-estructura-bait.ts — deja
    // que el .finally() de abajo desconecte Prisma antes de que Node salga.
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())

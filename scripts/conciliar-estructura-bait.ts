/**
 * Concilia la estructura organizacional de PlayTelecom contra "Estructura BAIT.xlsx".
 *
 * Diseño: docs/superpowers/specs/2026-08-23-estructura-bait-conciliador-design.md
 * Asana:  https://app.asana.com/1/12709793723059/project/1213523434401320/task/1217743599033214
 *
 *   npx tsx scripts/conciliar-estructura-bait.ts --file=<ruta.xlsx> --org-id=<id>            # dry-run
 *   npx tsx scripts/conciliar-estructura-bait.ts --file=<ruta.xlsx> --org-id=<id> --apply    # escribe
 *
 * Banderas (apagadas por defecto, esperan respuesta del cliente):
 *   --baja-ausentes      cierra los venues con ID de tienda que ya no vienen en el Excel
 *   --vacantes=libre     desasigna al promotor actual de una tienda marcada vacante
 */
import * as XLSX from 'xlsx'
import prisma from '../src/utils/prismaClient'
import { ProdStaff } from './lib/baitStructure/identity'
import { parseStructure } from './lib/baitStructure/parseStructure'
import { Change, PlanOptions, planChanges, ProdSnapshot } from './lib/baitStructure/planChanges'

const arg = (name: string): string | undefined => process.argv.find(a => a.startsWith(`--${name}=`))?.split('=')[1]

const FILE = arg('file')
const ORG_ID = arg('org-id')
const APPLY = process.argv.includes('--apply')
const OPTIONS: PlanOptions = {
  bajaAusentes: process.argv.includes('--baja-ausentes'),
  vacantes: arg('vacantes') === 'libre' ? 'libre' : 'conservar',
}

const TERMINAL_EMAIL = /^tpv-.*@internal\.avoqado\.io$/i

async function readSnapshot(orgId: string): Promise<ProdSnapshot> {
  const venues = await prisma.venue.findMany({
    where: { organizationId: orgId },
    select: { id: true, name: true, status: true },
  })

  const links = await prisma.staffVenue.findMany({
    where: { venue: { organizationId: orgId } },
    select: {
      staffId: true,
      venueId: true,
      role: true,
      active: true,
      staff: { select: { id: true, firstName: true, lastName: true, employeeCode: true, active: true, email: true } },
    },
  })

  const staff = new Map<string, ProdStaff>()
  for (const link of links) {
    if (!staff.has(link.staff.id)) {
      staff.set(link.staff.id, {
        id: link.staff.id,
        firstName: link.staff.firstName,
        lastName: link.staff.lastName,
        employeeCode: link.staff.employeeCode,
        active: link.staff.active,
        isTerminalAccount: TERMINAL_EMAIL.test(link.staff.email ?? ''),
      })
    }
  }

  return {
    venues: venues.map(v => ({ id: v.id, name: v.name, status: String(v.status) })),
    staff: [...staff.values()],
    assignments: links.map(l => ({ staffId: l.staffId, venueId: l.venueId, role: String(l.role), active: l.active })),
  }
}

function describe(change: Change): string {
  switch (change.kind) {
    case 'SET_EMPLOYEE_CODE':
      return `  # ${change.staffName}: número de empleado ${change.from ?? '∅'} → ${change.to}`
    case 'ASSIGN_MANAGER':
      return `  + ${change.venueName}: supervisor → ${change.staffName}`
    case 'UNASSIGN_MANAGER':
      return `  − ${change.venueName}: deja de ser supervisor ${change.staffName}`
    case 'ASSIGN_PROMOTER':
      return `  + ${change.venueName}: promotor → ${change.staffName}`
    case 'UNASSIGN_PROMOTER':
      return `  − ${change.venueName}: deja de ser promotor ${change.staffName}`
    case 'CLOSE_VENUE':
      return `  ⨯ ${change.venueName}: ${change.from} → CLOSED`
  }
}

async function main() {
  if (!FILE) throw new Error('Falta --file=<ruta al .xlsx>')
  if (!ORG_ID) throw new Error('Falta --org-id=<id de la organización>')

  console.log(`\n=== Conciliador de estructura BAIT (${APPLY ? 'APPLY' : 'DRY-RUN'}) ===`)
  console.log(`Archivo: ${FILE}`)
  console.log(`Banderas: baja-ausentes=${OPTIONS.bajaAusentes} · vacantes=${OPTIONS.vacantes}\n`)

  const org = await prisma.organization.findUnique({ where: { id: ORG_ID }, select: { id: true, name: true } })
  if (!org) throw new Error(`No encontré la organización ${ORG_ID}`)
  console.log(`Organización: ${org.name} (${org.id})\n`)

  const rows = parseStructure(XLSX.readFile(FILE))
  const snapshot = await readSnapshot(org.id)
  const plan = planChanges(rows, snapshot, OPTIONS)

  console.log(`Filas del Excel: ${rows.length} · Venues: ${snapshot.venues.length} · Personas: ${snapshot.staff.length}\n`)

  const grouped = new Map<Change['kind'], Change[]>()
  for (const change of plan.changes) grouped.set(change.kind, [...(grouped.get(change.kind) ?? []), change])

  for (const [kind, list] of grouped) {
    console.log(`— ${kind} (${list.length}) —`)
    for (const change of list) console.log(describe(change))
    console.log()
  }
  if (plan.changes.length === 0) console.log('Sin cambios: la estructura ya coincide con el archivo.\n')

  if (plan.unresolved.length) {
    console.log(`— No resueltas (${plan.unresolved.length}) — se reportan, NO se adivinan —`)
    for (const item of plan.unresolved) {
      console.log(
        `  ? ${item.row.fullName} [${item.row.employeeCode}] → ${item.reason}${item.candidates ? ` candidatos: ${item.candidates.join(', ')}` : ''}`,
      )
    }
    console.log()
  }

  if (plan.missingVenues.length) {
    console.log(`— Tiendas del Excel que no existen (${plan.missingVenues.length}) —`)
    for (const row of plan.missingVenues) console.log(`  ! ${row.storeId} ${row.formato ?? ''} ${row.storeName ?? ''}`)
    console.log()
  }

  if (plan.orphanVenues.length) {
    console.log(
      `— Sucursales sin fila en el Excel (${plan.orphanVenues.length})${OPTIONS.bajaAusentes ? '' : ' — solo informativo, usa --baja-ausentes para cerrarlas'} —`,
    )
    for (const venue of plan.orphanVenues) console.log(`  · ${venue.name}`)
    console.log()
  }

  console.log('=== Resumen ===')
  console.log(
    `Cambios propuestos: ${plan.changes.length} · Sin resolver: ${plan.unresolved.length} · Tiendas faltantes: ${plan.missingVenues.length} · Huérfanas: ${plan.orphanVenues.length}`,
  )
  console.log('\nDry-run: no se modificó nada. Corre con --apply para escribir.')
}

main()
  .catch(error => {
    console.error(error)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())

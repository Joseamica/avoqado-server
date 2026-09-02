/**
 * Concilia la estructura organizacional de PlayTelecom contra "Estructura BAIT.xlsx".
 *
 * Diseño: docs/superpowers/specs/2026-08-23-estructura-bait-conciliador-design.md
 * Asana:  https://app.asana.com/1/12709793723059/project/1213523434401320/task/1217743599033214
 *
 *   npx tsx scripts/conciliar-estructura-bait.ts --file=<ruta.xlsx> --org-id=<id>            # dry-run
 *   npx tsx scripts/conciliar-estructura-bait.ts --file=<ruta.xlsx> --org-id=<id> \
 *     --apply --actor-staff-id=<id> --expect-changes=<n>                                     # escribe
 *
 * --apply exige --actor-staff-id (debe ser una persona real de la organización; queda en
 * ActivityLog.staffId/actorStaffId) y aborta si quedan renglones sin resolver. Antes de
 * desasignar promotores avisa cuántas SIMs en custodia y ventas sin verificar trae la persona —
 * no bloquea, la custodia es a nivel organización y sigue a la persona.
 *
 * --expect-changes=<n> ata la escritura al diff que revisaste: si el número de cambios
 * planeados en el momento de aplicar no coincide, aborta sin escribir nada. Opcional, pero sin
 * él nada garantiza que lo que apruebas sea lo que se aplica.
 *
 * Banderas (apagadas por defecto, esperan respuesta del cliente):
 *   --baja-ausentes         cierra los venues con ID de tienda que ya no vienen en el Excel
 *   --vacantes=libre        desasigna al promotor actual de una tienda marcada vacante
 *   --supervisor-exclusivo  a cada supervisor QUE APARECE EN EL ARCHIVO le deja solo los venues que
 *                           el archivo le asigna; desasigna sus demás venues de supervisor activos
 *   --permitir-sin-tienda   deja aplicar aunque el plan deje a alguien sin NINGUNA tienda activa —
 *                           úsala solo cuando esa persona de verdad se va de la empresa
 *   --proteger-staff=<id1,id2,...>  esas personas NUNCA aparecen en un cambio de baja
 *                           (UNASSIGN_PROMOTER ni UNASSIGN_MANAGER), sin importar qué diga el
 *                           archivo ni qué otra bandera esté activa. Pensada para cuentas que no
 *                           son una persona real (p.ej. una cuenta genérica de carga manual de
 *                           ventas) que el cliente pidió dejar tal cual. Sí pueden recibir una
 *                           asignación si el archivo las designa — la protección es solo sobre
 *                           las bajas.
 */
import * as XLSX from 'xlsx'
import { SaleVerificationStatus } from '@prisma/client'
import prisma from '../src/utils/prismaClient'
import { ProdStaff } from './lib/baitStructure/identity'
import { parseStructure } from './lib/baitStructure/parseStructure'
import { StructureRow } from './lib/baitStructure/types'
import { Change, PinPlan, PlanOptions, planChanges, ProdSnapshot } from './lib/baitStructure/planChanges'

const arg = (name: string): string | undefined => process.argv.find(a => a.startsWith(`--${name}=`))?.split('=')[1]

// Banderas válidas. Una mal escrita antes se ignoraba en silencio — y el diseño llegó a anunciar
// banderas que este script nunca implementó (--alta-nuevas, --mover-activaciones), así que
// escribirlas hoy debe abortar en vez de dar a entender que hicieron algo.
const VALID_FLAG_PREFIXES = ['--file=', '--org-id=', '--vacantes=', '--actor-staff-id=', '--expect-changes=', '--proteger-staff=']
const VALID_FLAG_EXACT = ['--apply', '--baja-ausentes', '--supervisor-exclusivo', '--permitir-sin-tienda']

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

/**
 * Filas del Excel sin ID de tienda porque no corresponden a una sucursal física: los "Cubre
 * descanso" (relevo de vacaciones/descanso de un promotor titular) y los dos promotores de
 * "ACTIVACIONES" (altas nuevas, sin mostrador fijo). Sin este mapa, `planChanges` los ignora y esas
 * personas terminan sin ninguna tienda activa. Llave = cómo aparece en el archivo (nombre de tienda
 * del promotor, o el puesto para Cubre descanso); valor = nombre EXACTO del venue en la base — el
 * emparejamiento contra ese nombre es insensible a acentos/mayúsculas.
 */
const VENUES_SIN_ID: Record<string, string> = {
  ACTIVACIONES: 'ACTIVACIÓN SLP',

  // 🔴 Los "Cubre descanso" van por NÚMERO DE EMPLEADO, no por el literal del puesto.
  // Compartiendo una sola tienda todos colgaban del mismo supervisor —una tienda tiene UNO— y
  // era imposible cumplir lo que pidió Isaac el 1-sep-2026: José con Juan, los otros dos con
  // René. Cada uno vive ahora en su tienda de zona (`separar-cubre-descanso-zonas.ts`).
  BSCBJOSE04: 'CUBRE DESCANSO ZONA SUR1', // José Lopes → Juan Nájera
  BESDICC9701: 'CUBRE DESCANSO ZONA NORTE1', // Carlos Vicente Díaz → René Cubos

  // Respaldo para un relevo sin entrada propia. Apunta a SUR1 —la tienda que ya existía, sólo
  // renombrada— a propósito: es donde están hoy, así que nadie se queda sin tienda mientras
  // falte crear la ZONA NORTE2 de Heavan Leigh (BSCLOXH0405), que espera decisión sobre sus
  // 140 ventas históricas. Cuando exista, se le añade su entrada propia aquí.
  CUBRE_DESCANSO: 'CUBRE DESCANSO ZONA SUR1',
}

const FILE = arg('file')
const ORG_ID = arg('org-id')
const APPLY = process.argv.includes('--apply')
const PERMITIR_SIN_TIENDA = process.argv.includes('--permitir-sin-tienda')
const PROTEGER_STAFF_IDS = (arg('proteger-staff') ?? '')
  .split(',')
  .map(id => id.trim())
  .filter(Boolean)
const OPTIONS: PlanOptions = {
  bajaAusentes: process.argv.includes('--baja-ausentes'),
  vacantes: arg('vacantes') === 'libre' ? 'libre' : 'conservar',
  venuesSinId: VENUES_SIN_ID,
  supervisorExclusivo: process.argv.includes('--supervisor-exclusivo'),
  protegerStaffIds: PROTEGER_STAFF_IDS,
}

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
      // Para la herencia de PIN al crear un registro nuevo: qué PIN tiene ya la persona en otras
      // tiendas, y cuál de esas asignaciones es la más reciente (planChanges.ts → scoreRecency).
      pin: true,
      startDate: true,
      endDate: true,
      staff: { select: { id: true, firstName: true, lastName: true, employeeCode: true, active: true } },
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
      })
    }
  }

  return {
    venues: venues.map(v => ({ id: v.id, name: v.name, status: String(v.status) })),
    staff: [...staff.values()],
    assignments: links.map(l => ({
      staffId: l.staffId,
      venueId: l.venueId,
      role: String(l.role),
      active: l.active,
      pin: l.pin,
      startDate: l.startDate,
      endDate: l.endDate,
    })),
  }
}

/**
 * Toda la jerarquía depende de que el Excel venga ordenado: cada promotor (y cubre-descanso)
 * cuelga del último supervisor leído arriba (`parseStructure.ts`). Si el cliente reordena la hoja,
 * todos colgarían del primer supervisor y el plan saldría plausible pero equivocado — se imprime
 * la distribución ANTES del diff para que eso se note a simple vista.
 */
function printSupervisorDistribution(rows: StructureRow[]): void {
  const supervisorNames = new Map<string, string>()
  for (const row of rows) {
    if (row.puesto === 'SUPERVISOR') supervisorNames.set(row.employeeCode, row.fullName)
  }

  const counts = new Map<string, number>()
  for (const row of rows) {
    if (row.puesto === 'SUPERVISOR' || !row.supervisorCode) continue
    counts.set(row.supervisorCode, (counts.get(row.supervisorCode) ?? 0) + 1)
  }

  console.log('— Distribución por supervisor —')
  const total = [...counts.values()].reduce((sum, n) => sum + n, 0)
  let max = 0
  for (const [code, count] of counts) {
    console.log(`  · ${supervisorNames.get(code) ?? code}: ${count}`)
    if (count > max) max = count
  }
  console.log()

  if (counts.size > 1 && max === total) {
    console.log(
      '⚠️  UN SOLO supervisor concentra a TODOS los demás — el archivo probablemente viene reordenado. Revísalo antes de continuar.\n',
    )
  }
}

const PIN_SIN_RAZON: Record<Extract<PinPlan, { status: 'SIN_PIN' }>['reason'], string> = {
  SIN_PRECEDENTE: 'no tiene PIN en ninguna otra tienda',
  PIN_OCUPADO_EN_DESTINO: 'el PIN que heredaría ya está ocupado en esta tienda',
  AMBIGUO: 'tiene varios PINs distintos en otras tiendas y no está claro cuál heredar',
}

/** Anota, en la línea de un ASSIGN que crea un registro nuevo, qué PIN heredaría o por qué se
 * quedará sin uno — antes de escribir, no después. Vacío si el ASSIGN es una reactivación (rama
 * `update`): ahí `pinPlan` nunca se calculó porque el PIN existente no se toca. */
function describePinPlan(pinPlan: PinPlan | undefined): string {
  if (!pinPlan) return ''
  if (pinPlan.status === 'INHERIT') return `  [PIN heredado de ${pinPlan.fromVenueName}: ${pinPlan.pin}]`
  return `  [🔴 SIN PIN — ${PIN_SIN_RAZON[pinPlan.reason]}: asígnalo a mano o no podrá entrar a la terminal]`
}

function describe(change: Change): string {
  switch (change.kind) {
    case 'SET_EMPLOYEE_CODE':
      return `  # ${change.staffName}: número de empleado ${change.from ?? '∅'} → ${change.to}`
    case 'ASSIGN_MANAGER':
      return `  + ${change.venueName}: supervisor → ${change.staffName}${describePinPlan(change.pinPlan)}`
    case 'UNASSIGN_MANAGER':
      return `  − ${change.venueName}: deja de ser supervisor ${change.staffName}`
    case 'ASSIGN_PROMOTER':
      return `  + ${change.venueName}: promotor → ${change.staffName}${describePinPlan(change.pinPlan)}`
    case 'UNASSIGN_PROMOTER':
      return `  − ${change.venueName}: deja de ser promotor ${change.staffName}`
    case 'CLOSE_VENUE':
      return `  ⨯ ${change.venueName}: ${change.from} → CLOSED`
  }
}

const ACTIVITY_ACTION: Record<Change['kind'], string> = {
  SET_EMPLOYEE_CODE: 'STAFF_EMPLOYEE_CODE_SET',
  ASSIGN_MANAGER: 'STAFF_VENUE_ROLE_CHANGED',
  UNASSIGN_MANAGER: 'STAFF_VENUE_DEACTIVATED',
  ASSIGN_PROMOTER: 'STAFF_VENUE_ROLE_CHANGED',
  UNASSIGN_PROMOTER: 'STAFF_VENUE_DEACTIVATED',
  CLOSE_VENUE: 'VENUE_STATUS_CHANGED',
}

// Estados de SaleVerification que ya llegaron a un desenlace: la venta se contó (COMPLETED), se
// perdió (REJECTED) o no requería revisión (SKIPPED). PENDING/PROCESSING/FAILED siguen abiertos —
// FAILED especialmente, porque "Revisar" espera que el promotor corrija, no es un cierre.
const FINAL_SALE_VERIFICATION_STATUSES: SaleVerificationStatus[] = [
  SaleVerificationStatus.COMPLETED,
  SaleVerificationStatus.REJECTED,
  SaleVerificationStatus.SKIPPED,
]

/**
 * Cuenta las SIMs en custodia Y las ventas pendientes de verificación de quien va a salir de una
 * tienda. No bloquea: informa. En este cliente una venta sin verificar es dinero que Walmart
 * todavía no le paga a PlayTelecom, así que es tan relevante como la custodia física.
 */
async function warnAboutCustody(changes: Change[]): Promise<void> {
  const leaving = [...new Set(changes.filter(c => c.kind === 'UNASSIGN_PROMOTER').map(c => (c as { staffId: string }).staffId))]
  if (!leaving.length) return

  console.log('— Revisión de custodia antes de desasignar —')
  for (const staffId of leaving) {
    const sims = await prisma.serializedItem.count({ where: { assignedPromoterId: staffId, custodyState: { not: 'SOLD' } } })
    const ventasPendientes = await prisma.saleVerification.count({
      where: { staffId, status: { notIn: FINAL_SALE_VERIFICATION_STATUSES } },
    })
    const nombre = changes.find(c => 'staffId' in c && c.staffId === staffId && 'staffName' in c)
    const nombreStr = (nombre as { staffName?: string })?.staffName ?? staffId
    console.log(`  · ${nombreStr}: ${sims} SIM(s) en custodia, ${ventasPendientes} venta(s) sin verificar (se quedan con la persona)`)
  }
  console.log()
}

async function applyChanges(changes: Change[], actorStaffId: string, organizationId: string): Promise<void> {
  for (const change of changes) {
    // Id de la fila StaffVenue realmente tocada — se usa para que ActivityLog.entity='StaffVenue'
    // apunte a esa fila (su propio id), no al id de la persona. Mismo patrón que
    // src/mcp/tools/staff.ts (entity:'StaffVenue', entityId: <id de la fila>).
    let staffVenueId: string | undefined

    switch (change.kind) {
      case 'SET_EMPLOYEE_CODE':
        await prisma.staff.update({ where: { id: change.staffId }, data: { employeeCode: change.to } })
        break
      case 'ASSIGN_MANAGER':
      case 'ASSIGN_PROMOTER': {
        // El PIN SOLO se manda en `create` — nunca en `update`. Si la persona ya tenía fila en esta
        // tienda (reactivación), su PIN es el suyo y no se toca; `change.pinPlan` ni siquiera se
        // calculó para ese caso (ver `planPinIfCreate` en planChanges.ts).
        const inheritedPin = change.pinPlan?.status === 'INHERIT' ? change.pinPlan.pin : undefined
        const staffVenue = await prisma.staffVenue.upsert({
          where: { staffId_venueId: { staffId: change.staffId, venueId: change.venueId } },
          update: { role: change.kind === 'ASSIGN_MANAGER' ? 'MANAGER' : 'WAITER', active: true, endDate: null },
          create: {
            staffId: change.staffId,
            venueId: change.venueId,
            role: change.kind === 'ASSIGN_MANAGER' ? 'MANAGER' : 'WAITER',
            active: true,
            pin: inheritedPin,
          },
        })
        staffVenueId = staffVenue.id
        break
      }
      case 'UNASSIGN_MANAGER':
      case 'UNASSIGN_PROMOTER': {
        // Baja SOLO en este venue. Nunca Staff.active ni un DELETE. Mismo patrón que
        // removeTeamMember (team.dashboard.service.ts): active=false + endDate estampada — sin
        // endDate no queda registro de CUÁNDO salió, y este cliente reasigna ventas por fecha.
        const staffVenue = await prisma.staffVenue.update({
          where: { staffId_venueId: { staffId: change.staffId, venueId: change.venueId } },
          data: { active: false, endDate: new Date() },
        })
        staffVenueId = staffVenue.id
        break
      }
      case 'CLOSE_VENUE':
        await prisma.venue.update({ where: { id: change.venueId }, data: { status: 'CLOSED' } })
        break
    }

    await prisma.activityLog.create({
      data: {
        action: ACTIVITY_ACTION[change.kind],
        entity: change.kind === 'CLOSE_VENUE' ? 'Venue' : change.kind === 'SET_EMPLOYEE_CODE' ? 'Staff' : 'StaffVenue',
        entityId:
          change.kind === 'CLOSE_VENUE' ? change.venueId : change.kind === 'SET_EMPLOYEE_CODE' ? change.staffId : (staffVenueId as string),
        staffId: actorStaffId,
        // Auditoría duradera: actorStaffId + actorType sobreviven aunque algún día se borre la
        // persona (staffId es la relación legacy SET NULL; actorStaffId es la que persiste).
        actorType: 'HUMAN',
        actorStaffId,
        // ActivityLog.venueId y organizationId son ambos String? (verificado en schema.prisma).
        // SET_EMPLOYEE_CODE no tiene venue: se estampa la org para que el evento no quede huérfano.
        venueId: 'venueId' in change ? change.venueId : null,
        organizationId,
        data: { origen: 'conciliar-estructura-bait', ...change },
      },
    })
  }
}

async function main() {
  validarBanderas(process.argv.slice(2))

  if (!FILE) throw new Error('Falta --file=<ruta al .xlsx>')
  if (!ORG_ID) throw new Error('Falta --org-id=<id de la organización>')

  console.log(`\n=== Conciliador de estructura BAIT (${APPLY ? 'APPLY' : 'DRY-RUN'}) ===`)
  console.log(`Archivo: ${FILE}`)
  console.log(
    `Banderas: baja-ausentes=${OPTIONS.bajaAusentes} · vacantes=${OPTIONS.vacantes} · supervisor-exclusivo=${OPTIONS.supervisorExclusivo} · proteger-staff=${PROTEGER_STAFF_IDS.length ? PROTEGER_STAFF_IDS.join(',') : '(ninguno)'}\n`,
  )

  const org = await prisma.organization.findUnique({ where: { id: ORG_ID }, select: { id: true, name: true } })
  if (!org) throw new Error(`No encontré la organización ${ORG_ID}`)
  console.log(`Organización: ${org.name} (${org.id})\n`)

  const rows = parseStructure(XLSX.readFile(FILE))
  printSupervisorDistribution(rows)

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

  // Personas que un ASSIGN_MANAGER/ASSIGN_PROMOTER va a dar de alta SIN PIN — no van a poder entrar
  // a la terminal de esa tienda hasta que alguien les asigne uno a mano. Se anuncia ANTES de
  // escribir, no después: además de la anotación en cada línea de arriba (`describePinPlan`), este
  // bloque lo deja imposible de pasar por alto en un diff largo.
  const pinWarnings = plan.changes.filter(
    (c): c is Extract<Change, { kind: 'ASSIGN_MANAGER' | 'ASSIGN_PROMOTER' }> =>
      (c.kind === 'ASSIGN_MANAGER' || c.kind === 'ASSIGN_PROMOTER') && c.pinPlan?.status === 'SIN_PIN',
  )
  if (pinWarnings.length) {
    console.log(`🔴 Quedarán SIN PIN al crearse (${pinWarnings.length}) — no van a poder entrar a la terminal 🔴`)
    for (const w of pinWarnings) {
      const razon = (w.pinPlan as Extract<PinPlan, { status: 'SIN_PIN' }>).reason
      console.log(`  ⨯ ${w.staffName} (${w.staffId}) — ${w.venueName}: ${PIN_SIN_RAZON[razon]}. Asígnale un PIN a mano.`)
    }
    console.log()
  }

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

  if (plan.supervisoresEnConflicto.length) {
    console.log(
      `— Supervisor en conflicto (${plan.supervisoresEnConflicto.length}) — el archivo asigna DOS supervisores distintos al mismo venue: su supervisor NO se tocó (los promotores sí se asignaron) —`,
    )
    for (const item of plan.supervisoresEnConflicto) {
      console.log(`  ? ${item.venueName}: ${item.supervisores.join(' vs. ')}`)
    }
    console.log()
  }

  if (plan.sinTiendaTrasAplicar.length) {
    console.log('🔴🔴🔴 PERSONAS QUE QUEDARÍAN SIN NINGUNA TIENDA ACTIVA — SIN TIENDA NO SE PUEDE COBRAR 🔴🔴🔴')
    console.log(`(${plan.sinTiendaTrasAplicar.length} persona(s). En modo --apply esto ABORTA salvo que pases --permitir-sin-tienda)`)
    for (const item of plan.sinTiendaTrasAplicar) {
      console.log(`  ⨯ ${item.staffName} (${item.staffId}) — deja: ${item.venuesQueDeja.join(', ') || '(sin detalle)'}`)
    }
    console.log()
  }

  console.log('=== Resumen ===')
  console.log(
    `Cambios propuestos: ${plan.changes.length} · Sin resolver: ${plan.unresolved.length} · Tiendas faltantes: ${plan.missingVenues.length} · Huérfanas: ${plan.orphanVenues.length} · Supervisor en conflicto: ${plan.supervisoresEnConflicto.length} · Sin tienda tras aplicar: ${plan.sinTiendaTrasAplicar.length} · Sin PIN al crear: ${pinWarnings.length}`,
  )

  await warnAboutCustody(plan.changes)

  if (!APPLY) {
    console.log('\nDry-run: no se modificó nada. Corre con --apply para escribir.')
    return
  }

  const actorId = arg('actor-staff-id')
  if (!actorId) throw new Error('Falta --actor-staff-id=<id> — ActivityLog necesita saber quién ejecutó el cambio')

  // Antes de escribir NADA: el identificador debe apuntar a una persona real de ESTA
  // organización. Sin esto, un --actor-staff-id mal tecleado revienta hasta el primer
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

  if (plan.unresolved.length) {
    throw new Error(`Hay ${plan.unresolved.length} renglones sin resolver. Resuélvelos antes de aplicar (o quítalos del archivo).`)
  }

  // 🔴 Aborta si el plan deja a alguien sin NINGUNA tienda activa: sin tienda no puede cobrar. Solo
  // se salta con --permitir-sin-tienda, pensada para cuando la persona de verdad se va de la empresa.
  if (plan.sinTiendaTrasAplicar.length && !PERMITIR_SIN_TIENDA) {
    const nombres = plan.sinTiendaTrasAplicar.map(p => `${p.staffName} (${p.staffId})`).join(', ')
    throw new Error(
      `${plan.sinTiendaTrasAplicar.length} persona(s) quedarían SIN NINGUNA TIENDA ACTIVA tras aplicar: ${nombres}. ` +
        `Sin tienda no pueden cobrar. Si de verdad se van de la empresa, vuelve a correr con --permitir-sin-tienda.`,
    )
  }

  // Ata la escritura al diff que se revisó: --apply vuelve a leer y a planear, así que sin este
  // seguro nada garantiza que lo aprobado sea lo que se aplica si otra sesión tocó la base entre
  // medias.
  const expectChangesArg = arg('expect-changes')
  if (expectChangesArg !== undefined) {
    const expected = Number(expectChangesArg)
    if (!Number.isInteger(expected) || expected < 0) {
      throw new Error(`--expect-changes=${expectChangesArg} no es un número entero válido.`)
    }
    if (expected !== plan.changes.length) {
      throw new Error(
        `--expect-changes=${expected} no coincide con los ${plan.changes.length} cambios planeados en esta corrida. ` +
          `La base pudo cambiar entre que revisaste el diff y corriste --apply. Vuelve a revisarlo antes de aplicar.`,
      )
    }
  } else {
    console.log('⚠️  Aplicando sin --expect-changes: nada garantiza que el diff que revisaste sea el que se está aplicando.\n')
  }

  await applyChanges(plan.changes, actorId, org.id)
  console.log(`\n✅ Aplicados ${plan.changes.length} cambios.`)
}

main()
  .catch(error => {
    console.error(error)
    // process.exitCode (no process.exit): process.exit() corta el proceso de inmediato y el
    // .finally() de abajo —que desconecta Prisma— nunca llega a correr. Con exitCode, Node sale
    // solo con este código DESPUÉS de que el event loop drena (incluido el .finally()).
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())

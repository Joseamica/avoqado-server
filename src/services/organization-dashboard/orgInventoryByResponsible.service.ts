/**
 * Inventario serializado agrupado por responsable: Ciudad › Supervisor › Promotor.
 *
 * Alimenta el dashboard de administración de inventario (pestaña Resumen de
 * Control de Stock). Su propósito operativo es que un supervisor pueda pararse
 * en la tienda y cuadrar contra la mano del promotor lo que dice la columna
 * "En mano HOY" — por eso las 7 columnas se cuentan sobre EL MISMO conjunto de
 * ítems y cualquier filtro aplica parejo a todas: si una columna se filtrara y
 * otra no, la resta dejaría de cuadrar y el conteo físico sería inútil.
 *
 * Este archivo es genérico a propósito: no conoce ningún cliente, slug ni
 * nombre de venue (ver `.claude/rules/critical-warnings.md` → "Industry Config:
 * Never Hardcode Client Names"). La sucursal receptora por la que se filtra
 * llega como parámetro.
 */
import prisma from '../../utils/prismaClient'
import type { SaleVerificationStatus, SerializedItemCustodyState } from '@prisma/client'

/** Un ítem serializado con su estado de venta YA resuelto por quien lo carga. */
export interface InventoryItemInput {
  assignedPromoterId: string | null
  assignedSupervisorId: string | null
  custodyState: SerializedItemCustodyState
  promoterAcceptedAt: Date | null
  registeredFromVenueId: string | null
  /** null = todavía no se vendió, o se vendió sin verificación asociada. */
  saleVerificationStatus: SaleVerificationStatus | null
}

export interface StaffVenueInput {
  venueId: string
  city: string | null
  startDate: Date
}

export interface StaffInput {
  id: string
  name: string
  active: boolean
  venues: StaffVenueInput[]
}

export interface BuildInventoryByResponsibleInput {
  items: InventoryItemInput[]
  /** Catálogo de promotores Y supervisores; se usa para ciudad y nombres. */
  staff: StaffInput[]
  /** Filtro "Sucursal Receptora". `undefined`/`null` = todas. */
  receivingVenueId?: string | null
}

export interface ResponsibleCounts {
  assigned: number
  receptionApproved: number
  saleApproved: number
  saleInAdminReview: number
  saleInPromoterReview: number
  saleRejected: number
  inHandToday: number
}

export interface PromoterNode extends ResponsibleCounts {
  promoterId: string
  promoterName: string
}

export interface SupervisorNode extends ResponsibleCounts {
  supervisorId: string | null
  supervisorName: string
  promoters: PromoterNode[]
}

export interface CityNode extends ResponsibleCounts {
  city: string
  supervisors: SupervisorNode[]
}

export interface UnassignedNode extends ResponsibleCounts {
  label: string
  promoters: PromoterNode[]
}

export interface InventoryByResponsible {
  /** La fila "Total País": ciudades + el renglón de no asignables. */
  total: ResponsibleCounts
  cities: CityNode[]
  /**
   * Promotores dados de baja o sin sucursal. Se muestran SIEMPRE: esconderlos
   * contradice el objetivo de control al 100% (decisión founder, 24-ago-2026).
   */
  unassigned: UnassignedNode
}

const UNKNOWN_PROMOTER_LABEL = 'Promotor no identificado'
const NO_SUPERVISOR_LABEL = 'Sin supervisor asignado'
const UNASSIGNED_LABEL = 'Sin sucursal · bajas'

function emptyCounts(): ResponsibleCounts {
  return {
    assigned: 0,
    receptionApproved: 0,
    saleApproved: 0,
    saleInAdminReview: 0,
    saleInPromoterReview: 0,
    saleRejected: 0,
    inHandToday: 0,
  }
}

function addCounts(target: ResponsibleCounts, source: ResponsibleCounts): void {
  target.assigned += source.assigned
  target.receptionApproved += source.receptionApproved
  target.saleApproved += source.saleApproved
  target.saleInAdminReview += source.saleInAdminReview
  target.saleInPromoterReview += source.saleInPromoterReview
  target.saleRejected += source.saleRejected
  target.inHandToday += source.inHandToday
}

/**
 * Acumula UN ítem sobre las 7 columnas.
 *
 * 🔴 `inHandToday` cuenta SOLO `PROMOTER_HELD`. Un SIM vendido cuya venta se
 * rechazó después NO regresa a "en mano": el SIM ya se le entregó al cliente y
 * la revisión de la venta nunca toca el registro del ítem (decisión de Isaac
 * Mayoral, 25-ago-2026, verificada contra `sale-verification.dashboard.service`).
 */
function accumulateItem(counts: ResponsibleCounts, item: InventoryItemInput): void {
  counts.assigned += 1
  if (item.promoterAcceptedAt !== null) counts.receptionApproved += 1
  if (item.custodyState === 'PROMOTER_HELD') counts.inHandToday += 1

  switch (item.saleVerificationStatus) {
    case 'COMPLETED':
      counts.saleApproved += 1
      break
    case 'PENDING':
    case 'PROCESSING':
      counts.saleInAdminReview += 1
      break
    case 'FAILED': // "Revisar" — el promotor puede corregir desde la TPV
      counts.saleInPromoterReview += 1
      break
    case 'REJECTED':
      counts.saleRejected += 1
      break
    default:
      break
  }
}

/**
 * La ciudad del promotor sale de su asignación de sucursal MÁS RECIENTE.
 *
 * Un promotor que cambió de tienda suele conservar activa la asignación vieja
 * porque nadie la cerró (caso Tirza Juárez: Querétaro desde julio y San Luis
 * desde marzo, ambas activas). Sin este desempate el promotor aparecería en dos
 * ciudades y sus SIMs se contarían dos veces.
 */
function resolveCity(staff: StaffInput | undefined): string | null {
  if (!staff || !staff.active) return null

  const withCity = staff.venues.filter(v => v.city !== null && v.city.trim() !== '')
  if (withCity.length === 0) return null

  const mostRecent = withCity.reduce((best, v) => (v.startDate.getTime() > best.startDate.getTime() ? v : best))
  return mostRecent.city!.trim()
}

/**
 * El supervisor se deduce del promotor, no del campo de cada SIM.
 *
 * Casi la mitad del inventario en mano no trae `assignedSupervisorId` (756 de
 * 1,628 medidos el 25-ago-2026), así que agrupar por el campo del ítem partiría
 * a un mismo promotor en varios renglones y dejaría el nivel Supervisor hueco.
 * Isaac lo pidió explícitamente así: los SIMs de un promotor caen bajo su
 * supervisor "para que cuadre bottom-up, de promotor hasta nivel país".
 *
 * Gana el supervisor mayoritario entre sus ítems; el id desempata para que el
 * resultado sea estable entre corridas.
 */
function resolveSupervisorId(items: InventoryItemInput[]): string | null {
  const tally = new Map<string, number>()
  for (const item of items) {
    if (!item.assignedSupervisorId) continue
    tally.set(item.assignedSupervisorId, (tally.get(item.assignedSupervisorId) ?? 0) + 1)
  }
  if (tally.size === 0) return null

  let winner: string | null = null
  let best = -1
  for (const [id, count] of [...tally.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (count > best) {
      best = count
      winner = id
    }
  }
  return winner
}

export function buildInventoryByResponsible(input: BuildInventoryByResponsibleInput): InventoryByResponsible {
  const { items, staff, receivingVenueId } = input

  const staffById = new Map(staff.map(s => [s.id, s]))

  // El filtro de sucursal receptora se aplica ANTES de contar, una sola vez,
  // para que las 7 columnas queden sobre el mismo conjunto y la resta cuadre.
  const scoped = items.filter(item => {
    if (item.assignedPromoterId === null) return false // aún con admin o supervisor
    if (receivingVenueId === undefined || receivingVenueId === null) return true
    return item.registeredFromVenueId === receivingVenueId
  })

  const byPromoter = new Map<string, InventoryItemInput[]>()
  for (const item of scoped) {
    const id = item.assignedPromoterId!
    const bucket = byPromoter.get(id)
    if (bucket) bucket.push(item)
    else byPromoter.set(id, [item])
  }

  const cityMap = new Map<string, Map<string, { supervisorId: string | null; supervisorName: string; promoters: PromoterNode[] }>>()
  const unassignedPromoters: PromoterNode[] = []

  for (const [promoterId, promoterItems] of [...byPromoter.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const staffRecord = staffById.get(promoterId)

    const counts = emptyCounts()
    for (const item of promoterItems) accumulateItem(counts, item)

    const node: PromoterNode = {
      promoterId,
      promoterName: staffRecord?.name ?? UNKNOWN_PROMOTER_LABEL,
      ...counts,
    }

    const city = resolveCity(staffRecord)
    if (city === null) {
      unassignedPromoters.push(node)
      continue
    }

    const supervisorId = resolveSupervisorId(promoterItems)
    const supervisorName = supervisorId ? (staffById.get(supervisorId)?.name ?? NO_SUPERVISOR_LABEL) : NO_SUPERVISOR_LABEL

    const supervisors = cityMap.get(city) ?? new Map()
    cityMap.set(city, supervisors)

    const key = supervisorId ?? '__none__'
    const group = supervisors.get(key) ?? { supervisorId, supervisorName, promoters: [] }
    group.promoters.push(node)
    supervisors.set(key, group)
  }

  const cities: CityNode[] = [...cityMap.entries()]
    .sort((a, b) => a[0].localeCompare(b[0], 'es'))
    .map(([city, supervisorMap]) => {
      const supervisors: SupervisorNode[] = [...supervisorMap.values()]
        .sort((a, b) => a.supervisorName.localeCompare(b.supervisorName, 'es'))
        .map(group => {
          const supCounts = emptyCounts()
          for (const promoter of group.promoters) addCounts(supCounts, promoter)
          return { supervisorId: group.supervisorId, supervisorName: group.supervisorName, promoters: group.promoters, ...supCounts }
        })

      const cityCounts = emptyCounts()
      for (const supervisor of supervisors) addCounts(cityCounts, supervisor)
      return { city, supervisors, ...cityCounts }
    })

  const unassignedCounts = emptyCounts()
  for (const promoter of unassignedPromoters) addCounts(unassignedCounts, promoter)

  const total = emptyCounts()
  for (const city of cities) addCounts(total, city)
  addCounts(total, unassignedCounts)

  return {
    total,
    cities,
    unassigned: { label: UNASSIGNED_LABEL, promoters: unassignedPromoters, ...unassignedCounts },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Carga de datos
// ─────────────────────────────────────────────────────────────────────────────

export interface FetchInventoryByResponsibleOptions {
  /** Rango sobre `createdAt` del ítem. Ya resuelto a UTC por el borde HTTP
   *  (`parseDbDateRange` con el timezone del venue) — este servicio nunca
   *  interpreta un `YYYY-MM-DD` pelón. Ver `.claude/rules/critical-warnings.md`. */
  dateFrom?: Date
  dateTo?: Date
  categoryId?: string | null
  receivingVenueId?: string | null
}

/**
 * Toma la verificación de venta que corresponde al ítem.
 *
 * Una orden puede traer varios pagos y sólo algunos con verificación; nos
 * interesa la primera que exista, porque en este flujo la venta de un SIM
 * produce una sola verificación. Si no hay ninguna, el ítem simplemente no
 * suma a las columnas de venta.
 */
function pickVerificationStatus(orderItem: any): SaleVerificationStatus | null {
  const payments = orderItem?.order?.payments ?? []
  for (const payment of payments) {
    if (payment?.saleVerification?.status) return payment.saleVerification.status
  }
  return null
}

export class OrgInventoryByResponsibleService {
  /**
   * Devuelve la tabla Ciudad › Supervisor › Promotor para una organización.
   *
   * El filtro de sucursal receptora se aplica dentro de la función pura y no en
   * el `where` de Prisma, a propósito: así el conjunto sin filtrar y el filtrado
   * salen de la MISMA consulta y no pueden discrepar entre sí.
   */
  async getInventoryByResponsible(organizationId: string, options: FetchInventoryByResponsibleOptions = {}) {
    const { dateFrom, dateTo, categoryId, receivingVenueId } = options

    const rows = await prisma.serializedItem.findMany({
      where: {
        organizationId,
        assignedPromoterId: { not: null },
        ...(categoryId ? { categoryId } : {}),
        ...(dateFrom || dateTo ? { createdAt: { ...(dateFrom && { gte: dateFrom }), ...(dateTo && { lte: dateTo }) } } : {}),
      },
      select: {
        assignedPromoterId: true,
        assignedSupervisorId: true,
        custodyState: true,
        promoterAcceptedAt: true,
        registeredFromVenueId: true,
        orderItem: {
          select: { order: { select: { payments: { select: { saleVerification: { select: { status: true } } } } } } },
        },
      },
    })

    const items: InventoryItemInput[] = rows.map(row => ({
      assignedPromoterId: row.assignedPromoterId,
      assignedSupervisorId: row.assignedSupervisorId,
      custodyState: row.custodyState,
      promoterAcceptedAt: row.promoterAcceptedAt,
      registeredFromVenueId: row.registeredFromVenueId,
      saleVerificationStatus: pickVerificationStatus(row.orderItem),
    }))

    // Los promotores dados de baja ya no tienen StaffVenue activo, así que el
    // catálogo se arma desde los ids que aparecen en los ítems y NO desde los
    // empleados vigentes — si no, esos SIMs se quedarían sin nombre y el
    // renglón de bajas saldría anónimo.
    const staffIds = new Set<string>()
    for (const item of items) {
      if (item.assignedPromoterId) staffIds.add(item.assignedPromoterId)
      if (item.assignedSupervisorId) staffIds.add(item.assignedSupervisorId)
    }

    const staffRows =
      staffIds.size > 0
        ? await prisma.staff.findMany({
            where: { id: { in: [...staffIds] } },
            select: {
              id: true,
              firstName: true,
              lastName: true,
              active: true,
              venues: {
                where: { active: true },
                select: { venueId: true, startDate: true, venue: { select: { city: true, organizationId: true } } },
              },
            },
          })
        : []

    const staff: StaffInput[] = staffRows.map(row => ({
      id: row.id,
      name: `${row.firstName} ${row.lastName}`.trim(),
      active: row.active,
      // Sólo las sucursales de ESTA organización: un promotor que también
      // trabaje en otro tenant no debe arrastrar aquí la ciudad de allá.
      venues: row.venues
        .filter(v => v.venue?.organizationId === organizationId)
        .map(v => ({ venueId: v.venueId, city: v.venue?.city ?? null, startDate: v.startDate })),
    }))

    return buildInventoryByResponsible({ items, staff, receivingVenueId })
  }
}

export const orgInventoryByResponsibleService = new OrgInventoryByResponsibleService()

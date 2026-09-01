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
  /**
   * Cuando viene, la persona aparece en la tabla AUNQUE no tenga ni un SIM.
   *
   * Isaac Mayoral lo pidió el 27-ago-2026 ("generar la estructura correcta"):
   * un promotor en cero también es información — dice que no le han asignado
   * nada. Sin esto, 11 de los 32 promotores activos eran invisibles.
   * Es opcional para no cambiar el comportamiento de quien no lo pasa.
   */
  role?: 'PROMOTER' | 'SUPERVISOR'
}

export interface BuildInventoryByResponsibleInput {
  items: InventoryItemInput[]
  /** Catálogo de promotores Y supervisores; se usa para ciudad y nombres. */
  staff: StaffInput[]
  /** Filtro "Sucursal Receptora". `undefined`/`null` = todas. */
  receivingVenueId?: string | null
  /**
   * Supervisor de cada sucursal, para colgar de alguien a los promotores que no
   * tienen SIMs: sin inventario no hay de dónde deducirlo (`resolveSupervisorId`
   * mira los ítems). Sin este mapa caen en "sin supervisor", que sigue siendo
   * visible.
   */
  venueSupervisors?: Record<string, string>
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

export interface FilterOption {
  id: string
  name: string
  itemCount: number
}

export interface InventoryFilters {
  receivingVenues: FilterOption[]
  categories: FilterOption[]
  /**
   * Almacén de entrada de la organización, con el que la pantalla abre
   * preseleccionada. Sale de la configuración del módulo — NUNCA del nombre ni
   * del slug del venue (`.claude/rules/critical-warnings.md`). Si nadie lo ha
   * configurado es `null` y la tabla abre mostrando TODO, que es el default
   * seguro: mostrar de más nunca esconde inventario.
   */
  defaultReceivingVenueId: string | null
}

/** Lo que devuelve la agregación pura: sin filtros, que no puede conocer. */
export interface InventoryByResponsibleTable {
  /** La fila "Total País": ciudades + el renglón de no asignables. */
  total: ResponsibleCounts
  cities: CityNode[]
  /**
   * Promotores dados de baja o sin sucursal. Se muestran SIEMPRE: esconderlos
   * contradice el objetivo de control al 100% (decisión founder, 24-ago-2026).
   */
  unassigned: UnassignedNode
}

/** Lo que sirve el endpoint: la tabla más las opciones de los selectores. */
export interface InventoryByResponsible extends InventoryByResponsibleTable {
  /** Opciones para los selectores, SIEMPRE sobre el universo sin filtrar. */
  filters: InventoryFilters
}

interface SupervisorGroup {
  supervisorId: string | null
  supervisorName: string
  promoters: PromoterNode[]
}

type SupervisorMap = Map<string, SupervisorGroup>

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
 * 🔴 Manda la ESTRUCTURA DEL EQUIPO —el supervisor de la sucursal donde el
 * promotor trabaja hoy— y no `assignedSupervisorId`, que es un dato histórico:
 * queda grabado en cada SIM el día que se entrega y no se mueve nunca. Cuando
 * alguien cambia de equipo, su inventario viejo se queda con el jefe anterior y
 * la tabla lo colgaba de ahí.
 *
 * Lo reportó Isaac el 31-ago-2026 con captura: "Juan Nájera aparece que tiene 2
 * vendedores" cuando su archivo le da 11. Yolanda salía bajo Hugo porque sus 61
 * SIMs sin vender siguen a nombre de Hugo, aunque ella ya trabaje con Juan; y
 * el equipo de Juan quedaba partido entre tres supervisores.
 *
 * El respaldo por SIMs se conserva SÓLO para la sucursal que todavía no tiene
 * supervisor asignado: ahí el dato viejo es la única pista, y es mejor que dejar
 * al promotor colgando de nadie. Casi la mitad del inventario en mano tampoco
 * trae `assignedSupervisorId` (756 de 1,628 medidos el 25-ago-2026), así que sin
 * ese respaldo el nivel Supervisor quedaría hueco. Entre varios gana el
 * mayoritario, con el id de desempate para que el resultado sea estable.
 */
function resolveSupervisorId(
  staffRecord: StaffInput | undefined,
  items: InventoryItemInput[],
  venueSupervisors: Record<string, string> | undefined,
): string | null {
  const porEstructura = venueSupervisors?.[mostRecentVenueId(staffRecord) ?? '']
  if (porEstructura) return porEstructura

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

/** La sucursal de la asignación más reciente — mismo desempate que `resolveCity`. */
function mostRecentVenueId(staff: StaffInput | undefined): string | null {
  if (!staff || staff.venues.length === 0) return null
  return staff.venues.reduce((best, v) => (v.startDate.getTime() > best.startDate.getTime() ? v : best)).venueId
}

export function buildInventoryByResponsible(input: BuildInventoryByResponsibleInput): InventoryByResponsibleTable {
  const { items, staff, receivingVenueId, venueSupervisors } = input

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

  // Alias con nombre: sin él, un `?? (new Map() as SupervisorMap)` sin tipar degrada la inferencia
  // y los callbacks de abajo quedan con parámetros `any` implícitos (TS7006).
  const cityMap = new Map<string, SupervisorMap>()
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

    const supervisorId = resolveSupervisorId(staffRecord, promoterItems, venueSupervisors)
    const supervisorName = supervisorId ? (staffById.get(supervisorId)?.name ?? NO_SUPERVISOR_LABEL) : NO_SUPERVISOR_LABEL

    const supervisors = cityMap.get(city) ?? (new Map() as SupervisorMap)
    cityMap.set(city, supervisors)

    const key = supervisorId ?? '__none__'
    const group = supervisors.get(key) ?? { supervisorId, supervisorName, promoters: [] }
    group.promoters.push(node)
    supervisors.set(key, group)
  }

  // ── Estructura completa ────────────────────────────────────────────────────
  // Hasta aquí sólo existen quienes tienen SIMs. Se agregan las personas del
  // catálogo que traen `role`, con la fila en ceros, para que la tabla refleje
  // la organización y no sólo el inventario.
  for (const person of staff) {
    if (!person.role || !person.active) continue

    const city = resolveCity(person)
    if (city === null) continue // sin sucursal no hay dónde ponerlo; no se inventa

    const supervisors = cityMap.get(city) ?? (new Map() as SupervisorMap)
    cityMap.set(city, supervisors)

    if (person.role === 'SUPERVISOR') {
      if (!supervisors.has(person.id)) {
        supervisors.set(person.id, { supervisorId: person.id, supervisorName: person.name, promoters: [] })
      }
      continue
    }

    // Promotor: sólo si no salió ya por sus ítems.
    const yaEsta = [...supervisors.values()].some(g => g.promoters.some(pr => pr.promoterId === person.id))
    if (yaEsta || byPromoter.has(person.id)) continue

    const supervisorId = venueSupervisors?.[mostRecentVenueId(person) ?? ''] ?? null
    const supervisorName = supervisorId ? (staffById.get(supervisorId)?.name ?? NO_SUPERVISOR_LABEL) : NO_SUPERVISOR_LABEL
    const key = supervisorId ?? '__none__'
    const group = supervisors.get(key) ?? { supervisorId, supervisorName, promoters: [] }
    group.promoters.push({ promoterId: person.id, promoterName: person.name, ...emptyCounts() })
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

/** Cuenta ítems por opción y ordena por nombre, para que el selector sea estable. */
function tally(rows: any[], pick: (row: any) => { id: string; name: string } | null | undefined): FilterOption[] {
  const map = new Map<string, FilterOption>()
  for (const row of rows) {
    const opt = pick(row)
    if (!opt) continue
    const existing = map.get(opt.id)
    if (existing) existing.itemCount += 1
    else map.set(opt.id, { id: opt.id, name: opt.name, itemCount: 1 })
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, 'es'))
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
        ...(dateFrom || dateTo ? { createdAt: { ...(dateFrom && { gte: dateFrom }), ...(dateTo && { lte: dateTo }) } } : {}),
      },
      select: {
        assignedPromoterId: true,
        assignedSupervisorId: true,
        custodyState: true,
        promoterAcceptedAt: true,
        registeredFromVenueId: true,
        registeredFromVenue: { select: { id: true, name: true } },
        categoryId: true,
        category: { select: { id: true, name: true } },
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
            // Además de quienes aparecen en los ítems, se trae la PLANTILLA ACTIVA:
            // promotores y supervisores sin un solo SIM también deben verse
            // (pedido de Isaac, 27-ago-2026). Sin esto, 11 de 32 promotores
            // activos quedaban invisibles en la tabla.
            where: {
              OR: [
                { id: { in: [...staffIds] } },
                { active: true, venues: { some: { active: true, role: { in: ['WAITER', 'MANAGER'] }, venue: { organizationId } } } },
              ],
            },
            select: {
              id: true,
              firstName: true,
              lastName: true,
              active: true,
              venues: {
                where: { active: true },
                select: { venueId: true, startDate: true, role: true, venue: { select: { city: true, organizationId: true } } },
              },
            },
          })
        : []

    const staff: StaffInput[] = staffRows.map(row => {
      // Sólo las sucursales de ESTA organización: un promotor que también
      // trabaje en otro tenant no debe arrastrar aquí la ciudad de allá.
      const venues = row.venues.filter(v => v.venue?.organizationId === organizationId)
      const roles = new Set(venues.map(v => v.role))
      return {
        id: row.id,
        name: `${row.firstName} ${row.lastName}`.trim(),
        active: row.active,
        venues: venues.map(v => ({ venueId: v.venueId, city: v.venue?.city ?? null, startDate: v.startDate })),
        // MANAGER manda sobre WAITER: quien supervisa en alguna sucursal se
        // muestra como supervisor, no colgado de sí mismo como promotor.
        role: roles.has('MANAGER') ? ('SUPERVISOR' as const) : roles.has('WAITER') ? ('PROMOTER' as const) : undefined,
      }
    })

    // Supervisor de cada sucursal: es la única pista para colgar de alguien a un
    // promotor que no tiene SIMs (sin inventario no hay de dónde deducirlo).
    const venueSupervisors: Record<string, string> = {}
    for (const row of staffRows) {
      for (const v of row.venues) {
        if (v.role === 'MANAGER' && v.venue?.organizationId === organizationId && !venueSupervisors[v.venueId]) {
          venueSupervisors[v.venueId] = row.id
        }
      }
    }

    // Las opciones de los selectores se calculan sobre el universo SIN filtrar:
    // si salieran del conjunto ya filtrado, elegir una sucursal dejaría el
    // selector con una sola opción y el usuario no podría volver atrás.
    const receivingVenues = tally(rows, r => r.registeredFromVenue)
    const categories = tally(rows, r => r.category)

    const moduleRow = await prisma.organizationModule.findFirst({
      where: { organizationId, enabled: true, module: { code: 'SERIALIZED_INVENTORY' } },
      select: { config: true },
    })
    const rawDefault = (moduleRow?.config as Record<string, unknown> | null)?.defaultReceivingVenueId
    const configuredDefault = typeof rawDefault === 'string' && rawDefault.trim() !== '' ? rawDefault : null
    // Un default que apunte a una sucursal inexistente dejaría la tabla vacía
    // sin explicación: se ignora y se abre mostrando todo.
    const defaultReceivingVenueId = receivingVenues.some(v => v.id === configuredDefault) ? configuredDefault : null

    const scopedByCategory = categoryId ? items.filter((_, i) => rows[i].categoryId === categoryId) : items

    const result = buildInventoryByResponsible({ items: scopedByCategory, staff, receivingVenueId, venueSupervisors })
    return { ...result, filters: { receivingVenues, categories, defaultReceivingVenueId } }
  }
}

export const orgInventoryByResponsibleService = new OrgInventoryByResponsibleService()

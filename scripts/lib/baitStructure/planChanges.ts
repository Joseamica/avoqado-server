import { extractStoreId, matchStaff, MatchResult, norm, ProdStaff } from './identity'
import { StructureRow } from './types'

export interface ProdSnapshot {
  venues: Array<{ id: string; name: string; status: string }>
  staff: ProdStaff[]
  /**
   * `pin`/`startDate`/`endDate` son opcionales (aunque `readSnapshot` siempre los manda) para que
   * los snapshots de prueba que no les dan valor sigan compilando — nada de lo que no manda `pin`
   * cambia de comportamiento, porque la herencia de PIN sólo mira assignments con `pin` presente.
   */
  assignments: Array<{
    staffId: string
    venueId: string
    role: string
    active: boolean
    pin?: string | null
    startDate?: Date
    endDate?: Date | null
  }>
}

export interface PlanOptions {
  /** Cierra los venues con ID de tienda que ya no vienen en el Excel. Default false. */
  bajaAusentes: boolean
  /** 'conservar' (default) deja al promotor actual; 'libre' lo desasigna. */
  vacantes: 'conservar' | 'libre'
  /** Filas del Excel sin ID de tienda: cómo se llaman en el archivo → nombre del venue en la base. */
  venuesSinId?: Record<string, string>
  /**
   * Para cada supervisor que SÍ aparece en el archivo, desasigna sus filas de supervisor activas
   * en venues que el archivo NO menciona. Apagada por defecto — no cambia nada si no se pasa.
   */
  supervisorExclusivo?: boolean
  /**
   * IDs de Staff que NUNCA deben aparecer en un cambio de baja (UNASSIGN_MANAGER ni
   * UNASSIGN_PROMOTER), sin importar qué diga el archivo sobre esa tienda o qué otra bandera
   * esté activa (incluida --supervisor-exclusivo y --vacantes=libre). Pensada para cuentas que
   * no son una persona real — p.ej. una cuenta genérica que el cliente usa para cargar ventas a
   * mano — que el cliente pidió dejar tal cual. Sí pueden recibir un ASSIGN si el archivo las
   * designa: la protección es solo sobre las bajas.
   */
  protegerStaffIds?: string[]
}

/**
 * Plan de herencia de PIN para un ASSIGN_MANAGER/ASSIGN_PROMOTER que va a CREAR una fila
 * StaffVenue nueva (nunca para la rama `update` — ahí el PIN no se toca). `INHERIT` reusa el PIN
 * que la persona ya tiene en otra tienda; `SIN_PIN` explica por qué no se pudo — nunca se inventa
 * uno.
 */
export type PinPlan =
  | { status: 'INHERIT'; pin: string; fromVenueName: string }
  | { status: 'SIN_PIN'; reason: 'SIN_PRECEDENTE' | 'PIN_OCUPADO_EN_DESTINO' | 'AMBIGUO' }

export type Change =
  | { kind: 'SET_EMPLOYEE_CODE'; staffId: string; staffName: string; from: string | null; to: string }
  | { kind: 'ASSIGN_MANAGER'; staffId: string; staffName: string; venueId: string; venueName: string; pinPlan?: PinPlan }
  | { kind: 'UNASSIGN_MANAGER'; staffId: string; staffName: string; venueId: string; venueName: string }
  | { kind: 'ASSIGN_PROMOTER'; staffId: string; staffName: string; venueId: string; venueName: string; pinPlan?: PinPlan }
  | { kind: 'UNASSIGN_PROMOTER'; staffId: string; staffName: string; venueId: string; venueName: string }
  | { kind: 'CLOSE_VENUE'; venueId: string; venueName: string; from: string }

export interface PlanResult {
  changes: Change[]
  unresolved: Array<{
    row: StructureRow
    reason: 'AMBIGUOUS' | 'NOT_FOUND' | 'DUPLICATE_STORE' | 'SIN_SUPERVISOR'
    candidates?: string[]
  }>
  missingVenues: StructureRow[]
  orphanVenues: Array<{ id: string; name: string }>
  /** Un mismo venue recibido por dos filas del mapa (`venuesSinId`) con supervisores distintos: se
   * asignan los promotores igual, pero el supervisor de ese venue NO se toca. */
  supervisoresEnConflicto: Array<{ venueName: string; supervisores: string[] }>
  /** Personas que, tras aplicar el plan, se quedarían sin NINGUNA tienda activa. Sin tienda no se
   * puede cobrar. */
  sinTiendaTrasAplicar: Array<{ staffId: string; staffName: string; venuesQueDeja: string[] }>
}

/**
 * Roles que la plataforma lee como "promotor" de un venue. `setup-playtelecom-complete.ts` da de
 * alta promotores como CASHIER (además de WAITER), así que leer solo WAITER los vuelve invisibles
 * y el conciliador terminaría asignando a un segundo promotor sobre la misma tienda.
 */
const PROMOTER_ROLES = ['CASHIER', 'WAITER']

/**
 * 🔴 El lado de SUPERVISOR se queda deliberadamente en MANAGER, y NO se amplía a ADMIN aunque el
 * resto de la plataforma sí lea promotores como CASHIER+WAITER. Verificado contra producción
 * (2026-08-23): hay 41 filas StaffVenue con role=ADMIN activas, y son el ADMINISTRADOR DE LA
 * ORGANIZACIÓN (una persona en 40 tiendas, otra en 1) — no supervisores de piso. Ampliar aquí a
 * ADMIN desataría UNASSIGN_MANAGER contra el administrador de 40 tiendas en cuanto el Excel no lo
 * liste ahí como supervisor. No es un fix, es una regresión grave.
 */
const SUPERVISOR_ROLE = 'MANAGER'

type SnapshotAssignment = ProdSnapshot['assignments'][number]

/**
 * "Recencia" de una asignación para decidir, entre varios PINs distintos, cuál es el de la tienda
 * donde la persona estuvo activa más recientemente. Tupla [tier, timestamp]: una asignación
 * ACTIVA hoy siempre le gana a cualquier asignación ya terminada (tier 1 vs 0), sin importar
 * fechas — está pasando AHORA. Entre dos activas, gana el `startDate` más nuevo (la que tomó más
 * recientemente); entre dos inactivas, gana el `endDate` más nuevo (la que dejó más recientemente).
 * Sin fecha (snapshots de prueba que no la mandan) cae a epoch, para no reventar.
 */
function scoreRecency(a: SnapshotAssignment): [number, number] {
  const EPOCH = new Date(0)
  if (a.active) return [1, (a.startDate ?? EPOCH).getTime()]
  return [0, (a.endDate ?? a.startDate ?? EPOCH).getTime()]
}

type PinLookup = { status: 'FOUND'; pin: string; fromVenueName: string } | { status: 'NONE' } | { status: 'AMBIGUOUS' }

/**
 * Busca, entre TODAS las asignaciones (activas e inactivas) de `staffId` en tiendas distintas a
 * `excludeVenueId`, el PIN más reciente. Si todas las asignaciones con PIN comparten el mismo
 * valor, no hay ambigüedad posible aunque haya varias filas. Si hay valores distintos y los dos
 * más recientes empatan en recencia (misma tier y misma fecha), no hay forma clara de elegir:
 * AMBIGUOUS — el caller lo trata igual que "sin PIN", nunca adivina.
 */
function findMostRecentPin(staffId: string, excludeVenueId: string, snapshot: ProdSnapshot): PinLookup {
  const candidates = snapshot.assignments.filter(
    (a): a is SnapshotAssignment & { pin: string } => a.staffId === staffId && a.venueId !== excludeVenueId && a.pin != null,
  )
  if (candidates.length === 0) return { status: 'NONE' }

  const sorted = [...candidates].sort((a, b) => {
    const [aTier, aTime] = scoreRecency(a)
    const [bTier, bTime] = scoreRecency(b)
    return aTier !== bTier ? bTier - aTier : bTime - aTime
  })

  const [top, second] = sorted
  if (second) {
    const [topTier, topTime] = scoreRecency(top)
    const [secondTier, secondTime] = scoreRecency(second)
    if (topTier === secondTier && topTime === secondTime && top.pin !== second.pin) {
      return { status: 'AMBIGUOUS' }
    }
  }

  const venue = snapshot.venues.find(v => v.id === top.venueId)
  return { status: 'FOUND', pin: top.pin, fromVenueName: venue?.name ?? top.venueId }
}

/** `@@unique([venueId, pin])` en el schema: cualquier OTRA fila (activa o no) con ese mismo PIN en
 * ese mismo venue lo vuelve imposible de reusar — Postgres rechazaría el insert. */
function pinIsFreeAtVenue(pin: string, venueId: string, snapshot: ProdSnapshot): boolean {
  return !snapshot.assignments.some(a => a.venueId === venueId && a.pin === pin)
}

/**
 * Decide qué PIN heredaría (si acaso) una fila StaffVenue NUEVA para `staffId` en
 * `destinationVenueId`. Pura y exportada para poder probarla sin Prisma. `additionallyOccupiedPins`
 * deja que el caller (el planner) le informe de PINs que OTRA alta del mismo lote ya reclamó en ese
 * mismo venue, para no repartir el mismo PIN heredado a dos personas nuevas en una sola corrida.
 */
export function planPinForNewAssignment(
  staffId: string,
  destinationVenueId: string,
  snapshot: ProdSnapshot,
  additionallyOccupiedPins: ReadonlySet<string> = new Set(),
): PinPlan {
  const lookup = findMostRecentPin(staffId, destinationVenueId, snapshot)
  if (lookup.status === 'NONE') return { status: 'SIN_PIN', reason: 'SIN_PRECEDENTE' }
  if (lookup.status === 'AMBIGUOUS') return { status: 'SIN_PIN', reason: 'AMBIGUO' }

  const occupied = additionallyOccupiedPins.has(lookup.pin) || !pinIsFreeAtVenue(lookup.pin, destinationVenueId, snapshot)
  if (occupied) return { status: 'SIN_PIN', reason: 'PIN_OCUPADO_EN_DESTINO' }

  return { status: 'INHERIT', pin: lookup.pin, fromVenueName: lookup.fromVenueName }
}

export function planChanges(rows: StructureRow[], snapshot: ProdSnapshot, options: PlanOptions): PlanResult {
  const changes: Change[] = []
  const unresolved: PlanResult['unresolved'] = []
  const missingVenues: StructureRow[] = []

  const staffById = new Map(snapshot.staff.map(s => [s.id, s]))
  const nameOf = (id: string) => {
    const s = staffById.get(id)
    return s ? `${s.firstName} ${s.lastName}` : id
  }

  const venueByStoreId = new Map<string, { id: string; name: string; status: string }>()
  for (const venue of snapshot.venues) {
    const storeId = extractStoreId(venue.name)
    if (storeId) venueByStoreId.set(storeId, venue)
  }

  const activeOn = (venueId: string, roles: string | string[]) => {
    const roleSet = Array.isArray(roles) ? roles : [roles]
    return snapshot.assignments.filter(a => a.venueId === venueId && roleSet.includes(a.role) && a.active)
  }

  // Cada storeId se procesa UNA sola vez: la primera fila del Excel gana. El Excel lo manda el
  // cliente y cambia cada corrida — dos filas para la misma tienda es una anomalía que se reporta,
  // no se adivina (igual que missingVenues y unresolved por nombre).
  const seenStoreIds = new Set<string>()
  const duplicateExtraRows = new Set<StructureRow>()
  for (const row of rows) {
    if (!row.storeId) continue
    if (seenStoreIds.has(row.storeId)) {
      duplicateExtraRows.add(row)
    } else {
      seenStoreIds.add(row.storeId)
    }
  }

  // Resolver cada fila a una persona una sola vez.
  const resolved = new Map<StructureRow, string>()
  for (const row of rows) {
    if (duplicateExtraRows.has(row)) {
      unresolved.push({ row, reason: 'DUPLICATE_STORE' })
      continue
    }
    if (row.isVacante) continue
    const result: MatchResult = matchStaff(row, snapshot.staff)
    if (result.status === 'MATCHED') {
      resolved.set(row, result.staffId)
      const staff = staffById.get(result.staffId)!
      if (staff.employeeCode !== row.employeeCode) {
        changes.push({
          kind: 'SET_EMPLOYEE_CODE',
          staffId: staff.id,
          staffName: nameOf(staff.id),
          from: staff.employeeCode,
          to: row.employeeCode,
        })
      }
    } else {
      unresolved.push({ row, reason: result.status, candidates: result.status === 'AMBIGUOUS' ? result.candidates : undefined })
    }
  }

  const supervisorByCode = new Map<string, string>()
  for (const row of rows) {
    if (row.puesto === 'SUPERVISOR') {
      const staffId = resolved.get(row)
      if (staffId) supervisorByCode.set(row.employeeCode, staffId)
    }
  }

  // Venue por su nombre normalizado (sin acentos/mayúsculas): es como se resuelven las filas sin ID
  // de tienda contra `options.venuesSinId` — el archivo dice "ACTIVACIONES" y el venue en la base se
  // llama "ACTIVACIÓN SLP", así que el match nunca es literal.
  const venueByNormalizedName = new Map<string, { id: string; name: string; status: string }>()
  for (const venue of snapshot.venues) {
    venueByNormalizedName.set(norm(venue.name), venue)
  }

  const touchedVenueIds = new Set<string>()
  const venueById = new Map<string, { id: string; name: string; status: string }>()
  // Filas ya resueltas a un venue, agrupadas por venue.id. Antes había como mucho UNA fila por venue
  // (storeId es único); con `venuesSinId` puede haber varias (p.ej. tres "Cubre descanso" cayendo en
  // el mismo venue), así que el resto del pipeline procesa por VENUE, no por fila.
  const rowsByVenue = new Map<string, StructureRow[]>()

  for (const row of rows) {
    let venue: { id: string; name: string; status: string } | undefined

    if (row.storeId) {
      if (duplicateExtraRows.has(row)) continue // ya se reportó como DUPLICATE_STORE arriba
      venue = venueByStoreId.get(row.storeId)
      if (!venue) {
        missingVenues.push(row)
        continue
      }
    } else {
      // Filas sin ID de tienda (Cubre descanso, Activaciones): resuelven por `venuesSinId`. Sin
      // storeId y sin entrada en el mapa, se ignoran en silencio — comportamiento de hoy.
      const key = venuesSinIdKey(row, options.venuesSinId)
      const mappedVenueName = key ? lookupVenuesSinId(options.venuesSinId, key) : undefined
      if (mappedVenueName === undefined) continue
      venue = venueByNormalizedName.get(norm(mappedVenueName))
      if (!venue) {
        missingVenues.push(row)
        continue
      }
    }

    touchedVenueIds.add(venue.id)
    venueById.set(venue.id, venue)

    // Una fila con tienda pero sin supervisor arriba (Excel reordenado, o promotor listado antes
    // de cualquier encabezado de supervisor) no se procesa en silencio: se reporta y se salta
    // entera, para no tocar el supervisor viejo mientras el reporte implica que sí se revisó.
    if (!row.supervisorCode) {
      unresolved.push({ row, reason: 'SIN_SUPERVISOR' })
      continue
    }

    rowsByVenue.set(venue.id, [...(rowsByVenue.get(venue.id) ?? []), row])
  }

  // --- supervisor en conflicto: mismo venue, dos supervisores distintos propuestos ---
  // Solo puede pasar por el camino `venuesSinId` (varias filas sin ID de tienda cayendo en el mismo
  // venue) — por storeId nunca hay más de una fila real por venue, así que aquí no cambia nada.
  const conflictedVenueIds = new Set<string>()
  const supervisoresEnConflicto: PlanResult['supervisoresEnConflicto'] = []
  for (const [venueId, venueRows] of rowsByVenue) {
    const supervisorIds = new Set<string>()
    for (const row of venueRows) {
      const supervisorId = row.supervisorCode ? supervisorByCode.get(row.supervisorCode) : undefined
      if (supervisorId) supervisorIds.add(supervisorId)
    }
    if (supervisorIds.size > 1) {
      conflictedVenueIds.add(venueId)
      supervisoresEnConflicto.push({
        venueName: venueById.get(venueId)!.name,
        supervisores: [...supervisorIds].map(id => nameOf(id)),
      })
    }
  }

  // Pares [staffId, venueId] que YA tienen fila StaffVenue (activa o no) en prod: un ASSIGN sobre
  // un par que NO está aquí es la rama `create` del upsert — ahí SÍ aplica la herencia de PIN. Un
  // ASSIGN sobre un par que sí está (reactivar una fila inactiva) es `update` — el PIN no se toca.
  const existingStaffVenuePairs = new Set(snapshot.assignments.map(a => `${a.staffId}::${a.venueId}`))
  // PINs heredados que YA se repartieron en esta misma corrida, por venue — para que dos altas
  // nuevas del mismo lote no terminen con el mismo PIN heredado en el mismo venue (la unicidad es
  // por venue, así que sólo hace falta llevar la cuenta ahí, no global).
  const claimedPinsByVenue = new Map<string, Set<string>>()
  const planPinIfCreate = (staffId: string, venueId: string): PinPlan | undefined => {
    if (existingStaffVenuePairs.has(`${staffId}::${venueId}`)) return undefined
    const claimed = claimedPinsByVenue.get(venueId) ?? new Set<string>()
    const plan = planPinForNewAssignment(staffId, venueId, snapshot, claimed)
    if (plan.status === 'INHERIT') {
      claimed.add(plan.pin)
      claimedPinsByVenue.set(venueId, claimed)
    }
    return plan
  }

  for (const [venueId, venueRows] of rowsByVenue) {
    const venue = venueById.get(venueId)!

    // --- supervisor de la tienda --- (nunca se toca si el venue está en conflicto)
    if (!conflictedVenueIds.has(venueId)) {
      const supervisorCode = venueRows.map(r => r.supervisorCode!).find(code => supervisorByCode.has(code))
      const supervisorId = supervisorCode ? supervisorByCode.get(supervisorCode) : undefined
      if (supervisorId) {
        const managers = activeOn(venue.id, SUPERVISOR_ROLE)
        if (!managers.some(m => m.staffId === supervisorId)) {
          changes.push({
            kind: 'ASSIGN_MANAGER',
            staffId: supervisorId,
            staffName: nameOf(supervisorId),
            venueId: venue.id,
            venueName: venue.name,
            pinPlan: planPinIfCreate(supervisorId, venue.id),
          })
        }
        for (const other of managers.filter(m => m.staffId !== supervisorId)) {
          changes.push({
            kind: 'UNASSIGN_MANAGER',
            staffId: other.staffId,
            staffName: nameOf(other.staffId),
            venueId: venue.id,
            venueName: venue.name,
          })
        }
      }
    }

    // --- promotor(es) de la tienda ---
    const realPromoters = activeOn(venue.id, PROMOTER_ROLES)
    // Solo cuentan las filas que de verdad proponen algo: una vacante, o una fila resuelta a una
    // persona real. Una fila NOT_FOUND/AMBIGUOUS no debe vaciar los promotores del venue.
    const contributingRows = venueRows.filter(row => row.isVacante || resolved.has(row))

    if (contributingRows.length === 0) continue

    const nonVacanteRows = contributingRows.filter(row => !row.isVacante)
    const hasVacante = contributingRows.some(row => row.isVacante)
    const designatedIds = new Set(nonVacanteRows.map(row => resolved.get(row)!))

    if (designatedIds.size === 0 && hasVacante) {
      // Vacante sin nadie designado: 'conservar' (default) no toca nada; 'libre' desasigna a quien
      // esté hoy.
      if (options.vacantes === 'libre') {
        for (const current of realPromoters) {
          changes.push({
            kind: 'UNASSIGN_PROMOTER',
            staffId: current.staffId,
            staffName: nameOf(current.staffId),
            venueId: venue.id,
            venueName: venue.name,
          })
        }
      }
      continue
    }

    for (const id of designatedIds) {
      if (!realPromoters.some(p => p.staffId === id)) {
        changes.push({
          kind: 'ASSIGN_PROMOTER',
          staffId: id,
          staffName: nameOf(id),
          venueId: venue.id,
          venueName: venue.name,
          pinPlan: planPinIfCreate(id, venue.id),
        })
      }
    }
    for (const current of realPromoters) {
      if (!designatedIds.has(current.staffId)) {
        changes.push({
          kind: 'UNASSIGN_PROMOTER',
          staffId: current.staffId,
          staffName: nameOf(current.staffId),
          venueId: venue.id,
          venueName: venue.name,
        })
      }
    }
  }

  // --- venues huérfanos: solo sucursales (con ID de tienda), nunca los operativos ---
  const orphanVenues = snapshot.venues
    .filter(v => extractStoreId(v.name) !== null && !touchedVenueIds.has(v.id))
    .map(v => ({ id: v.id, name: v.name }))

  if (options.bajaAusentes) {
    for (const venue of orphanVenues) {
      const current = snapshot.venues.find(v => v.id === venue.id)!
      if (current.status !== 'CLOSED') {
        changes.push({ kind: 'CLOSE_VENUE', venueId: venue.id, venueName: venue.name, from: current.status })
      }
    }
  }

  // --- supervisor exclusivo: deja a cada supervisor del archivo solo con lo que el archivo dice ---
  if (options.supervisorExclusivo) {
    const supervisorIds = new Set(supervisorByCode.values())
    for (const staffId of supervisorIds) {
      for (const assignment of snapshot.assignments) {
        if (assignment.staffId !== staffId || assignment.role !== SUPERVISOR_ROLE || !assignment.active) continue
        if (touchedVenueIds.has(assignment.venueId)) continue // venue mencionado en el archivo: ya se manejó arriba
        const venue = snapshot.venues.find(v => v.id === assignment.venueId)
        if (!venue) continue
        changes.push({
          kind: 'UNASSIGN_MANAGER',
          staffId,
          staffName: nameOf(staffId),
          venueId: venue.id,
          venueName: venue.name,
        })
      }
    }
  }

  const collapsed = collapseContradictions(changes)
  const finalChanges = filterProtectedUnassignments(collapsed, options.protegerStaffIds)
  const sinTiendaTrasAplicar = computeSinTiendaTrasAplicar(finalChanges, snapshot, nameOf)

  return { changes: finalChanges, unresolved, missingVenues, orphanVenues, supervisoresEnConflicto, sinTiendaTrasAplicar }
}

/**
 * Llave con la que una fila SIN ID de tienda se busca en `venuesSinId`: para un promotor es su
 * nombre de tienda del Excel ("ACTIVACIONES"); para "Cubre descanso" es el literal 'CUBRE_DESCANSO'
 * (esas filas no traen nombre de tienda). Las filas de SUPERVISOR nunca resuelven por aquí.
 *
 * 🔴 Un "Cubre descanso" puede tener entrada PROPIA por su número de empleado, y entonces ésa gana.
 * Es lo que permite que cada relevo viva en su propia tienda de zona: compartiendo una sola, todos
 * cuelgan del mismo supervisor —una tienda tiene UNO— y es imposible que José reporte a Juan
 * mientras los otros dos reportan a René (pedido de Isaac, 1-sep-2026). Sin entrada propia se cae
 * al literal de siempre, así que un relevo nuevo sigue funcionando sin tocar el mapa.
 */
function venuesSinIdKey(row: StructureRow, venuesSinId?: Record<string, string>): string | null {
  if (row.puesto === 'CUBRE_DESCANSO') {
    return lookupVenuesSinId(venuesSinId, row.employeeCode) !== undefined ? row.employeeCode : 'CUBRE_DESCANSO'
  }
  if (row.puesto === 'PROMOTOR') return row.storeName
  return null
}

/** Busca `key` en `venuesSinId` insensible a acentos/mayúsculas (reutiliza `norm`). */
function lookupVenuesSinId(venuesSinId: Record<string, string> | undefined, key: string): string | undefined {
  if (!venuesSinId) return undefined
  const normKey = norm(key)
  for (const [mapKey, venueName] of Object.entries(venuesSinId)) {
    if (norm(mapKey) === normKey) return venueName
  }
  return undefined
}

/**
 * Para cada persona tocada por un cambio de asignación (ASSIGN/UNASSIGN de manager o promotor),
 * recalcula cuántas tiendas activas le quedarían: las que tiene hoy en `snapshot`, menos las que el
 * plan le quita, más las que el plan le da. Si el resultado es cero, esa persona queda sin ninguna
 * tienda activa — y sin tienda no puede cobrar.
 */
function computeSinTiendaTrasAplicar(
  changes: Change[],
  snapshot: ProdSnapshot,
  nameOf: (id: string) => string,
): PlanResult['sinTiendaTrasAplicar'] {
  type AssignmentChange = Extract<Change, { kind: 'ASSIGN_MANAGER' | 'UNASSIGN_MANAGER' | 'ASSIGN_PROMOTER' | 'UNASSIGN_PROMOTER' }>
  const assignmentChanges = changes.filter(
    (c): c is AssignmentChange =>
      c.kind === 'ASSIGN_MANAGER' || c.kind === 'UNASSIGN_MANAGER' || c.kind === 'ASSIGN_PROMOTER' || c.kind === 'UNASSIGN_PROMOTER',
  )

  const affectedStaffIds = new Set(assignmentChanges.map(c => c.staffId))
  const out: PlanResult['sinTiendaTrasAplicar'] = []

  for (const staffId of affectedStaffIds) {
    const activeVenueIds = new Set(snapshot.assignments.filter(a => a.staffId === staffId && a.active).map(a => a.venueId))

    for (const change of assignmentChanges) {
      if (change.staffId !== staffId) continue
      if (change.kind === 'UNASSIGN_MANAGER' || change.kind === 'UNASSIGN_PROMOTER') activeVenueIds.delete(change.venueId)
      if (change.kind === 'ASSIGN_MANAGER' || change.kind === 'ASSIGN_PROMOTER') activeVenueIds.add(change.venueId)
    }

    if (activeVenueIds.size === 0) {
      const venuesQueDeja = [
        ...new Set(
          assignmentChanges
            .filter(c => c.staffId === staffId && (c.kind === 'UNASSIGN_MANAGER' || c.kind === 'UNASSIGN_PROMOTER'))
            .map(c => c.venueName),
        ),
      ]
      out.push({ staffId, staffName: nameOf(staffId), venuesQueDeja })
    }
  }

  return out
}

/**
 * Una persona tiene UNA sola fila por tienda (`@@unique([staffId, venueId])`). Si el mismo
 * (staffId, venueId) recibe a la vez un ASSIGN (se vuelve supervisor o promotor de esa tienda) y
 * un UNASSIGN (deja de ser supervisor o promotor de esa MISMA tienda) — típico cuando alguien pasa
 * de promotor a supervisor de su propia tienda — el UNASSIGN, si se aplicara después, apagaría la
 * fila que el ASSIGN acababa de encender: la tienda quedaría sin nadie activo mientras el reporte
 * dice que sí quedó asignada. Gana el ASSIGN; el UNASSIGN contradictorio se descarta.
 */
/**
 * Pieza 1: quita del plan cualquier UNASSIGN_MANAGER / UNASSIGN_PROMOTER cuyo staffId esté en
 * `protegerStaffIds` — sin importar de qué rama del pipeline haya salido (turnover normal,
 * --supervisor-exclusivo, --vacantes=libre). Corre DESPUÉS de `collapseContradictions` y ANTES de
 * `computeSinTiendaTrasAplicar`, para que una persona protegida nunca aparezca ahí como si
 * hubiera perdido una tienda que en realidad conserva. Los ASSIGN_* no se tocan: la protección es
 * solo sobre las bajas.
 */
function filterProtectedUnassignments(changes: Change[], protegerStaffIds: string[] | undefined): Change[] {
  if (!protegerStaffIds || protegerStaffIds.length === 0) return changes
  const protectedIds = new Set(protegerStaffIds)
  return changes.filter(c => !((c.kind === 'UNASSIGN_MANAGER' || c.kind === 'UNASSIGN_PROMOTER') && protectedIds.has(c.staffId)))
}

function collapseContradictions(changes: Change[]): Change[] {
  const assignedPairs = new Set(
    changes
      .filter(
        (c): c is Extract<Change, { kind: 'ASSIGN_MANAGER' | 'ASSIGN_PROMOTER' }> =>
          c.kind === 'ASSIGN_MANAGER' || c.kind === 'ASSIGN_PROMOTER',
      )
      .map(c => `${c.staffId}::${c.venueId}`),
  )
  return changes.filter(c => {
    if (c.kind !== 'UNASSIGN_MANAGER' && c.kind !== 'UNASSIGN_PROMOTER') return true
    return !assignedPairs.has(`${c.staffId}::${c.venueId}`)
  })
}

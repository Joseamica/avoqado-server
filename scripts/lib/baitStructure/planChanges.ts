import { extractStoreId, matchStaff, MatchResult, ProdStaff } from './identity'
import { StructureRow } from './types'

export interface ProdSnapshot {
  venues: Array<{ id: string; name: string; status: string }>
  staff: ProdStaff[]
  assignments: Array<{ staffId: string; venueId: string; role: string; active: boolean }>
}

export interface PlanOptions {
  /** Cierra los venues con ID de tienda que ya no vienen en el Excel. Default false. */
  bajaAusentes: boolean
  /** 'conservar' (default) deja al promotor actual; 'libre' lo desasigna. */
  vacantes: 'conservar' | 'libre'
}

export type Change =
  | { kind: 'SET_EMPLOYEE_CODE'; staffId: string; staffName: string; from: string | null; to: string }
  | { kind: 'ASSIGN_MANAGER'; staffId: string; staffName: string; venueId: string; venueName: string }
  | { kind: 'UNASSIGN_MANAGER'; staffId: string; staffName: string; venueId: string; venueName: string }
  | { kind: 'ASSIGN_PROMOTER'; staffId: string; staffName: string; venueId: string; venueName: string }
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

  const touchedVenueIds = new Set<string>()

  for (const row of rows) {
    if (!row.storeId) continue
    if (duplicateExtraRows.has(row)) continue // ya se reportó como DUPLICATE_STORE arriba

    const venue = venueByStoreId.get(row.storeId)
    if (!venue) {
      missingVenues.push(row)
      continue
    }
    touchedVenueIds.add(venue.id)

    // Una fila con tienda pero sin supervisor arriba (Excel reordenado, o promotor listado antes
    // de cualquier encabezado de supervisor) no se procesa en silencio: se reporta y se salta
    // entera, para no tocar el supervisor viejo mientras el reporte implica que sí se revisó.
    if (!row.supervisorCode) {
      unresolved.push({ row, reason: 'SIN_SUPERVISOR' })
      continue
    }

    // --- supervisor de la tienda ---
    const supervisorId = supervisorByCode.get(row.supervisorCode)
    if (supervisorId) {
      const managers = activeOn(venue.id, SUPERVISOR_ROLE)
      if (!managers.some(m => m.staffId === supervisorId)) {
        changes.push({
          kind: 'ASSIGN_MANAGER',
          staffId: supervisorId,
          staffName: nameOf(supervisorId),
          venueId: venue.id,
          venueName: venue.name,
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

    // --- promotor de la tienda ---
    const realPromoters = activeOn(venue.id, PROMOTER_ROLES)
    const designatedId = resolved.get(row)

    if (row.isVacante) {
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

    if (!designatedId) continue

    if (!realPromoters.some(p => p.staffId === designatedId)) {
      changes.push({
        kind: 'ASSIGN_PROMOTER',
        staffId: designatedId,
        staffName: nameOf(designatedId),
        venueId: venue.id,
        venueName: venue.name,
      })
    }
    for (const other of realPromoters.filter(p => p.staffId !== designatedId)) {
      changes.push({
        kind: 'UNASSIGN_PROMOTER',
        staffId: other.staffId,
        staffName: nameOf(other.staffId),
        venueId: venue.id,
        venueName: venue.name,
      })
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

  return { changes: collapseContradictions(changes), unresolved, missingVenues, orphanVenues }
}

/**
 * Una persona tiene UNA sola fila por tienda (`@@unique([staffId, venueId])`). Si el mismo
 * (staffId, venueId) recibe a la vez un ASSIGN (se vuelve supervisor o promotor de esa tienda) y
 * un UNASSIGN (deja de ser supervisor o promotor de esa MISMA tienda) — típico cuando alguien pasa
 * de promotor a supervisor de su propia tienda — el UNASSIGN, si se aplicara después, apagaría la
 * fila que el ASSIGN acababa de encender: la tienda quedaría sin nadie activo mientras el reporte
 * dice que sí quedó asignada. Gana el ASSIGN; el UNASSIGN contradictorio se descarta.
 */
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

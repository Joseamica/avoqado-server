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
  unresolved: Array<{ row: StructureRow; reason: 'AMBIGUOUS' | 'NOT_FOUND' | 'DUPLICATE_STORE'; candidates?: string[] }>
  missingVenues: StructureRow[]
  orphanVenues: Array<{ id: string; name: string }>
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

  const activeOn = (venueId: string, role: string) => snapshot.assignments.filter(a => a.venueId === venueId && a.role === role && a.active)

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

    // --- supervisor de la tienda ---
    // Las cuentas de terminal también son WAITER siempre, pero por si algún día una quedara con una
    // asignación MANAGER activa, la restricción "nunca tocar cuentas de terminal" no está limitada a
    // promotores: se filtra igual aquí.
    const supervisorId = row.supervisorCode ? supervisorByCode.get(row.supervisorCode) : undefined
    if (supervisorId) {
      const managers = activeOn(venue.id, 'MANAGER').filter(a => !staffById.get(a.staffId)?.isTerminalAccount)
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
    // Las cuentas de terminal (tpv-…) también son WAITER: quedan SIEMPRE fuera.
    const realPromoters = activeOn(venue.id, 'WAITER').filter(a => !staffById.get(a.staffId)?.isTerminalAccount)
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

  return { changes, unresolved, missingVenues, orphanVenues }
}

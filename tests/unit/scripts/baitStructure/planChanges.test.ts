import { planChanges, PlanOptions, ProdSnapshot } from '../../../../scripts/lib/baitStructure/planChanges'
import { ProdStaff } from '../../../../scripts/lib/baitStructure/identity'
import { StructureRow } from '../../../../scripts/lib/baitStructure/types'

const OPTIONS: PlanOptions = { bajaAusentes: false, vacantes: 'conservar' }

function staff(id: string, firstName: string, lastName: string, over: Partial<ProdStaff> = {}): ProdStaff {
  return { id, firstName, lastName, employeeCode: null, active: true, ...over }
}

function supervisorRow(employeeCode: string, fullName: string): StructureRow {
  return {
    employeeCode,
    fullName,
    puesto: 'SUPERVISOR',
    estado: 'SLP',
    ciudad: 'SLP',
    storeId: null,
    formato: null,
    storeName: null,
    supervisorCode: null,
    isVacante: false,
  }
}

function promoterRow(employeeCode: string, fullName: string, storeId: string, supervisorCode: string, isVacante = false): StructureRow {
  return {
    employeeCode,
    fullName,
    puesto: 'PROMOTOR',
    estado: 'SLP',
    ciudad: 'SLP',
    storeId,
    formato: 'BAE',
    storeName: 'X',
    supervisorCode,
    isVacante,
  }
}

const SNAPSHOT: ProdSnapshot = {
  venues: [
    { id: 'v1', name: 'BAE EL PORTAL (2838)', status: 'ACTIVE' },
    { id: 'v2', name: 'BAE BANTHI (4494)', status: 'ACTIVE' },
    { id: 'vx', name: 'Cubre Descanso', status: 'ACTIVE' },
  ],
  staff: [
    staff('sup_hugo', 'Hugo', 'González'),
    staff('sup_juan', 'Juan', 'Nájera'),
    staff('promo', 'Alain', 'Rodríguez'),
  ],
  assignments: [{ staffId: 'sup_hugo', venueId: 'v1', role: 'MANAGER', active: true }],
}

const ROWS = [supervisorRow('JUAN01', 'Juan Joel Nájera Ortiz'), promoterRow('ALAIN01', 'Alain Rodríguez Romero', '2838', 'JUAN01')]

describe('planChanges', () => {
  it('cambia el supervisor de la tienda y quita al anterior', () => {
    const kinds = planChanges(ROWS, SNAPSHOT, OPTIONS).changes.map(c => `${c.kind}:${'staffId' in c ? c.staffId : ''}`)
    expect(kinds).toContain('ASSIGN_MANAGER:sup_juan')
    expect(kinds).toContain('UNASSIGN_MANAGER:sup_hugo')
  })

  it('asigna al promotor designado y graba su número de empleado', () => {
    const changes = planChanges(ROWS, SNAPSHOT, OPTIONS).changes
    expect(changes).toContainEqual(expect.objectContaining({ kind: 'ASSIGN_PROMOTER', staffId: 'promo', venueId: 'v1' }))
    expect(changes).toContainEqual(expect.objectContaining({ kind: 'SET_EMPLOYEE_CODE', staffId: 'promo', to: 'ALAIN01' }))
  })

  it('NUNCA desasigna una cuenta de terminal', () => {
    const changes = planChanges(ROWS, SNAPSHOT, OPTIONS).changes
    expect(changes.some(c => 'staffId' in c && c.staffId === 'tpv')).toBe(false)
  })

  it('es idempotente: sobre el resultado ya aplicado no propone nada', () => {
    const applied: ProdSnapshot = {
      ...SNAPSHOT,
      // Ambas personas ya con su número de empleado: si falta una, SET_EMPLOYEE_CODE se vuelve a emitir
      // y la idempotencia no se estaría probando de verdad.
      staff: SNAPSHOT.staff.map(s =>
        s.id === 'promo' ? { ...s, employeeCode: 'ALAIN01' } : s.id === 'sup_juan' ? { ...s, employeeCode: 'JUAN01' } : s,
      ),
      assignments: [
        { staffId: 'sup_juan', venueId: 'v1', role: 'MANAGER', active: true },
        { staffId: 'promo', venueId: 'v1', role: 'WAITER', active: true },
        { staffId: 'tpv', venueId: 'v1', role: 'WAITER', active: true },
      ],
    }
    expect(planChanges(ROWS, applied, OPTIONS).changes).toEqual([])
  })

  it('reporta la tienda del Excel que no existe, sin inventarla', () => {
    const rows = [...ROWS, promoterRow('NUEVO01', 'Persona Nueva', '9999', 'JUAN01')]
    const result = planChanges(rows, SNAPSHOT, OPTIONS)
    expect(result.missingVenues.map(r => r.storeId)).toEqual(['9999'])
  })

  it('lista los venues huérfanos y solo los cierra con la bandera', () => {
    expect(planChanges(ROWS, SNAPSHOT, OPTIONS).orphanVenues.map(v => v.id)).toEqual(['v2'])
    expect(planChanges(ROWS, SNAPSHOT, OPTIONS).changes.some(c => c.kind === 'CLOSE_VENUE')).toBe(false)

    const conBaja = planChanges(ROWS, SNAPSHOT, { ...OPTIONS, bajaAusentes: true })
    expect(conBaja.changes).toContainEqual(expect.objectContaining({ kind: 'CLOSE_VENUE', venueId: 'v2' }))
    // "Cubre Descanso" no tiene ID de tienda: nunca se cierra.
    expect(conBaja.changes.some(c => c.kind === 'CLOSE_VENUE' && c.venueId === 'vx')).toBe(false)
  })

  it('una vacante conserva al promotor actual por default y lo libera con la bandera', () => {
    const conPromotor: ProdSnapshot = {
      ...SNAPSHOT,
      assignments: [...SNAPSHOT.assignments, { staffId: 'promo', venueId: 'v1', role: 'WAITER', active: true }],
    }
    const vacante = [supervisorRow('JUAN01', 'Juan Joel Nájera Ortiz'), promoterRow('VacanteX', 'VacanteX', '2838', 'JUAN01', true)]

    expect(planChanges(vacante, conPromotor, OPTIONS).changes.some(c => c.kind === 'UNASSIGN_PROMOTER')).toBe(false)
    expect(planChanges(vacante, conPromotor, { ...OPTIONS, vacantes: 'libre' }).changes).toContainEqual(
      expect.objectContaining({ kind: 'UNASSIGN_PROMOTER', staffId: 'promo' }),
    )
  })

  it('reporta a la persona que no se pudo resolver en vez de adivinar', () => {
    const rows = [supervisorRow('JUAN01', 'Juan Joel Nájera Ortiz'), promoterRow('X', 'Nadie Conocido Aqui', '2838', 'JUAN01')]
    const result = planChanges(rows, SNAPSHOT, OPTIONS)
    expect(result.unresolved).toContainEqual(expect.objectContaining({ reason: 'NOT_FOUND' }))
  })

  it('NUNCA desasigna una cuenta de terminal con una asignación MANAGER activa', () => {
    // Hoy las cuentas de terminal siempre son promotores (WAITER), pero la restricción "nunca tocar
    // cuentas de terminal" no está limitada a ese rol: si por lo que sea quedara con una asignación
    // MANAGER activa, tampoco debe generarse un cambio que la mencione.
    const snapshotConTerminalManager: ProdSnapshot = {
      ...SNAPSHOT,
      assignments: [...SNAPSHOT.assignments, { staffId: 'tpv', venueId: 'v1', role: 'MANAGER', active: true }],
    }
    const changes = planChanges(ROWS, snapshotConTerminalManager, OPTIONS).changes
    expect(changes.some(c => 'staffId' in c && c.staffId === 'tpv')).toBe(false)
  })

  it('dos filas apuntando al mismo storeId: la primera gana y la segunda se reporta como DUPLICATE_STORE', () => {
    const filaDuplicada = promoterRow('OTRO01', 'Persona Duplicada', '2838', 'JUAN01')
    const rows = [...ROWS, filaDuplicada]
    const result = planChanges(rows, SNAPSHOT, OPTIONS)

    // Solo UN ASSIGN_PROMOTER para la tienda 2838 (el de la primera fila, Alain).
    const assignPromoter = result.changes.filter(c => c.kind === 'ASSIGN_PROMOTER' && c.venueId === 'v1')
    expect(assignPromoter).toHaveLength(1)
    expect(assignPromoter[0]).toMatchObject({ staffId: 'promo' })

    // La fila extra se reporta en vez de procesarse en silencio.
    expect(result.unresolved).toContainEqual(expect.objectContaining({ row: filaDuplicada, reason: 'DUPLICATE_STORE' }))
  })

  it('no toca asignaciones de otro venue (protege el filtro por venue.id)', () => {
    const snapshotOtroVenue: ProdSnapshot = {
      ...SNAPSHOT,
      staff: [...SNAPSHOT.staff, staff('sup_otro', 'Otro', 'Supervisor'), staff('promo_otro', 'Otro', 'Promotor')],
      assignments: [
        ...SNAPSHOT.assignments,
        // Mismo rol que el que se está resolviendo en v1, pero en v2: no deben tocarse.
        { staffId: 'sup_otro', venueId: 'v2', role: 'MANAGER', active: true },
        { staffId: 'promo_otro', venueId: 'v2', role: 'WAITER', active: true },
      ],
    }
    const changes = planChanges(ROWS, snapshotOtroVenue, OPTIONS).changes
    expect(changes.some(c => 'staffId' in c && (c.staffId === 'sup_otro' || c.staffId === 'promo_otro'))).toBe(false)
  })
})

import { planChanges, planPinForNewAssignment, PlanOptions, ProdSnapshot } from '../../../../scripts/lib/baitStructure/planChanges'
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

function promoterRow(
  employeeCode: string,
  fullName: string,
  storeId: string,
  supervisorCode: string | null,
  isVacante = false,
): StructureRow {
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

/** Fila SIN ID de tienda: Cubre descanso o un promotor de Activaciones (resuelven por `venuesSinId`). */
function rowSinId(
  employeeCode: string,
  fullName: string,
  puesto: 'PROMOTOR' | 'CUBRE_DESCANSO',
  storeName: string | null,
  supervisorCode: string | null,
): StructureRow {
  return {
    employeeCode,
    fullName,
    puesto,
    estado: 'SLP',
    ciudad: 'SLP',
    storeId: null,
    formato: null,
    storeName,
    supervisorCode,
    isVacante: false,
  }
}

const SNAPSHOT: ProdSnapshot = {
  venues: [
    { id: 'v1', name: 'BAE EL PORTAL (2838)', status: 'ACTIVE' },
    { id: 'v2', name: 'BAE BANTHI (4494)', status: 'ACTIVE' },
    { id: 'vx', name: 'Cubre Descanso', status: 'ACTIVE' },
  ],
  staff: [staff('sup_hugo', 'Hugo', 'González'), staff('sup_juan', 'Juan', 'Nájera'), staff('promo', 'Alain', 'Rodríguez')],
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

  it('marca las desasignaciones de promotor para revisión de SIMs', () => {
    const conPromotor: ProdSnapshot = {
      ...SNAPSHOT,
      assignments: [...SNAPSHOT.assignments, { staffId: 'promo', venueId: 'v1', role: 'WAITER', active: true }],
    }
    const otro = [supervisorRow('JUAN01', 'Juan Joel Nájera Ortiz'), promoterRow('OTRO01', 'Hugo González', '2838', 'JUAN01')]
    const salidas = planChanges(otro, conPromotor, OPTIONS).changes.filter(c => c.kind === 'UNASSIGN_PROMOTER')
    expect(salidas).toHaveLength(1)
    expect(salidas[0]).toMatchObject({ staffId: 'promo' })
  })

  it('lee promotores CASHIER también, no solo WAITER (setup-playtelecom-complete.ts los da de alta como CASHIER)', () => {
    const conCashier: ProdSnapshot = {
      ...SNAPSHOT,
      staff: [...SNAPSHOT.staff, staff('promo_cashier', 'Otro', 'Cajero')],
      assignments: [...SNAPSHOT.assignments, { staffId: 'promo_cashier', venueId: 'v1', role: 'CASHIER', active: true }],
    }
    // El Excel designa a 'promo' (Alain) para la tienda v1: el CASHIER que ya estaba debe verse
    // como promotor real y recibir UNASSIGN_PROMOTER — si el conciliador solo leyera WAITER, el
    // CASHIER sería invisible y quedarían DOS personas cobrando en la misma tienda.
    const result = planChanges(ROWS, conCashier, OPTIONS)
    expect(result.changes).toContainEqual(expect.objectContaining({ kind: 'UNASSIGN_PROMOTER', staffId: 'promo_cashier', venueId: 'v1' }))
  })

  it('colapsa ASSIGN_MANAGER + UNASSIGN_PROMOTER contradictorios sobre la misma persona y tienda: gana el ASSIGN', () => {
    // sup_juan ya es promotor (WAITER) de v1. El nuevo Excel lo asciende a supervisor de v1 y pone
    // a otra persona ('promo') como promotora. Sin colapsar, UNASSIGN_PROMOTER apagaría la MISMA
    // fila StaffVenue que ASSIGN_MANAGER acababa de encender (una fila por [staffId, venueId]).
    const snapshotConflicto: ProdSnapshot = {
      ...SNAPSHOT,
      assignments: [...SNAPSHOT.assignments, { staffId: 'sup_juan', venueId: 'v1', role: 'WAITER', active: true }],
    }
    const result = planChanges(ROWS, snapshotConflicto, OPTIONS)

    expect(result.changes).toContainEqual(expect.objectContaining({ kind: 'ASSIGN_MANAGER', staffId: 'sup_juan', venueId: 'v1' }))
    expect(result.changes.some(c => c.kind === 'UNASSIGN_PROMOTER' && c.staffId === 'sup_juan' && c.venueId === 'v1')).toBe(false)
    // El promotor designado (Alain) se sigue asignando con normalidad.
    expect(result.changes).toContainEqual(expect.objectContaining({ kind: 'ASSIGN_PROMOTER', staffId: 'promo', venueId: 'v1' }))
  })

  it('fila con tienda pero sin supervisor arriba se reporta como SIN_SUPERVISOR y no se procesa en silencio', () => {
    // Alain resuelve bien contra prod (no es NOT_FOUND); lo único irregular es supervisorCode=null.
    const filaSinSupervisor = promoterRow('ALAIN01', 'Alain Rodríguez Romero', '4494', null)
    const result = planChanges([filaSinSupervisor], SNAPSHOT, OPTIONS)

    expect(result.unresolved).toContainEqual(expect.objectContaining({ row: filaSinSupervisor, reason: 'SIN_SUPERVISOR' }))
    // No se asigna como promotor de v2 ni se toca nada de esa tienda: se salta entera.
    expect(result.changes.some(c => 'venueId' in c && c.venueId === 'v2')).toBe(false)
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

describe('planChanges — Pieza 1: filas sin ID de tienda (venuesSinId)', () => {
  const VENUE_ACTIVACIONES = { id: 'vact', name: 'ACTIVACIÓN SLP', status: 'ACTIVE' }
  const SNAPSHOT_SIN_ID: ProdSnapshot = {
    ...SNAPSHOT,
    venues: [...SNAPSHOT.venues, VENUE_ACTIVACIONES],
    staff: [...SNAPSHOT.staff, staff('activ1', 'Nueva', 'Activaciones')],
  }
  const OPTIONS_CON_MAPA: PlanOptions = { ...OPTIONS, venuesSinId: { ACTIVACIONES: 'ACTIVACIÓN SLP', CUBRE_DESCANSO: 'Cubre Descanso' } }

  it('una fila ACTIVACIONES resuelve al venue del mapa (insensible a acentos/mayúsculas) y produce su ASSIGN_PROMOTER', () => {
    // storeName en minúsculas y sin acento a propósito: el match contra la llave del mapa y contra
    // el nombre del venue en la base deben ser insensibles a ambos.
    const filaActivaciones = rowSinId('ACT01', 'Nueva Activaciones', 'PROMOTOR', 'activaciones', 'JUAN01')
    const rows = [supervisorRow('JUAN01', 'Juan Joel Nájera Ortiz'), filaActivaciones]
    const result = planChanges(rows, SNAPSHOT_SIN_ID, OPTIONS_CON_MAPA)

    expect(result.changes).toContainEqual(expect.objectContaining({ kind: 'ASSIGN_PROMOTER', staffId: 'activ1', venueId: 'vact' }))
  })

  /**
   * 🔴 Isaac pidió el 1-sep-2026 separar a los tres "Cubre descanso" en una tienda por zona
   * (SUR1 · NORTE1 · NORTE2), porque compartiendo una sola tienda es imposible que José cuelgue de
   * Juan y los otros dos de René: una tienda tiene UN supervisor.
   *
   * Sin esto, `venuesSinIdKey` devuelve el literal 'CUBRE_DESCANSO' para TODAS las filas de ese
   * puesto y los tres caen siempre en el mismo venue — la separación se deshace en la siguiente
   * corrida del conciliador. La llave por número de empleado es lo que permite mandarlos a tiendas
   * distintas; quien no tenga entrada propia sigue cayendo en el literal de siempre.
   */
  it('un CUBRE_DESCANSO con entrada propia por número de empleado va a SU tienda, no a la compartida', () => {
    const VENUE_SUR1 = { id: 'vsur1', name: 'CUBRE DESCANSO ZONA SUR1', status: 'ACTIVE' }
    const snapshot: ProdSnapshot = {
      ...SNAPSHOT_SIN_ID,
      venues: [...SNAPSHOT_SIN_ID.venues, VENUE_SUR1],
      staff: [...SNAPSHOT_SIN_ID.staff, staff('jose1', 'José', 'Lopes')],
    }
    const options: PlanOptions = {
      ...OPTIONS,
      venuesSinId: { BSCBJOSE04: 'CUBRE DESCANSO ZONA SUR1', CUBRE_DESCANSO: 'Cubre Descanso' },
    }

    const rows = [supervisorRow('JUAN01', 'Juan Joel Nájera Ortiz'), rowSinId('BSCBJOSE04', 'José Lopes', 'CUBRE_DESCANSO', null, 'JUAN01')]
    const result = planChanges(rows, snapshot, options)

    expect(result.changes).toContainEqual(expect.objectContaining({ kind: 'ASSIGN_PROMOTER', staffId: 'jose1', venueId: 'vsur1' }))
  })

  it('un CUBRE_DESCANSO SIN entrada propia sigue cayendo en la tienda compartida (no rompe lo de hoy)', () => {
    const snapshot: ProdSnapshot = {
      ...SNAPSHOT_SIN_ID,
      staff: [...SNAPSHOT_SIN_ID.staff, staff('otro1', 'Otro', 'Relevo')],
    }
    const options: PlanOptions = {
      ...OPTIONS,
      venuesSinId: { BSCBJOSE04: 'CUBRE DESCANSO ZONA SUR1', CUBRE_DESCANSO: 'Cubre Descanso' },
    }

    const rows = [supervisorRow('JUAN01', 'Juan Joel Nájera Ortiz'), rowSinId('OTRO01', 'Otro Relevo', 'CUBRE_DESCANSO', null, 'JUAN01')]
    const result = planChanges(rows, snapshot, options)

    expect(result.changes).toContainEqual(expect.objectContaining({ kind: 'ASSIGN_PROMOTER', staffId: 'otro1', venueId: 'vx' }))
  })

  it('una fila sin storeId y sin entrada en el mapa se sigue ignorando: no se le asigna ningún venue ni entra a unresolved', () => {
    const filaSuelta = rowSinId('ACT01', 'Nueva Activaciones', 'PROMOTOR', 'ALGO_QUE_NO_ESTA_EN_EL_MAPA', 'JUAN01')
    const rows = [supervisorRow('JUAN01', 'Juan Joel Nájera Ortiz'), filaSuelta]
    const result = planChanges(rows, SNAPSHOT_SIN_ID, OPTIONS_CON_MAPA)

    // El nombre sí resuelve a un staff real (se prueba en el test anterior), pero sin storeId y sin
    // entrada en el mapa la fila se ignora en silencio: nunca produce un ASSIGN/UNASSIGN de venue,
    // ni se manda a unresolved.
    expect(result.changes.some(c => c.kind === 'ASSIGN_PROMOTER' || c.kind === 'UNASSIGN_PROMOTER')).toBe(false)
    expect(result.unresolved).toEqual([])
  })
})

describe('planChanges — Pieza 2: supervisor en conflicto sobre un mismo venue', () => {
  it('dos filas hacia el mismo venue del mapa con supervisores distintos: se asignan ambos promotores, cero cambios de manager, y se reporta el conflicto', () => {
    const snapshot: ProdSnapshot = {
      ...SNAPSHOT,
      staff: [...SNAPSHOT.staff, staff('cubre1', 'Cubre', 'Uno'), staff('cubre2', 'Cubre', 'Dos')],
    }
    const options: PlanOptions = { ...OPTIONS, venuesSinId: { CUBRE_DESCANSO: 'Cubre Descanso' } }
    const rows = [
      supervisorRow('JUAN01', 'Juan Joel Nájera Ortiz'),
      supervisorRow('HUGO01', 'Hugo González'),
      rowSinId('CUB01', 'Cubre Uno', 'CUBRE_DESCANSO', null, 'JUAN01'),
      rowSinId('CUB02', 'Cubre Dos', 'CUBRE_DESCANSO', null, 'HUGO01'),
    ]
    const result = planChanges(rows, snapshot, options)

    // La parte de promotores SÍ se aplica: ambas personas quedan asignadas a "Cubre Descanso" (vx).
    expect(result.changes).toContainEqual(expect.objectContaining({ kind: 'ASSIGN_PROMOTER', staffId: 'cubre1', venueId: 'vx' }))
    expect(result.changes).toContainEqual(expect.objectContaining({ kind: 'ASSIGN_PROMOTER', staffId: 'cubre2', venueId: 'vx' }))

    // La parte de supervisor NO se toca en absoluto para ese venue.
    expect(result.changes.some(c => (c.kind === 'ASSIGN_MANAGER' || c.kind === 'UNASSIGN_MANAGER') && c.venueId === 'vx')).toBe(false)

    // No entra a unresolved (no bloquea la escritura); se reporta en supervisoresEnConflicto.
    expect(result.unresolved.some(u => u.reason === 'SIN_SUPERVISOR')).toBe(false)
    expect(result.supervisoresEnConflicto).toContainEqual(
      expect.objectContaining({ venueName: 'Cubre Descanso', supervisores: expect.arrayContaining(['Juan Nájera', 'Hugo González']) }),
    )
  })
})

describe('planChanges — Pieza 3: guarda de "sin tienda tras aplicar"', () => {
  it('desasignar a alguien de su única tienda lo reporta en sinTiendaTrasAplicar', () => {
    // 'promo' (Alain) hoy SOLO tiene v1. El Excel designa a Hugo como promotor de v1 -> Alain se
    // desasigna y se queda sin ninguna tienda activa.
    const conPromotor: ProdSnapshot = {
      ...SNAPSHOT,
      assignments: [...SNAPSHOT.assignments, { staffId: 'promo', venueId: 'v1', role: 'WAITER', active: true }],
    }
    const otro = [supervisorRow('JUAN01', 'Juan Joel Nájera Ortiz'), promoterRow('OTRO01', 'Hugo González', '2838', 'JUAN01')]
    const result = planChanges(otro, conPromotor, OPTIONS)

    expect(result.sinTiendaTrasAplicar).toContainEqual(expect.objectContaining({ staffId: 'promo', staffName: 'Alain Rodríguez' }))
  })

  it('si el mismo plan además lo asigna a otra tienda, no lo reporta', () => {
    const conPromotor: ProdSnapshot = {
      ...SNAPSHOT,
      assignments: [...SNAPSHOT.assignments, { staffId: 'promo', venueId: 'v1', role: 'WAITER', active: true }],
    }
    // Se le quita v1 (Hugo pasa a ser el promotor ahí) pero el mismo Excel lo designa en v2.
    const rows = [
      supervisorRow('JUAN01', 'Juan Joel Nájera Ortiz'),
      promoterRow('OTRO01', 'Hugo González', '2838', 'JUAN01'),
      promoterRow('ALAIN01', 'Alain Rodríguez Romero', '4494', 'JUAN01'),
    ]
    const result = planChanges(rows, conPromotor, OPTIONS)

    expect(result.sinTiendaTrasAplicar.some(p => p.staffId === 'promo')).toBe(false)
    // Confirma que sí se movió, para que el test pruebe lo que dice probar.
    expect(result.changes).toContainEqual(expect.objectContaining({ kind: 'ASSIGN_PROMOTER', staffId: 'promo', venueId: 'v2' }))
  })
})

describe('planChanges — Pieza 1 (piezas-ejecucion): protegerStaffIds', () => {
  it('una persona protegida que hoy es promotora de un venue que el archivo reasigna a otra NO produce UNASSIGN_PROMOTER; sin la bandera sí', () => {
    // 'promo' (Alain) es hoy el promotor de v1. El Excel (ROWS) designa a Alain otra vez para
    // v1 — así que para forzar la baja, usamos un Excel que designa a OTRA persona (Hugo) para
    // esa misma tienda, exactamente el escenario que dispara UNASSIGN_PROMOTER.
    const conPromotor: ProdSnapshot = {
      ...SNAPSHOT,
      assignments: [...SNAPSHOT.assignments, { staffId: 'promo', venueId: 'v1', role: 'WAITER', active: true }],
    }
    const otro = [supervisorRow('JUAN01', 'Juan Joel Nájera Ortiz'), promoterRow('OTRO01', 'Hugo González', '2838', 'JUAN01')]

    // Sin la bandera: se desasigna con normalidad (regresión — esto ya se probaba arriba, se repite
    // aquí para dejar el contraste explícito junto al caso protegido).
    const sinProteger = planChanges(otro, conPromotor, OPTIONS)
    expect(sinProteger.changes).toContainEqual(expect.objectContaining({ kind: 'UNASSIGN_PROMOTER', staffId: 'promo', venueId: 'v1' }))

    // Con 'promo' protegida: el mismo Excel, el mismo snapshot, pero CERO UNASSIGN_PROMOTER para
    // ella. Hugo se sigue asignando con normalidad (la protección no bloquea al nuevo promotor).
    const conProteger = planChanges(otro, conPromotor, { ...OPTIONS, protegerStaffIds: ['promo'] })
    expect(conProteger.changes.some(c => c.kind === 'UNASSIGN_PROMOTER' && c.staffId === 'promo')).toBe(false)
    expect(conProteger.changes).toContainEqual(expect.objectContaining({ kind: 'ASSIGN_PROMOTER', venueId: 'v1' }))

    // Tampoco debe aparecer en sinTiendaTrasAplicar: como la baja se filtró, 'promo' no perdió
    // ninguna tienda desde el punto de vista del plan final.
    expect(conProteger.sinTiendaTrasAplicar.some(p => p.staffId === 'promo')).toBe(false)
  })

  it('protege también contra UNASSIGN_MANAGER, sin tocar al ASSIGN del nuevo supervisor', () => {
    // sup_hugo es hoy MANAGER de v1 (ya en SNAPSHOT). El Excel (ROWS) sube a sup_juan como su
    // supervisor: sin protección eso dispara UNASSIGN_MANAGER para Hugo.
    const conProteger = planChanges(ROWS, SNAPSHOT, { ...OPTIONS, protegerStaffIds: ['sup_hugo'] })
    expect(conProteger.changes.some(c => c.kind === 'UNASSIGN_MANAGER' && c.staffId === 'sup_hugo')).toBe(false)
    expect(conProteger.changes).toContainEqual(expect.objectContaining({ kind: 'ASSIGN_MANAGER', staffId: 'sup_juan', venueId: 'v1' }))
  })
})

describe('planChanges — Pieza 4: --supervisor-exclusivo', () => {
  it('apagada (default): no se emite ningún cambio sobre un venue ausente del archivo', () => {
    // sup_juan queda como MANAGER de v1 (vía ROWS) y YA era MANAGER de v2 en la base; v2 no aparece
    // en el Excel.
    const snapshot: ProdSnapshot = {
      ...SNAPSHOT,
      assignments: [...SNAPSHOT.assignments, { staffId: 'sup_juan', venueId: 'v2', role: 'MANAGER', active: true }],
    }
    const result = planChanges(ROWS, snapshot, OPTIONS) // supervisorExclusivo no está en OPTIONS
    expect(result.changes.some(c => 'venueId' in c && c.venueId === 'v2')).toBe(false)
  })

  it('encendida: desasigna a los supervisores DEL ARCHIVO de los venues que el archivo no menciona', () => {
    const snapshot: ProdSnapshot = {
      ...SNAPSHOT,
      assignments: [...SNAPSHOT.assignments, { staffId: 'sup_juan', venueId: 'v2', role: 'MANAGER', active: true }],
    }
    const result = planChanges(ROWS, snapshot, { ...OPTIONS, supervisorExclusivo: true })
    expect(result.changes).toContainEqual(expect.objectContaining({ kind: 'UNASSIGN_MANAGER', staffId: 'sup_juan', venueId: 'v2' }))
  })

  it('solo afecta a supervisores que aparecen en el archivo: uno ausente del Excel no se toca aunque tenga un venue ausente', () => {
    // sup_hugo NO aparece como SUPERVISOR en ROWS (solo JUAN01 aparece). Aunque v2 tampoco esté en
    // el archivo, sup_hugo no debe tocarse ahí porque él mismo no está en el archivo.
    const snapshot: ProdSnapshot = {
      ...SNAPSHOT,
      assignments: [...SNAPSHOT.assignments, { staffId: 'sup_hugo', venueId: 'v2', role: 'MANAGER', active: true }],
    }
    const result = planChanges(ROWS, snapshot, { ...OPTIONS, supervisorExclusivo: true })
    expect(result.changes.some(c => 'venueId' in c && 'staffId' in c && c.staffId === 'sup_hugo' && c.venueId === 'v2')).toBe(false)
  })
})

describe('planPinForNewAssignment — función pura de herencia de PIN', () => {
  const snapshotConPin = (overrides: Partial<ProdSnapshot> = {}): ProdSnapshot => ({ ...SNAPSHOT, ...overrides })

  it('hereda el PIN cuando la persona ya lo tiene en otra tienda y está libre en el destino', () => {
    const snapshot = snapshotConPin({
      assignments: [{ staffId: 'promo', venueId: 'v2', role: 'WAITER', active: true, pin: '4321' }],
    })
    expect(planPinForNewAssignment('promo', 'v1', snapshot)).toEqual({
      status: 'INHERIT',
      pin: '4321',
      fromVenueName: 'BAE BANTHI (4494)',
    })
  })

  it('no hereda y reporta cuando el PIN candidato ya está ocupado en el destino', () => {
    const snapshot = snapshotConPin({
      assignments: [
        { staffId: 'promo', venueId: 'v2', role: 'WAITER', active: true, pin: '4321' },
        // Otra persona ya usa ese mismo PIN en v1 (el destino): @@unique([venueId, pin]) lo prohíbe.
        { staffId: 'sup_hugo', venueId: 'v1', role: 'MANAGER', active: true, pin: '4321' },
      ],
    })
    expect(planPinForNewAssignment('promo', 'v1', snapshot)).toEqual({ status: 'SIN_PIN', reason: 'PIN_OCUPADO_EN_DESTINO' })
  })

  it('sin ningún PIN en otra tienda: no inventa uno, reporta SIN_PRECEDENTE', () => {
    const snapshot = snapshotConPin({ assignments: [] })
    expect(planPinForNewAssignment('promo', 'v1', snapshot)).toEqual({ status: 'SIN_PIN', reason: 'SIN_PRECEDENTE' })
  })

  it('con dos PINs distintos en tiendas distintas, hereda el de la asignación más reciente (activa le gana a la que ya terminó)', () => {
    const snapshot = snapshotConPin({
      venues: [...SNAPSHOT.venues, { id: 'v3', name: 'BAE OTRA (7777)', status: 'ACTIVE' }],
      assignments: [
        {
          staffId: 'promo',
          venueId: 'v2',
          role: 'WAITER',
          active: false,
          pin: '1111',
          startDate: new Date('2025-01-01'),
          endDate: new Date('2025-06-01'),
        },
        { staffId: 'promo', venueId: 'v3', role: 'WAITER', active: true, pin: '2222', startDate: new Date('2026-01-01') },
      ],
    })
    expect(planPinForNewAssignment('promo', 'v1', snapshot)).toEqual({ status: 'INHERIT', pin: '2222', fromVenueName: 'BAE OTRA (7777)' })
  })

  it('con dos asignaciones activas hoy y PINs distintos sin desempate claro, no adivina: AMBIGUO', () => {
    const snapshot = snapshotConPin({
      venues: [...SNAPSHOT.venues, { id: 'v3', name: 'BAE OTRA (7777)', status: 'ACTIVE' }],
      assignments: [
        { staffId: 'promo', venueId: 'v2', role: 'WAITER', active: true, pin: '1111', startDate: new Date('2026-01-01') },
        { staffId: 'promo', venueId: 'v3', role: 'WAITER', active: true, pin: '2222', startDate: new Date('2026-01-01') },
      ],
    })
    expect(planPinForNewAssignment('promo', 'v1', snapshot)).toEqual({ status: 'SIN_PIN', reason: 'AMBIGUO' })
  })

  it('varias filas con el MISMO pin no son ambiguas: no importa cuántas, hereda ese único valor', () => {
    const snapshot = snapshotConPin({
      venues: [...SNAPSHOT.venues, { id: 'v3', name: 'BAE OTRA (7777)', status: 'ACTIVE' }],
      assignments: [
        { staffId: 'promo', venueId: 'v2', role: 'WAITER', active: false, pin: '4321', endDate: new Date('2025-01-01') },
        { staffId: 'promo', venueId: 'v3', role: 'WAITER', active: false, pin: '4321', endDate: new Date('2025-06-01') },
      ],
    })
    expect(planPinForNewAssignment('promo', 'v1', snapshot)).toEqual({ status: 'INHERIT', pin: '4321', fromVenueName: 'BAE OTRA (7777)' })
  })

  it('additionallyOccupiedPins evita repartir el mismo PIN heredado dos veces en el mismo lote', () => {
    const snapshot = snapshotConPin({
      assignments: [{ staffId: 'promo', venueId: 'v2', role: 'WAITER', active: true, pin: '4321' }],
    })
    expect(planPinForNewAssignment('promo', 'v1', snapshot, new Set(['4321']))).toEqual({
      status: 'SIN_PIN',
      reason: 'PIN_OCUPADO_EN_DESTINO',
    })
  })
})

describe('planChanges — Pieza 5: herencia de PIN sólo en la rama `create` de ASSIGN_MANAGER/ASSIGN_PROMOTER', () => {
  it('ASSIGN_PROMOTER que crea una fila nueva hereda el PIN que la persona tiene en otra tienda', () => {
    const snapshot: ProdSnapshot = {
      ...SNAPSHOT,
      assignments: [...SNAPSHOT.assignments, { staffId: 'promo', venueId: 'v2', role: 'WAITER', active: true, pin: '4321' }],
    }
    const result = planChanges(ROWS, snapshot, OPTIONS)
    const assign = result.changes.find(c => c.kind === 'ASSIGN_PROMOTER' && c.staffId === 'promo' && c.venueId === 'v1')
    expect(assign).toMatchObject({ pinPlan: { status: 'INHERIT', pin: '4321', fromVenueName: 'BAE BANTHI (4494)' } })
  })

  it('ASSIGN_PROMOTER que crea una fila nueva sin PIN previo en ninguna tienda: pinPlan SIN_PIN/SIN_PRECEDENTE', () => {
    const result = planChanges(ROWS, SNAPSHOT, OPTIONS)
    const assign = result.changes.find(c => c.kind === 'ASSIGN_PROMOTER' && c.staffId === 'promo' && c.venueId === 'v1')
    expect(assign).toMatchObject({ pinPlan: { status: 'SIN_PIN', reason: 'SIN_PRECEDENTE' } })
  })

  it('en la rama UPDATE (la persona ya tenía fila en esa tienda) no calcula ningún plan de PIN', () => {
    // 'promo' ya tiene una fila StaffVenue en v1, inactiva y con PIN propio: el Excel (ROWS) la
    // reactiva ahí mismo, así que el upsert entra por `update` — su PIN es el suyo y no se toca.
    const snapshot: ProdSnapshot = {
      ...SNAPSHOT,
      assignments: [
        ...SNAPSHOT.assignments,
        { staffId: 'promo', venueId: 'v1', role: 'WAITER', active: false, pin: '9999', endDate: new Date('2026-01-01') },
      ],
    }
    const result = planChanges(ROWS, snapshot, OPTIONS)
    const assign = result.changes.find(c => c.kind === 'ASSIGN_PROMOTER' && c.staffId === 'promo' && c.venueId === 'v1')
    expect(assign).toBeDefined()
    expect((assign as { pinPlan?: unknown }).pinPlan).toBeUndefined()
  })

  it('ASSIGN_MANAGER que crea una fila nueva también hereda PIN (misma regla que ASSIGN_PROMOTER)', () => {
    const snapshot: ProdSnapshot = {
      ...SNAPSHOT,
      assignments: [...SNAPSHOT.assignments, { staffId: 'sup_juan', venueId: 'v2', role: 'WAITER', active: true, pin: '7777' }],
    }
    const result = planChanges(ROWS, snapshot, OPTIONS)
    const assign = result.changes.find(c => c.kind === 'ASSIGN_MANAGER' && c.staffId === 'sup_juan' && c.venueId === 'v1')
    expect(assign).toMatchObject({ pinPlan: { status: 'INHERIT', pin: '7777', fromVenueName: 'BAE BANTHI (4494)' } })
  })

  it('dos altas nuevas en el mismo venue que heredarían el mismo PIN: la segunda queda SIN_PIN/PIN_OCUPADO_EN_DESTINO', () => {
    // Tanto 'promo' como 'sup_juan' se van a crear en v1 en esta misma corrida (Alain de promotor,
    // Juan de supervisor), y ambos tienen el PIN '5555' en v2: sólo el primero en procesarse puede
    // heredarlo — el otro no, para no repartir el mismo PIN dos veces en el mismo venue.
    const snapshot: ProdSnapshot = {
      ...SNAPSHOT,
      assignments: [
        ...SNAPSHOT.assignments,
        { staffId: 'promo', venueId: 'v2', role: 'WAITER', active: true, pin: '5555' },
        { staffId: 'sup_juan', venueId: 'v2', role: 'WAITER', active: true, pin: '5555' },
      ],
    }
    const result = planChanges(ROWS, snapshot, OPTIONS)
    const assignManager = result.changes.find(c => c.kind === 'ASSIGN_MANAGER' && c.staffId === 'sup_juan' && c.venueId === 'v1')
    const assignPromoter = result.changes.find(c => c.kind === 'ASSIGN_PROMOTER' && c.staffId === 'promo' && c.venueId === 'v1')

    const plans = [assignManager, assignPromoter].map(c => (c as { pinPlan?: { status: string } }).pinPlan?.status)
    // Uno hereda, el otro no — nunca los dos heredan el mismo PIN en el mismo venue.
    expect(plans.filter(s => s === 'INHERIT')).toHaveLength(1)
    expect(plans.filter(s => s === 'SIN_PIN')).toHaveLength(1)
  })
})

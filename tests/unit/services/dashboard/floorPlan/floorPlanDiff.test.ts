import {
  computeFloorPlanDiff,
  isEmptyFloorPlanDiff,
  FloorPlanRuleError,
  type CurrentFloorPlan,
} from '@/services/dashboard/floorPlan/floorPlanDiff'
import type { DesiredTable, PlanTable } from '@/services/dashboard/floorPlan/floorPlan.types'

const area = { id: 'a1', name: 'Salón', floorShape: 'WIDE' as const, sortOrder: 0, externalId: null }
const table = (id: string, number: string, extra: Partial<PlanTable> = {}): PlanTable => ({
  id,
  number,
  capacity: 4,
  shape: 'SQUARE',
  rotation: 0,
  positionX: 0.5,
  positionY: 0.5,
  areaId: 'a1',
  hasOpenOrder: false,
  ...extra,
})
const keep = (t: PlanTable, extra: Partial<DesiredTable> = {}): DesiredTable => ({
  id: t.id,
  number: t.number,
  capacity: t.capacity,
  shape: t.shape,
  rotation: t.rotation,
  positionX: t.positionX,
  positionY: t.positionY,
  areaRef: t.areaId,
  ...extra,
})
const fresh = (clientId: string, number: string, extra: Partial<DesiredTable> = {}): DesiredTable => ({
  clientId,
  number,
  capacity: 4,
  shape: 'SQUARE',
  rotation: 0,
  positionX: 0.2,
  positionY: 0.2,
  areaRef: 'a1',
  ...extra,
})
const current = (tables: PlanTable[], extra: Partial<CurrentFloorPlan> = {}): CurrentFloorPlan => ({
  areas: [area],
  activeTables: tables,
  archivedByNumber: new Map(),
  elements: [],
  ...extra,
})
const keepArea = { id: 'a1', name: 'Salón', floorShape: 'WIDE' as const, sortOrder: 0 }
const rule = (fn: () => unknown) => {
  try {
    fn()
  } catch (e) {
    if (e instanceof FloorPlanRuleError) return e
    throw e
  }
  throw new Error('esperaba FloorPlanRuleError')
}

describe('computeFloorPlanDiff — áreas', () => {
  it('crea un área nueva y una mesa que la referencia por clientId', () => {
    const d = computeFloorPlanDiff(current([], { areas: [] }), {
      areas: [{ clientId: 'n1', name: ' Terraza ', floorShape: 'TALL', sortOrder: 0 }],
      tables: [fresh('t1', '1', { areaRef: 'n1' })],
      elements: [],
    })
    expect(d.areas.create).toEqual([{ clientId: 'n1', name: 'Terraza', floorShape: 'TALL', sortOrder: 0 }])
    expect(d.tables.create[0].data.area).toEqual({ kind: 'new', clientId: 'n1' })
  })

  it('borra las áreas que el plano ya no trae', () => {
    const d = computeFloorPlanDiff(current([], { areas: [area, { ...area, id: 'a2', name: 'Terraza' }] }), {
      areas: [keepArea],
      tables: [],
      elements: [],
    })
    expect(d.areas.remove).toEqual(['a2'])
  })

  it('no reescribe un área que no cambió', () => {
    const d = computeFloorPlanDiff(current([]), { areas: [keepArea], tables: [], elements: [] })
    expect(d.areas.update).toEqual([])
    expect(d.areas.rename).toEqual([])
  })

  it('nombres cruzados entre dos áreas pasan por nombre temporal', () => {
    const terraza = { ...area, id: 'a2', name: 'Terraza', sortOrder: 1 }
    const d = computeFloorPlanDiff(current([], { areas: [area, terraza] }), {
      areas: [
        { ...keepArea, name: 'Terraza' },
        { id: 'a2', name: 'Salón', floorShape: 'WIDE', sortOrder: 1 },
      ],
      tables: [],
      elements: [],
    })
    expect(d.areas.rename.sort()).toEqual(['a1', 'a2'])
  })

  it('rechaza dos áreas con el mismo nombre (sin importar mayúsculas)', () => {
    const e = rule(() =>
      computeFloorPlanDiff(current([], { areas: [] }), {
        areas: [
          { clientId: 'x', name: 'Salón', floorShape: 'WIDE', sortOrder: 0 },
          { clientId: 'y', name: 'salón ', floorShape: 'WIDE', sortOrder: 1 },
        ],
        tables: [],
        elements: [],
      }),
    )
    expect(e.code).toBe('AREA_NAME_DUPLICATED')
  })

  it('rechaza un id de área que no existe', () => {
    expect(rule(() => computeFloorPlanDiff(current([]), { areas: [{ ...keepArea, id: 'zz' }], tables: [], elements: [] })).code).toBe(
      'UNKNOWN_AREA',
    )
  })
})

describe('computeFloorPlanDiff — mesas', () => {
  it('mueve una mesa existente y archiva la que ya no viene', () => {
    const t1 = table('t1', '1'),
      t2 = table('t2', '2')
    const d = computeFloorPlanDiff(current([t1, t2]), { areas: [keepArea], tables: [keep(t1, { positionX: 0.1 })], elements: [] })
    expect(d.tables.update).toEqual([{ id: 't1', data: expect.objectContaining({ positionX: 0.1, area: { kind: 'existing', id: 'a1' } }) }])
    expect(d.tables.archive).toEqual(['t2'])
  })

  it('no reescribe una mesa que no cambió', () => {
    const t1 = table('t1', '1')
    expect(computeFloorPlanDiff(current([t1]), { areas: [keepArea], tables: [keep(t1)], elements: [] }).tables.update).toEqual([])
  })

  it('una mesa NUEVA con el número de una que se quita reutiliza esa misma fila', () => {
    const t5 = table('t5', '5')
    const d = computeFloorPlanDiff(current([t5]), { areas: [keepArea], tables: [fresh('n', '5', { capacity: 6 })], elements: [] })
    expect(d.tables.archive).toEqual([])
    expect(d.tables.create).toEqual([])
    expect(d.tables.update[0]).toEqual({ id: 't5', data: expect.objectContaining({ capacity: 6 }) })
  })

  it('una mesa NUEVA con el número de una archivada la revive (mismo id e historial)', () => {
    const d = computeFloorPlanDiff(current([], { archivedByNumber: new Map([['5', 'old5']]) }), {
      areas: [keepArea],
      tables: [fresh('n', '5')],
      elements: [],
    })
    expect(d.tables.revive).toEqual([{ id: 'old5', data: expect.objectContaining({ number: '5' }) }])
    expect(d.tables.create).toEqual([])
  })

  it('intercambiar números (1↔2) marca las dos para número temporal', () => {
    const t1 = table('t1', '1'),
      t2 = table('t2', '2')
    const d = computeFloorPlanDiff(current([t1, t2]), {
      areas: [keepArea],
      tables: [keep(t1, { number: '2' }), keep(t2, { number: '1' })],
      elements: [],
    })
    expect(d.tables.renumber.sort()).toEqual(['t1', 't2'])
    expect(d.tables.freeNumbers).toEqual([])
  })

  it('renombrar la 7 a 5 cuando la 5 está archivada libera el número de la archivada', () => {
    const t7 = table('t7', '7')
    const d = computeFloorPlanDiff(current([t7], { archivedByNumber: new Map([['5', 'old5']]) }), {
      areas: [keepArea],
      tables: [keep(t7, { number: '5' })],
      elements: [],
    })
    expect(d.tables.renumber).toEqual(['t7'])
    expect(d.tables.freeNumbers).toEqual([{ id: 'old5', number: '5' }])
  })

  it('renombrar la 7 a 5 mientras se quita la 5 archiva la 5 y libera su número', () => {
    const t5 = table('t5', '5'),
      t7 = table('t7', '7')
    const d = computeFloorPlanDiff(current([t5, t7]), { areas: [keepArea], tables: [keep(t7, { number: '5' })], elements: [] })
    expect(d.tables.archive).toEqual(['t5'])
    expect(d.tables.freeNumbers).toEqual([{ id: 't5', number: '5' }])
  })

  it('rechaza números repetidos', () => {
    expect(
      rule(() => computeFloorPlanDiff(current([]), { areas: [keepArea], tables: [fresh('a', '3'), fresh('b', ' 3')], elements: [] })).code,
    ).toBe('TABLE_NUMBER_DUPLICATED')
  })

  it('rechaza una mesa que ya no existe', () => {
    expect(
      rule(() => computeFloorPlanDiff(current([]), { areas: [keepArea], tables: [keep(table('ghost', '1'))], elements: [] })).code,
    ).toBe('UNKNOWN_TABLE')
  })

  it('rechaza una mesa que apunta a un área que no existe, y dice cuál mesa', () => {
    const e = rule(() =>
      computeFloorPlanDiff(current([]), { areas: [keepArea], tables: [fresh('a', '4', { areaRef: 'nope' })], elements: [] }),
    )
    expect(e.code).toBe('UNKNOWN_AREA_REF')
    expect(e.message).toBe('La mesa 4 apunta a un área que no existe en el plano.')
    expect(e.details).toEqual({ ref: 'nope', number: '4' })
  })

  it('borrar un área que todavía tiene una mesa: el mensaje nombra la mesa', () => {
    const t4 = table('t4', '4', { areaId: 'a2' })
    const terraza = { ...area, id: 'a2', name: 'Terraza', sortOrder: 1 }
    // El plano ya no trae la Terraza, pero la mesa 4 sigue apuntando a ella.
    const e = rule(() =>
      computeFloorPlanDiff(current([t4], { areas: [area, terraza] }), { areas: [keepArea], tables: [keep(t4)], elements: [] }),
    )
    expect(e.code).toBe('UNKNOWN_AREA_REF')
    expect(e.message).toBe('La mesa 4 apunta a un área que no existe en el plano.')
  })

  it('reutilizar la fila de una mesa que se quita, sin cambiar nada, no la reescribe', () => {
    const t5 = table('t5', '5')
    const d = computeFloorPlanDiff(current([t5]), {
      areas: [keepArea],
      tables: [fresh('n', '5', { positionX: 0.5, positionY: 0.5 })],
      elements: [],
    })
    expect(d.tables.update).toEqual([])
    expect(d.tables.archive).toEqual([])
    expect(d.tables.create).toEqual([])
  })

  it('rechaza renombrar una mesa al número «5 (archivada)» que tiene una mesa archivada', () => {
    const t7 = table('t7', '7')
    const e = rule(() =>
      computeFloorPlanDiff(current([t7], { archivedByNumber: new Map([['5 (archivada)', 'old5']]) }), {
        areas: [keepArea],
        tables: [keep(t7, { number: '5 (archivada)' })],
        elements: [],
      }),
    )
    expect(e.code).toBe('TABLE_NUMBER_RESERVED')
    expect(e.message).toBe('El número «5 (archivada)» está reservado para una mesa archivada. Usa otro.')
    expect(e.details).toEqual({ number: '5 (archivada)' })
  })

  it('rechaza una mesa NUEVA con el número «5 (archivada 2)» de una archivada (no revive la mesa vieja)', () => {
    const e = rule(() =>
      computeFloorPlanDiff(current([], { archivedByNumber: new Map([['5 (archivada 2)', 'old5']]) }), {
        areas: [keepArea],
        tables: [fresh('n', '5 (archivada 2)')],
        elements: [],
      }),
    )
    expect(e.code).toBe('TABLE_NUMBER_RESERVED')
  })

  it('«5 (archivada)» se puede usar si ninguna mesa archivada lo tiene', () => {
    const d = computeFloorPlanDiff(current([]), { areas: [keepArea], tables: [fresh('n', '5 (archivada)')], elements: [] })
    expect(d.tables.create).toEqual([{ clientId: 'n', data: expect.objectContaining({ number: '5 (archivada)' }) }])
  })

  it('una mesa sin área queda sin acomodar', () => {
    const d = computeFloorPlanDiff(current([]), {
      areas: [keepArea],
      tables: [fresh('a', '1', { areaRef: null, positionX: null, positionY: null })],
      elements: [],
    })
    expect(d.tables.create[0].data.area).toBeNull()
  })
})

describe('computeFloorPlanDiff — elementos y límites', () => {
  const wall = { type: 'WALL' as const, areaRef: 'a1', positionX: 0, positionY: 0, endX: 1, endY: 0, rotation: 0 }

  it('crea elementos y archiva los que ya no vienen', () => {
    const old = {
      id: 'e1',
      type: 'LABEL' as const,
      areaId: 'a1',
      positionX: 0.1,
      positionY: 0.1,
      width: null,
      height: null,
      rotation: 0,
      endX: null,
      endY: null,
      label: 'VIP',
      color: null,
    }
    const d = computeFloorPlanDiff(current([], { elements: [old] }), { areas: [keepArea], tables: [], elements: [wall] })
    expect(d.elements.create).toHaveLength(1)
    expect(d.elements.archive).toEqual(['e1'])
  })

  it('rechaza una pared sin punto final y una barra sin tamaño', () => {
    expect(rule(() => computeFloorPlanDiff(current([]), { areas: [keepArea], tables: [], elements: [{ ...wall, endX: null }] })).code).toBe(
      'ELEMENT_SHAPE_INVALID',
    )
    expect(
      rule(() =>
        computeFloorPlanDiff(current([]), {
          areas: [keepArea],
          tables: [],
          elements: [{ type: 'BAR_COUNTER', areaRef: 'a1', positionX: 0, positionY: 0, rotation: 0 }],
        }),
      ).code,
    ).toBe('ELEMENT_SHAPE_INVALID')
  })

  it('rechaza un letrero vacío', () => {
    expect(
      rule(() =>
        computeFloorPlanDiff(current([]), {
          areas: [keepArea],
          tables: [],
          elements: [{ type: 'LABEL', areaRef: 'a1', positionX: 0, positionY: 0, rotation: 0, label: '  ' }],
        }),
      ).code,
    ).toBe('ELEMENT_SHAPE_INVALID')
  })

  it('un elemento que apunta a un área que no existe dice cuál es', () => {
    const sinArea = (extra: Record<string, unknown>) =>
      rule(() =>
        computeFloorPlanDiff(current([]), {
          areas: [keepArea],
          tables: [],
          elements: [{ ...wall, areaRef: 'nope', ...extra } as typeof wall],
        }),
      )
    const pared = sinArea({})
    expect(pared.code).toBe('UNKNOWN_AREA_REF')
    expect(pared.message).toBe('Una pared apunta a un área que no existe en el plano.')
    expect(pared.details).toEqual({ ref: 'nope', index: 0, type: 'WALL' })
    const vip = sinArea({ type: 'LABEL', label: ' VIP ', endX: null, endY: null })
    expect(vip.message).toBe('El letrero «VIP» apunta a un área que no existe en el plano.')
  })

  it('respeta los límites', () => {
    const limits = { areas: 30, tables: 1, elements: 1500 }
    expect(
      rule(() => computeFloorPlanDiff(current([]), { areas: [keepArea], tables: [fresh('a', '1'), fresh('b', '2')], elements: [] }, limits))
        .code,
    ).toBe('LIMIT_EXCEEDED')
  })
})

describe('computeFloorPlanDiff — claves repetidas y tipo de elemento', () => {
  const barra = {
    id: 'e1',
    type: 'SERVICE_AREA' as const,
    areaId: 'a1',
    positionX: 0.1,
    positionY: 0.1,
    width: 0.3,
    height: 0.1,
    rotation: 0,
    endX: null,
    endY: null,
    label: null,
    color: null,
  }
  const keepElement = (extra: Record<string, unknown> = {}) => ({
    id: barra.id,
    type: barra.type,
    areaRef: 'a1',
    positionX: barra.positionX,
    positionY: barra.positionY,
    width: barra.width,
    height: barra.height,
    rotation: barra.rotation,
    ...extra,
  })

  it('rechaza la misma mesa dos veces (no archiva en silencio a otra)', () => {
    const t1 = table('t1', '1'),
      t2 = table('t2', '2')
    const e = rule(() =>
      computeFloorPlanDiff(current([t1, t2]), { areas: [keepArea], tables: [keep(t1), keep(t1, { number: '2' })], elements: [] }),
    )
    expect(e.code).toBe('DUPLICATE_ID')
    expect(e.details).toEqual({ id: 't1' })
  })

  it('rechaza el mismo elemento dos veces', () => {
    const e = rule(() =>
      computeFloorPlanDiff(current([], { elements: [barra] }), {
        areas: [keepArea],
        tables: [],
        elements: [keepElement(), keepElement({ positionX: 0.5 })],
      }),
    )
    expect(e.code).toBe('DUPLICATE_ID')
    expect(e.details).toEqual({ id: 'e1' })
  })

  it('rechaza la misma área dos veces aunque traiga otro nombre', () => {
    const e = rule(() => computeFloorPlanDiff(current([]), { areas: [keepArea, { ...keepArea, name: 'Otra' }], tables: [], elements: [] }))
    expect(e.code).toBe('DUPLICATE_ID')
    expect(e.details).toEqual({ id: 'a1' })
  })

  it('rechaza dos mesas nuevas con la misma clave', () => {
    const e = rule(() => computeFloorPlanDiff(current([]), { areas: [keepArea], tables: [fresh('c', '1'), fresh('c', '2')], elements: [] }))
    expect(e.code).toBe('DUPLICATE_CLIENT_ID')
    expect(e.details).toEqual({ clientId: 'c' })
  })

  it('las claves repetidas se reportan antes que cualquier otra regla (áreas, elementos o mesas)', () => {
    // La mesa trae la clave repetida Y un elemento apunta a un área que no existe: gana la clave repetida.
    const e = rule(() =>
      computeFloorPlanDiff(current([]), {
        areas: [keepArea],
        tables: [fresh('c', '1'), fresh('c', '2')],
        elements: [{ type: 'WALL', areaRef: 'nope', positionX: 0, positionY: 0, endX: 1, endY: 0, rotation: 0 }],
      }),
    )
    expect(e.code).toBe('DUPLICATE_CLIENT_ID')
    // Dos áreas nuevas con la misma clave, y además dos áreas con el mismo nombre: gana la clave.
    const a = rule(() =>
      computeFloorPlanDiff(current([], { areas: [] }), {
        areas: [
          { clientId: 'x', name: 'Salón', floorShape: 'WIDE', sortOrder: 0 },
          { clientId: 'x', name: 'Salón', floorShape: 'WIDE', sortOrder: 1 },
        ],
        tables: [],
        elements: [],
      }),
    )
    expect(a.code).toBe('DUPLICATE_CLIENT_ID')
    // Una clave nueva igual al id de un área que ya existe también es una clave repetida.
    const b = rule(() =>
      computeFloorPlanDiff(current([]), {
        areas: [keepArea, { clientId: 'a1', name: 'Terraza', floorShape: 'WIDE', sortOrder: 1 }],
        tables: [],
        elements: [],
      }),
    )
    expect(b.code).toBe('DUPLICATE_CLIENT_ID')
  })

  it('un elemento que cambia de tipo con la misma geometría sí se actualiza; uno igual no', () => {
    const changed = computeFloorPlanDiff(current([], { elements: [barra] }), {
      areas: [keepArea],
      tables: [],
      elements: [keepElement({ type: 'BAR_COUNTER' })],
    })
    expect(changed.elements.update).toEqual([{ id: 'e1', data: expect.objectContaining({ type: 'BAR_COUNTER' }) }])
    const same = computeFloorPlanDiff(current([], { elements: [barra] }), { areas: [keepArea], tables: [], elements: [keepElement()] })
    expect(same.elements.update).toEqual([])
    expect(same.elements.archive).toEqual([])
  })
})

describe('isEmptyFloorPlanDiff — guardado sin cambios', () => {
  const t1 = table('t1', '1')
  it('un plano idéntico al actual da un diff vacío', () => {
    const d = computeFloorPlanDiff(current([t1]), { areas: [keepArea], tables: [keep(t1)], elements: [] })
    expect(isEmptyFloorPlanDiff(d)).toBe(true)
  })
  it('un solo cambio real (mover una mesa) NO es vacío, y tampoco crear ni quitar', () => {
    const mover = computeFloorPlanDiff(current([t1]), { areas: [keepArea], tables: [keep(t1, { positionX: 0.9 })], elements: [] })
    expect(isEmptyFloorPlanDiff(mover)).toBe(false)
    const crear = computeFloorPlanDiff(current([t1]), { areas: [keepArea], tables: [keep(t1), fresh('n', '2')], elements: [] })
    expect(isEmptyFloorPlanDiff(crear)).toBe(false)
    const quitar = computeFloorPlanDiff(current([t1]), { areas: [keepArea], tables: [], elements: [] })
    expect(isEmptyFloorPlanDiff(quitar)).toBe(false)
  })
})

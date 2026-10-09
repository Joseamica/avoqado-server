import { computeFloorPlanDiff, FloorPlanRuleError, type CurrentFloorPlan } from '@/services/dashboard/floorPlan/floorPlanDiff'
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

  it('rechaza una mesa que apunta a un área que no existe', () => {
    expect(
      rule(() => computeFloorPlanDiff(current([]), { areas: [keepArea], tables: [fresh('a', '1', { areaRef: 'nope' })], elements: [] }))
        .code,
    ).toBe('UNKNOWN_AREA_REF')
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

  it('respeta los límites', () => {
    const limits = { areas: 30, tables: 1, elements: 1500 }
    expect(
      rule(() => computeFloorPlanDiff(current([]), { areas: [keepArea], tables: [fresh('a', '1'), fresh('b', '2')], elements: [] }, limits))
        .code,
    ).toBe('LIMIT_EXCEEDED')
  })
})

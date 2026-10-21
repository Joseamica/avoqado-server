import { randomUUID } from 'crypto'
import { publishFloorPlanSchema } from '@/schemas/dashboard/floorPlan.schema'

const body = (capacity: number) => ({
  params: { venueId: 'v1' },
  body: {
    saveId: randomUUID(),
    baseFingerprint: '0123456789abcdef',
    areas: [{ clientId: 'a1', name: 'Salón', floorShape: 'WIDE', sortOrder: 0 }],
    tables: [{ clientId: 't1', number: '1', capacity, shape: 'SQUARE', rotation: 0, positionX: 0.5, positionY: 0.5, areaRef: 'a1' }],
    elements: [],
  },
})

describe('publishFloorPlanSchema — personas por mesa', () => {
  // NUEVO: 0 = «sin dato» (la sincronización de SoftRestaurant crea mesas así).
  it('acepta 0 («sin dato»), 1 y 99', () => {
    for (const n of [0, 1, 99]) expect(publishFloorPlanSchema.safeParse(body(n)).success).toBe(true)
  })
  it('rechaza −1, 100 y fracciones, con mensaje en español', () => {
    for (const n of [-1, 100, 2.5]) {
      const r = publishFloorPlanSchema.safeParse(body(n))
      expect(r.success).toBe(false)
    }
    const r = publishFloorPlanSchema.safeParse(body(-1))
    expect(!r.success && r.error.issues[0].message).toMatch(/personas/i)
  })
})

/** El cuerpo de `body(4)` con la mesa cambiada (ancho/alto). */
const conTamano = (extra: Record<string, unknown>) => {
  const b = body(4)
  return { ...b, body: { ...b.body, tables: [{ ...b.body.tables[0], ...extra }] } }
}
const mensajes = (extra: Record<string, unknown>) => {
  const r = publishFloorPlanSchema.safeParse(conTamano(extra))
  return r.success ? [] : r.error.issues.map(i => i.message)
}

describe('publishFloorPlanSchema — tamaño libre de la mesa (spec 2026-10-12)', () => {
  it('acepta ancho y alto juntos, los dos null (automático) o ninguno (dashboard de antes)', () => {
    for (const extra of [{ width: 0.075, height: 0.16 }, { width: null, height: null }, {}, { width: 1, height: 1 }])
      expect(publishFloorPlanSchema.safeParse(conTamano(extra)).success).toBe(true)
  })

  // Review Focus 2
  it('rechaza uno solo, con mensaje en español', () => {
    for (const extra of [{ width: 0.1 }, { height: 0.1 }, { width: 0.1, height: null }, { width: null }])
      expect(mensajes(extra)).toContain('La mesa necesita ancho y alto juntos, o ninguno de los dos')
  })

  it('rechaza cero, negativo y más de 1, en español', () => {
    expect(mensajes({ width: 0, height: 0.1 })).toContain('El ancho debe ser mayor a cero')
    expect(mensajes({ width: 0.1, height: -0.2 })).toContain('El alto debe ser mayor a cero')
    expect(mensajes({ width: 1.2, height: 0.1 })).toContain('El ancho no puede salirse del plano')
  })
})

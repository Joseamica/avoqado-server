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

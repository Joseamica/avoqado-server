/**
 * 🔴 Encargo 04edc5 (hz:8024bc1c:D41, founder «C»): la MISMA cortesía se guarda de dos formas según la pantalla, y la lista de
 * órdenes del detalle del turno tiene que decir lo mismo con las dos. Coca $25 + Agua $20 de cortesía + Café $30, 10 % de cuenta:
 *
 *   · Mostrador/«Cobrar»: Agua a precio lleno (total $20, descuento $20); la orden guarda subtotal $75, descuento $25.50.
 *   · Mesas: Agua en $0 (descuento $20); la orden guarda subtotal $55, descuento $5.50.
 *
 * La lista mostraba `subtotal` $75 en una y $55 en la otra. La convención de los reportes (`salesGiveaways.ts`, como Square: la
 * venta bruta lleva lo regalado y el descuento lo resta) dice $75 en las dos. El total cobrado ($49.50) no cambia.
 */
import { prismaMock } from '@tests/__helpers__/setup'
import { getShiftById } from '@/services/dashboard/shift.dashboard.service'

const CAJERA = { id: 'staff-1', firstName: 'Ana', lastName: 'López' }

const renglon = (id: string, unitPrice: number, total: number, discountAmount: number, isCortesia = false) => ({
  id,
  productName: id,
  quantity: 1,
  unitPrice,
  total,
  discountAmount,
  isCortesia,
  weightQuantity: null,
  modifiers: [],
  giftCardId: null,
  product: { id: `p-${id}`, name: id },
})

const orden = (id: string, subtotal: number, agua: ReturnType<typeof renglon>) => ({
  id,
  orderNumber: id,
  total: 49.5,
  subtotal,
  status: 'COMPLETED',
  table: null,
  createdAt: new Date('2026-11-17T16:00:00.000Z'),
  servedById: CAJERA.id,
  servedBy: CAJERA,
  // Cobro sin turno dentro del horario: la vía por la que el detalle toma la orden del turno.
  payments: [
    {
      id: `pago-${id}`,
      method: 'CASH',
      cardBrand: null,
      maskedPan: null,
      shiftId: null,
      type: 'REGULAR',
      createdAt: new Date('2026-11-17T16:05:00.000Z'),
    },
  ],
  items: [renglon('Coca', 25, 25, 0), agua, renglon('Café', 30, 30, 0)],
  orderDiscounts: [],
})

const turno = (orders: unknown[]) => ({
  id: 'shift-1',
  venueId: 'venue-1',
  staffId: CAJERA.id,
  status: 'CLOSED',
  startTime: new Date('2026-11-17T14:00:00.000Z'),
  endTime: new Date('2026-11-17T22:00:00.000Z'),
  startingCash: 0,
  endingCash: 0,
  totalSales: 99,
  totalTips: 0,
  staff: { ...CAJERA, email: 'ana@example.test' },
  venue: { id: 'venue-1', name: 'Venue', timezone: 'America/Mexico_City' },
  payments: [],
  orders,
})

describe('detalle del turno · la cortesía de Mesas y la de Mostrador dicen lo mismo (encargo 04edc5)', () => {
  beforeEach(() => jest.clearAllMocks())

  it('🔴 el subtotal de la lista es $75 en las dos formas; el total cobrado no cambia', async () => {
    prismaMock.shift.findFirst.mockResolvedValue(
      turno([orden('mostrador', 75, renglon('Agua', 20, 20, 20, true)), orden('mesas', 55, renglon('Agua', 20, 0, 20, true))]) as any,
    )

    const detalle = await getShiftById('venue-1', 'shift-1')

    const porId = Object.fromEntries(detalle.orders.map((o: { id: string; subtotal: number; total: number }) => [o.id, o]))
    expect([porId.mostrador.subtotal, porId.mesas.subtotal]).toEqual([75, 75])
    expect([porId.mostrador.total, porId.mesas.total]).toEqual([49.5, 49.5])
  })

  it('cada renglón de la lista dice si fue cortesía (aditivo)', async () => {
    prismaMock.shift.findFirst.mockResolvedValue(turno([orden('mesas', 55, renglon('Agua', 20, 0, 20, true))]) as any)

    const detalle = await getShiftById('venue-1', 'shift-1')

    expect(detalle.orders[0].items.map((i: { name: string; isCortesia: boolean }) => [i.name, i.isCortesia])).toEqual([
      ['Coca', false],
      ['Agua', true],
      ['Café', false],
    ])
  })

  it('regresión: los productos vendidos ya cuadraban (el regalo no es ingreso en ninguna forma)', async () => {
    prismaMock.shift.findFirst.mockResolvedValue(
      turno([orden('mostrador', 75, renglon('Agua', 20, 20, 20, true)), orden('mesas', 55, renglon('Agua', 20, 0, 20, true))]) as any,
    )

    const detalle = await getShiftById('venue-1', 'shift-1')

    expect(detalle.topProducts.find((p: { name: string }) => p.name === 'Agua')).toEqual({ name: 'Agua', quantity: 2, revenue: 0 })
  })
})

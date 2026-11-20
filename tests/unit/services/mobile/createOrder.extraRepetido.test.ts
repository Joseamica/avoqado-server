/**
 * La venta con la MISMA opción repetida (encargo a508f4, Flautas Coyoacán): el POS manda el `modifierId` repetido, uno por vez.
 * Este es el contrato que el interruptor `allowRepeat` del grupo usa: cada vez se cobra a su precio y queda su propio renglón
 * (inventario y reportes cuentan renglones × cantidad). Si esto cambia, «2 de Cochinita» se cobraría como una.
 */
import { Prisma } from '@prisma/client'
import { createOrderWithItems } from '@/services/mobile/order.mobile.service'
import { prismaMock } from '../../../__helpers__/setup'

jest.mock('@/services/venueSalesGuard', () => ({ assertVenueSalesEnabled: jest.fn() }))
jest.mock('@/services/kds/kitchenDisplayStations', () => ({
  assertPreparationAuthoringAccess: jest.fn(),
  debeMarcarCocina: jest.fn(),
}))
jest.mock('@/services/shared/repartoDescuentoTx', () => ({
  ...jest.requireActual('@/services/shared/repartoDescuentoTx'),
  sincronizarRepartos: jest.fn(),
}))
jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: jest.fn(() => null) } }))

const venueId = 'venue-1'
const staffId = 'seller-1'
const D = (value: number) => new Prisma.Decimal(value)
const paquete = { id: 'p1', name: 'Paquete Completo', price: D(168), sku: null, soldByWeight: false, category: { name: 'Especiales' } }
const extras = [
  { id: 'cochinita', name: 'Flautas Cochinita', price: D(0) },
  { id: 'papa', name: 'Flautas Papa', price: D(0) },
  { id: 'queso', name: 'Queso extra', price: D(15) },
]

describe('createOrderWithItems — la misma opción varias veces', () => {
  let stored: any

  beforeEach(() => {
    jest.clearAllMocks()
    stored = null
    prismaMock.orderAction = { create: jest.fn() }
    prismaMock.$transaction.mockImplementation(async (callback: any) => callback(prismaMock))
    prismaMock.$queryRaw.mockResolvedValue([])
    prismaMock.order.findUnique.mockImplementation(async () => stored)
    prismaMock.staffVenue.findFirst.mockResolvedValue({ id: 'sv', staffId, venueId, active: true } as any)
    prismaMock.product.findMany.mockResolvedValue([paquete] as any)
    prismaMock.modifier.findMany.mockResolvedValue(extras as any)
    prismaMock.discount.findMany.mockResolvedValue([])
    prismaMock.shift.findFirst.mockResolvedValue(null)
    prismaMock.order.create.mockImplementation(async ({ data }: any) => {
      stored = {
        ...data,
        id: 'order-1',
        createdAt: new Date(),
        items: data.items.create.map((row: any, k: number) => ({
          ...row,
          id: `oi-${k + 1}`,
          product: paquete,
          modifiers: row.modifiers?.create.map((m: any, j: number) => ({ ...m, id: `oim-${k}-${j}` })) ?? [],
        })),
        promotions: [],
      }
      return stored
    })
  })

  it('2 de Cochinita + 1 de Papa: tres renglones de extra, cada uno con su nombre y precio', async () => {
    await createOrderWithItems(venueId, {
      staffId,
      items: [{ productId: 'p1', quantity: 1, modifierIds: ['cochinita', 'cochinita', 'papa'], externalId: 'l1' }],
    } as any)
    const renglones = (prismaMock.order.create.mock.calls[0][0] as any).data.items.create[0].modifiers.create
    expect(renglones.map((m: any) => m.modifierId)).toEqual(['cochinita', 'cochinita', 'papa'])
    expect(renglones.every((m: any) => m.quantity === 1)).toBe(true)
    expect(stored.total).toEqual(D(168))
  })

  it('un extra con precio repetido se cobra cada vez: 2 × $15 en un paquete de $168 = $198', async () => {
    const result = await createOrderWithItems(venueId, {
      staffId,
      items: [{ productId: 'p1', quantity: 1, modifierIds: ['queso', 'queso', 'papa'], externalId: 'l1' }],
    } as any)
    expect(result.total).toBe(198)
  })

  it('y la cantidad del platillo multiplica todo: 2 paquetes con 2 × $15 = $396', async () => {
    const result = await createOrderWithItems(venueId, {
      staffId,
      items: [{ productId: 'p1', quantity: 2, modifierIds: ['queso', 'queso'], externalId: 'l1' }],
    } as any)
    expect(result.total).toBe(396)
  })

  // Regresión: sin repetir, como siempre.
  it('cada extra una vez sigue cobrando lo mismo que antes', async () => {
    const result = await createOrderWithItems(venueId, {
      staffId,
      items: [{ productId: 'p1', quantity: 1, modifierIds: ['cochinita', 'queso'], externalId: 'l1' }],
    } as any)
    expect(result.total).toBe(183)
  })
})

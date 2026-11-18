/**
 * D93 (encargo 18cc7f, founder 16-nov «B», como Square): la venta que el POS recrea al subir de su cola sin red (`isOfflineReplay` +
 * `createdAtLocal`) guarda la hora del aparato en `clientCreatedAt`, SÓLO para reportes; `createdAt` sigue siendo la llegada (las
 * reglas de dinero no cambian). En línea, como siempre. Andamio de createOrderCortesia.test.ts (tomado del borrador del encargo 921513).
 */
import { Prisma } from '@prisma/client'
import { buildOrderItemsData, createOrderWithItems } from '@/services/mobile/order.mobile.service'
import { sincronizarRepartos } from '@/services/shared/repartoDescuentoTx'
import { BadRequestError, ForbiddenError } from '@/errors/AppError'
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
const actorId = 'manager-1'
const D = (value: number) => new Prisma.Decimal(value)
const product = { id: 'p1', name: 'Bebida', price: D(100), sku: 'BEB-1', soldByWeight: false, category: { name: 'Bebidas' } }

function input(items: any[], extra: Record<string, unknown> = {}) {
  return { staffId, items, canCompItems: true, performedBy: actorId, ...extra } as any
}

function line(externalId: string, extra: Record<string, unknown> = {}) {
  return { productId: 'p1', quantity: 1, modifierIds: ['m1'], externalId, ...extra }
}

describe('createOrderWithItems — la hora real de la venta sin red', () => {
  let stored: any

  beforeEach(() => {
    jest.clearAllMocks()
    stored = null
    prismaMock.orderAction = { create: jest.fn() }
    prismaMock.$transaction.mockImplementation(async (callback: any) => callback(prismaMock))
    prismaMock.$queryRaw.mockResolvedValue([])
    prismaMock.order.findUnique.mockImplementation(async () => stored)
    prismaMock.staffVenue.findFirst.mockImplementation(async ({ where }: any) => ({
      id: where.staffId === actorId ? 'actor-sv' : 'seller-sv',
      staffId: where.staffId,
      venueId,
      active: true,
    }))
    prismaMock.product.findMany.mockResolvedValue([product])
    prismaMock.modifier.findMany.mockResolvedValue([{ id: 'm1', name: 'Extra', price: D(10) }])
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
          product: row.productId ? product : null,
          modifiers: row.modifiers?.create.map((m: any) => ({ ...m, id: m.modifierId })) ?? [],
        })),
        promotions: [],
      }
      return stored
    })
  })

  afterEach(() => jest.useRealTimers())

  const LLEGADA = new Date('2026-11-12T06:10:00.000Z') // 00:10 del 12 en CDMX
  const VEINTITRES_50 = new Date('2026-11-12T05:50:00.000Z') // 23:50 del 11 en CDMX
  const reloj = () => {
    jest.useFakeTimers({
      doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask'],
    })
    jest.setSystemTime(LLEGADA)
  }

  it('P1 la venta de las 23:50 que sube a las 00:10 guarda su hora del aparato aparte; createdAt sigue siendo la llegada', async () => {
    reloj()
    await createOrderWithItems(venueId, input([line('l-1')], { isOfflineReplay: true, createdAtLocal: VEINTITRES_50.getTime() }))
    const data = prismaMock.order.create.mock.calls[0][0].data
    expect(data.clientCreatedAt).toEqual(VEINTITRES_50)
    expect(data).not.toHaveProperty('createdAt')
  })

  it('P1 reloj del aparato tres días atrás o adelantado: no se guarda (ni se recorta a una orilla)', async () => {
    reloj()
    await createOrderWithItems(venueId, input([line('l-1')], { isOfflineReplay: true, createdAtLocal: LLEGADA.getTime() - 3 * 86_400_000 }))
    expect(prismaMock.order.create.mock.calls[0][0].data).not.toHaveProperty('clientCreatedAt')
    stored = null
    await createOrderWithItems(venueId, input([line('l-2')], { isOfflineReplay: true, createdAtLocal: LLEGADA.getTime() + 600_000 }))
    expect(prismaMock.order.create.mock.calls[1][0].data).not.toHaveProperty('clientCreatedAt')
  })

  it('regresión: en línea (aunque traiga createdAtLocal) la orden no lleva hora del aparato ni createdAt propio', async () => {
    reloj()
    await createOrderWithItems(venueId, input([line('l-1')], { createdAtLocal: VEINTITRES_50.getTime() }))
    const data = prismaMock.order.create.mock.calls[0][0].data
    expect(data).not.toHaveProperty('clientCreatedAt')
    expect(data).not.toHaveProperty('createdAt')
  })

  it('regresión: un reintento con la misma llave devuelve la venta guardada y no escribe otra', async () => {
    reloj()
    await createOrderWithItems(
      venueId,
      input([line('l-1')], { externalId: 'venta-1', isOfflineReplay: true, createdAtLocal: VEINTITRES_50.getTime() }),
    )
    await createOrderWithItems(
      venueId,
      input([line('l-1')], { externalId: 'venta-1', isOfflineReplay: true, createdAtLocal: VEINTITRES_50.getTime() + 1000 }),
    )
    expect(prismaMock.order.create).toHaveBeenCalledTimes(1)
  })
})

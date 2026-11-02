/**
 * 🔴 DINERO — el renglón POR PESO con la MISMA cuenta que las apps (Parte 2 rediseñada, 1-nov-2026).
 *
 * ANDROID, WINDOWS e iOS (todas las versiones en uso) cobran `round(kg × centavos/kg)` en Double; el SERVIDOR calculaba
 * `round(precio × kg × 100)` y en algunos pesos daba un centavo distinto: tres pesadas sin red dejaban la venta PARCIAL.
 * Ahora el SERVIDOR copia la cuenta de las apps (no la «exacta», que dejaba peor a las apps viejas: 0.102 kg × $182.50).
 */
jest.mock('@/services/venueSalesGuard', () => ({
  __esModule: true,
  assertVenueSalesEnabled: jest.fn(),
}))
jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { getBroadcastingService: jest.fn(() => null) },
}))

import { Decimal } from '@prisma/client/runtime/library'
import { createOrderWithItems, type CreateOrderInput } from '@/services/mobile/order.mobile.service'
import { runWithContext } from '@/observability/executionContext'
import { prismaMock } from '../../../__helpers__/setup'

function queso(price: number) {
  return {
    id: 'prod-1',
    name: 'Queso',
    price: new Decimal(price),
    sku: 'QSO-1',
    categoryId: 'cat-1',
    category: { name: 'Cremería' },
    soldByWeight: true,
  }
}

function ordenDesdeLosDatos(args: any) {
  const { data } = args
  return {
    id: 'order-1',
    orderNumber: data.orderNumber,
    status: 'CONFIRMED',
    paymentStatus: 'PENDING',
    subtotal: data.subtotal,
    discountAmount: data.discountAmount,
    taxAmount: data.taxAmount,
    total: data.total,
    createdAt: new Date(),
    items: data.items.create.map((it: any, k: number) => ({ id: `oi-${k}`, ...it, modifiers: [] })),
    promotions: [],
  }
}

const datosDeLaOrden = () => (prismaMock.order.create as jest.Mock).mock.calls[0][0].data
const lineasCreadas = () => datosDeLaOrden().items.create as Array<{ total: Decimal; discountAmount: Decimal }>

const pesada = (kg: number, extra: Record<string, unknown> = {}) => ({ productId: 'prod-1', quantity: 1, weightQuantity: kg, ...extra })

function crear(items: unknown[]) {
  return createOrderWithItems('venue-1', { staffId: 'staff-1', source: 'AVOQADO_ANDROID', items } as CreateOrderInput)
}

beforeEach(() => {
  jest.clearAllMocks()
  prismaMock.orderAction = { create: jest.fn() }
  prismaMock.$transaction.mockImplementation(async (callback: any) => callback(prismaMock))
  prismaMock.staff.findUnique.mockResolvedValue({ id: 'staff-1', venueId: 'venue-1' })
  prismaMock.staffVenue.findFirst.mockResolvedValue({ id: 'sv-1', staffId: 'staff-1', venueId: 'venue-1', active: true })
  prismaMock.modifier.findMany.mockResolvedValue([])
  prismaMock.discount.findMany.mockResolvedValue([])
  prismaMock.order.findUnique.mockResolvedValue(null)
  prismaMock.order.create.mockImplementation(async (args: any) => ordenDesdeLosDatos(args))
  prismaMock.activityLog.create.mockResolvedValue({ id: 'log-1' })
  prismaMock.$queryRaw.mockResolvedValue([])
})

describe('renglón por peso con la cuenta de las apps', () => {
  it('0.300 kg a $100.05 ⇒ $30.02 (antes el SERVIDOR guardaba $30.01)', async () => {
    prismaMock.product.findMany.mockResolvedValue([queso(100.05)])
    await crear([pesada(0.3)])
    expect(Number(lineasCreadas()[0].total)).toBe(30.02)
  })

  it('0.570 kg a $100.50 ⇒ $57.28, como las apps (antes $57.29)', async () => {
    prismaMock.product.findMany.mockResolvedValue([queso(100.5)])
    await crear([pesada(0.57)])
    expect(Number(lineasCreadas()[0].total)).toBe(57.28)
  })

  it('tres pesadas de 0.102 kg a $182.50 ⇒ $55.83, lo que cobran las apps viejas (la cuenta «exacta» daba $55.86)', async () => {
    prismaMock.product.findMany.mockResolvedValue([queso(182.5)])
    await crear([pesada(0.102, { externalId: 'a' }), pesada(0.102, { externalId: 'b' }), pesada(0.102, { externalId: 'c' })])
    expect(lineasCreadas().map(l => Number(l.total))).toEqual([18.61, 18.61, 18.61])
    expect(Number(datosDeLaOrden().total)).toBe(55.83)
  })

  it('iOS 1.15.0–1.15.1 (precio por kilo truncado): se queda con la cuenta vieja, como hoy ⇒ $30.01', async () => {
    prismaMock.product.findMany.mockResolvedValue([queso(100.05)])
    await runWithContext(
      {
        correlationId: 'c',
        source: 'http',
        entrypoint: 'POST /api/v1/mobile/venues/:id/orders',
        cliente: { plataforma: 'IOS', version: '1.15.1' },
      },
      () => crear([pesada(0.3)]),
    )
    expect(Number(lineasCreadas()[0].total)).toBe(30.01)
  })

  it('iOS 1.15.2 en adelante: la cuenta de las apps ⇒ $30.02', async () => {
    prismaMock.product.findMany.mockResolvedValue([queso(100.05)])
    await runWithContext(
      {
        correlationId: 'c',
        source: 'http',
        entrypoint: 'POST /api/v1/mobile/venues/:id/orders',
        cliente: { plataforma: 'IOS', version: '1.15.2' },
      },
      () => crear([pesada(0.3)]),
    )
    expect(Number(lineasCreadas()[0].total)).toBe(30.02)
  })

  it('con descuento de catálogo 10 %: pega sobre $30.02 ⇒ descuento 3.00, neto 27.02 (las apps igual)', async () => {
    prismaMock.product.findMany.mockResolvedValue([queso(100.05)])
    prismaMock.discount.findMany.mockResolvedValue([
      { id: 'disc-10', venueId: 'venue-1', name: '10%', type: 'PERCENTAGE', value: new Decimal(10), active: true },
    ])
    await crear([pesada(0.3, { discountId: 'disc-10' })])
    expect(Number(lineasCreadas()[0].total)).toBe(30.02)
    expect(Number(lineasCreadas()[0].discountAmount)).toBe(3)
    expect(Number(datosDeLaOrden().total)).toBe(27.02)
  })

  it('con «Ajuste de precio» por kilo (D12): el renglón bruto es $30.02 y el descuento lleva la diferencia hasta lo ajustado', async () => {
    prismaMock.product.findMany.mockResolvedValue([queso(100.05)])
    // 0.300 kg ajustado a 9000 ¢/kg ⇒ round(0.3 × 9000) = 2700 ¢; descuento = 30.02 − 27.00 = 3.02.
    await crear([pesada(0.3, { externalId: 'e1', adjustedUnitPrice: 9000 })])
    expect(Number(lineasCreadas()[0].total)).toBe(30.02)
    expect(Number(lineasCreadas()[0].discountAmount)).toBe(3.02)
    expect(Number(datosDeLaOrden().total)).toBe(27)
  })
})

/**
 * 🔴 DINERO — «el centavo» (30-oct): el SERVIDOR calcula el descuento de catálogo de cada renglón
 * en CENTAVOS ENTEROS, redondeando como ANDROID e iOS (`descuentoDeLineaCents`). En pesos
 * flotantes difería un centavo: $21.35 al 10 % daba $2.13 (las apps $2.14); con tres renglones así una venta sin red quedaba
 * PARCIAL. El renglón POR PESO queda aparte (parte 2): ahí las apps tampoco hacen la cuenta decimal exacta (0.570 kg × $100.50). Misma base de pruebas que la de D12 (`order.mobile.ajusteDePrecio`).
 */
jest.mock('@/services/venueSalesGuard', () => ({
  __esModule: true,
  assertVenueSalesEnabled: jest.fn(),
}))
jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { getBroadcastingService: jest.fn(() => null) },
}))
// La cortesía sincroniza repartos con consultas propias de la transacción: aquí sólo importa que no escriba el ajuste.
jest.mock('@/services/shared/repartoDescuentoTx', () => ({
  ...jest.requireActual('@/services/shared/repartoDescuentoTx'),
  sincronizarRepartos: jest.fn(),
}))

import { Decimal } from '@prisma/client/runtime/library'
import { buildOrderItemsData, createOrderWithItems, type CreateOrderInput } from '@/services/mobile/order.mobile.service'
import { filaDeAjustesDePrecio } from '@/services/shared/discount.service'
import { prismaMock } from '../../../__helpers__/setup'

const HORA = 3_600_000
const CAT = new Date(Date.now() - 3 * HORA).toISOString()
const CUID_V1 = /^c[a-z0-9]{24}$/

function playera(extra: Record<string, unknown> = {}) {
  return { id: 'prod-1', name: 'Playera', price: new Decimal(100), sku: 'PLY-1', categoryId: 'cat-1', category: { name: 'Ropa' }, ...extra }
}

/** La orden que «guarda» la base: lo que se mandó a crear, con ids (el `id` de un renglón ajustado viaja en los datos). */
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
    items: data.items.create.map((it: any, k: number) => ({
      id: `oi-${k}`,
      ...it,
      modifiers: (it.modifiers?.create ?? []).map((m: any, j: number) => ({
        id: `oim-${k}-${j}`,
        ...m,
        modifier: { id: m.modifierId, name: m.name, price: new Decimal(15) },
      })),
    })),
    promotions: [],
  }
}

const datosDeLaOrden = () => (prismaMock.order.create as jest.Mock).mock.calls[0][0].data
const lineasCreadas = () =>
  datosDeLaOrden().items.create as Array<{ id?: string; unitPrice: Decimal; total: Decimal; discountAmount: Decimal }>
const filasDeDescuento = () => (prismaMock.orderDiscount.create as jest.Mock).mock.calls.map(c => c[0].data)
const filasDeAjuste = () => filasDeDescuento().filter(f => f.name === 'Ajuste de precio')
/** Lo que el cliente paga por el renglón (bruto menos todo su descuento), en pesos. */
const netoDelRenglon = (k = 0) => Number(lineasCreadas()[k].total) - Number(lineasCreadas()[k].discountAmount)

function crear(extra: Partial<CreateOrderInput>) {
  return createOrderWithItems('venue-1', { staffId: 'staff-1', source: 'AVOQADO_ANDROID', items: [], ...extra } as CreateOrderInput)
}

const descuento = (extra: Record<string, unknown> = {}) => ({
  id: 'disc-10',
  venueId: 'venue-1',
  name: '10%',
  type: 'PERCENTAGE',
  value: new Decimal(10),
  active: true,
  ...extra,
})

beforeEach(() => {
  jest.clearAllMocks()
  prismaMock.orderAction = { create: jest.fn() }
  prismaMock.$transaction.mockImplementation(async (callback: any) => callback(prismaMock))
  prismaMock.staff.findUnique.mockResolvedValue({ id: 'staff-1', venueId: 'venue-1' })
  prismaMock.staffVenue.findFirst.mockResolvedValue({ id: 'sv-1', staffId: 'staff-1', venueId: 'venue-1', active: true })
  prismaMock.product.findMany.mockResolvedValue([playera()])
  prismaMock.modifier.findMany.mockResolvedValue([])
  prismaMock.discount.findMany.mockResolvedValue([])
  prismaMock.order.findUnique.mockResolvedValue(null)
  prismaMock.order.create.mockImplementation(async (args: any) => ordenDesdeLosDatos(args))
  prismaMock.activityLog.create.mockResolvedValue({ id: 'log-1' })
  prismaMock.$queryRaw.mockResolvedValue([])
})


describe('el centavo: renglón y descuento en centavos enteros, como las apps', () => {
  it('🔴 $21.35 al 10 % → descuento $2.14 (como las apps), no $2.13', async () => {
    prismaMock.product.findMany.mockResolvedValue([playera({ price: new Decimal(21.35) })])
    prismaMock.discount.findMany.mockResolvedValue([descuento()])
    await crear({ items: [{ productId: 'prod-1', quantity: 1, discountId: 'disc-10', externalId: 'e1' }] })
    expect(Number(lineasCreadas()[0].discountAmount)).toBe(2.14)
    expect(netoDelRenglon()).toBeCloseTo(19.21, 6)
  })

  it('$21.35 × 3 al 10 % → descuento $6.41 (ya coincidía; regresión) (6405 ¢ × 10 % = 640.5 → 641)', async () => {
    prismaMock.product.findMany.mockResolvedValue([playera({ price: new Decimal(21.35) })])
    prismaMock.discount.findMany.mockResolvedValue([descuento()])
    await crear({ items: [{ productId: 'prod-1', quantity: 3, discountId: 'disc-10', externalId: 'e1' }] })
    expect(Number(lineasCreadas()[0].discountAmount)).toBe(6.41)
  })

  it('🔴 tres renglones de $21.35 al 10 %: el descuento de la venta suma $6.42 y la venta vale $57.63', async () => {
    prismaMock.product.findMany.mockResolvedValue([playera({ price: new Decimal(21.35) })])
    prismaMock.discount.findMany.mockResolvedValue([descuento()])
    await crear({
      items: ['e1', 'e2', 'e3'].map(e => ({ productId: 'prod-1', quantity: 1, discountId: 'disc-10', externalId: e })),
    })
    expect(Number(datosDeLaOrden().discountAmount)).toBeCloseTo(6.42, 6)
    expect(Number(datosDeLaOrden().subtotal) - Number(datosDeLaOrden().discountAmount)).toBeCloseTo(57.63, 6)
  })

  it('$100 al 10 % sigue en $10 y un fijo de $5 en $5 (regresión)', async () => {
    prismaMock.discount.findMany.mockResolvedValue([descuento(), descuento({ id: 'disc-5', name: '$5', type: 'FIXED_AMOUNT', value: new Decimal(5) })])
    await crear({
      items: [
        { productId: 'prod-1', quantity: 1, discountId: 'disc-10', externalId: 'e1' },
        { productId: 'prod-1', quantity: 1, discountId: 'disc-5', externalId: 'e2' },
      ],
    })
    expect(Number(lineasCreadas()[0].discountAmount)).toBe(10)
    expect(Number(lineasCreadas()[1].discountAmount)).toBe(5)
  })

  it('🔴 el mínimo de compra se sigue exigiendo con el cálculo en centavos (Codex plan r2 #3)', async () => {
    prismaMock.discount.findMany.mockResolvedValue([descuento({ minPurchaseAmount: new Decimal(150) })])
    await expect(crear({ items: [{ productId: 'prod-1', quantity: 1, discountId: 'disc-10', externalId: 'e1' }] })).rejects.toThrow(
      /minimum purchase/i,
    )
  })

  it('el tope del catálogo se sigue respetando (regresión D13): 50 % máx $10 sobre $100 → $10', async () => {
    prismaMock.discount.findMany.mockResolvedValue([descuento({ value: new Decimal(50), maxDiscountAmount: new Decimal(10) })])
    await crear({ items: [{ productId: 'prod-1', quantity: 1, discountId: 'disc-10', externalId: 'e1' }] })
    expect(Number(lineasCreadas()[0].discountAmount)).toBe(10)
  })

  it('🔴 renglón libre de $21.35 con 10 % → descuento $2.14', async () => {
    prismaMock.discount.findMany.mockResolvedValue([descuento()])
    await crear({ items: [{ name: 'Otro importe', quantity: 1, unitPrice: 2135, discountId: 'disc-10', externalId: 'e1' } as any] })
    expect(Number(lineasCreadas()[0].discountAmount)).toBe(2.14)
  })
})

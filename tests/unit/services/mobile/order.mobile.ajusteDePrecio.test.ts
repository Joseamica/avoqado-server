/**
 * 🔴 DINERO — «Ajuste de precio» de las apps como descuento del renglón (D12).
 *
 * El cajero baja a mano el precio de un producto: la app manda `adjustedUnitPrice` (centavos por unidad, por kg en venta por
 * peso, SIN extras). El SERVIDOR lo guarda como descuento del renglón: `unitPrice` y `total` quedan en el precio decidido,
 * `discountAmount` lleva la diferencia y una fila `OrderDiscount` «Ajuste de precio» (espejo) la explica. Nunca un 400 por
 * este campo: lo que no sirve se ignora y la venta se cobra como hoy.
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

describe('«Ajuste de precio» como descuento (D12)', () => {
  it('$100 → $80, cantidad 1: el renglón conserva el precio, el descuento lleva la diferencia y una fila lo explica', async () => {
    await crear({ items: [{ productId: 'prod-1', quantity: 1, externalId: 'e1', adjustedUnitPrice: 8000 }] })

    const [renglon] = lineasCreadas()
    expect(Number(renglon.unitPrice)).toBe(100)
    expect(Number(renglon.discountAmount)).toBe(20)
    expect(Number(renglon.total)).toBe(100)
    expect(renglon.id).toMatch(CUID_V1)
    expect(Number(datosDeLaOrden().discountAmount)).toBe(20)
    expect(Number(datosDeLaOrden().total)).toBe(80)

    expect(filasDeDescuento()).toHaveLength(1)
    const fila = filasDeAjuste()[0]
    expect(fila).toMatchObject({
      orderId: 'order-1',
      name: 'Ajuste de precio',
      type: 'FIXED_AMOUNT',
      discountId: null,
      isManual: true,
      isComp: false,
      appliedById: 'sv-1',
      appliedToItemIds: [renglon.id],
    })
    expect(Number(fila.amount)).toBe(20)
    expect(fila.reparto).toMatchObject({ alcance: 'DIRIGIDO', espejo: true, renglones: { [renglon.id!]: 2000 } })
  })

  it('cantidad 3: el descuento es ×3', async () => {
    await crear({ items: [{ productId: 'prod-1', quantity: 3, externalId: 'e1', adjustedUnitPrice: 8000 }] })

    expect(Number(lineasCreadas()[0].discountAmount)).toBe(60)
    expect(Number(lineasCreadas()[0].total)).toBe(300)
    expect(Number(datosDeLaOrden().total)).toBe(240)
    expect(Number(filasDeAjuste()[0].amount)).toBe(60)
  })

  it('por peso: 0.5 kg a $200/kg ajustado a $150/kg ⇒ descuento 25 (100 − 75)', async () => {
    prismaMock.product.findMany.mockResolvedValue([playera({ price: new Decimal(200), soldByWeight: true })])

    await crear({ items: [{ productId: 'prod-1', quantity: 1, weightQuantity: 0.5, externalId: 'e1', adjustedUnitPrice: 15000 }] })

    expect(Number(lineasCreadas()[0].total)).toBe(100)
    expect(Number(lineasCreadas()[0].discountAmount)).toBe(25)
    expect(Number(datosDeLaOrden().total)).toBe(75)
  })

  it('por peso al centavo: 0.300 kg a $200/kg ajustado a 10005 centavos ⇒ el renglón queda en 30.02, no en 30.01', async () => {
    prismaMock.product.findMany.mockResolvedValue([playera({ price: new Decimal(200), soldByWeight: true })])

    await crear({ items: [{ productId: 'prod-1', quantity: 1, weightQuantity: 0.3, externalId: 'e1', adjustedUnitPrice: 10005 }] })

    expect(netoDelRenglon()).toBeCloseTo(30.02, 2)
    expect(Number(lineasCreadas()[0].discountAmount)).toBeCloseTo(29.98, 2)
  })

  it('catálogo 10 % con compra mínima $90 y ajuste a $80: no hay 400 (el mínimo se juzga sobre $100) y el % pega sobre $80', async () => {
    prismaMock.discount.findMany.mockResolvedValue([descuento({ minPurchaseAmount: new Decimal(90) })])

    await crear({ items: [{ productId: 'prod-1', quantity: 1, discountId: 'disc-10', externalId: 'e1', adjustedUnitPrice: 8000 }] })

    expect(Number(lineasCreadas()[0].discountAmount)).toBe(28)
    expect(Number(datosDeLaOrden().total)).toBe(72)
  })

  it('la compra mínima de catálogo se sigue exigiendo contra la línea SIN ajuste (no se afloja)', async () => {
    prismaMock.discount.findMany.mockResolvedValue([descuento({ minPurchaseAmount: new Decimal(150) })])

    await expect(
      crear({ items: [{ productId: 'prod-1', quantity: 1, discountId: 'disc-10', externalId: 'e1', adjustedUnitPrice: 8000 }] }),
    ).rejects.toMatchObject({ statusCode: 400 })
  })

  it('ajuste a 8029 centavos con catálogo 50 %: el catálogo se calcula desde centavos enteros (40.15) y el renglón queda en 40.14', async () => {
    prismaMock.discount.findMany.mockResolvedValue([descuento({ id: 'disc-50', name: '50%', value: new Decimal(50) })])

    await crear({ items: [{ productId: 'prod-1', quantity: 1, discountId: 'disc-50', externalId: 'e1', adjustedUnitPrice: 8029 }] })

    expect(netoDelRenglon()).toBeCloseTo(40.14, 2)
    const [catalogo] = filasDeDescuento().filter(f => f.name === '50%')
    expect(Number(catalogo.amount)).toBe(40.15)
    expect(Number(filasDeAjuste()[0].amount)).toBe(19.71)
  })

  it('lo mismo con un extra de $15 (base 95.29 ⇒ catálogo 47.65, neto 47.64)', async () => {
    prismaMock.discount.findMany.mockResolvedValue([descuento({ id: 'disc-50', name: '50%', value: new Decimal(50) })])
    prismaMock.modifier.findMany.mockResolvedValue([{ id: 'mod-1', name: 'Estampado', price: new Decimal(15), sku: null }])

    await crear({
      items: [
        { productId: 'prod-1', quantity: 1, modifierIds: ['mod-1'], discountId: 'disc-50', externalId: 'e1', adjustedUnitPrice: 8029 },
      ],
    })

    expect(netoDelRenglon()).toBeCloseTo(47.64, 2)
    const [catalogo] = filasDeDescuento().filter(f => f.name === '50%')
    expect(Number(catalogo.amount)).toBe(47.65)
  })

  // El descuento de catálogo de una línea ajustada se calcula en centavos enteros, como `descuentoDeLineaCents` de las apps
  // (`Math.round(baseCents × % / 100)`): en pesos flotantes 21.35 × 10 % daba 2.13 y las apps 2.14.
  it('ajuste a 2135 centavos con catálogo 10 %: la parte del catálogo es 2.14 (como las apps) y el renglón queda en 19.21', async () => {
    prismaMock.discount.findMany.mockResolvedValue([descuento()])

    await crear({ items: [{ productId: 'prod-1', quantity: 1, discountId: 'disc-10', externalId: 'e1', adjustedUnitPrice: 2135 }] })

    const [catalogo] = filasDeDescuento().filter(f => f.name === '10%')
    expect(Number(catalogo.amount)).toBe(2.14)
    expect(Number(filasDeAjuste()[0].amount)).toBe(78.65)
    expect(Number(lineasCreadas()[0].discountAmount)).toBeCloseTo(78.65 + 2.14, 2)
    expect(netoDelRenglon()).toBeCloseTo(19.21, 2)
  })

  it('ajuste a 2015 centavos con catálogo 50 %: la parte del catálogo es 10.08 (como las apps)', async () => {
    prismaMock.discount.findMany.mockResolvedValue([descuento({ id: 'disc-50', name: '50%', value: new Decimal(50) })])

    await crear({ items: [{ productId: 'prod-1', quantity: 1, discountId: 'disc-50', externalId: 'e1', adjustedUnitPrice: 2015 }] })

    const [catalogo] = filasDeDescuento().filter(f => f.name === '50%')
    expect(Number(catalogo.amount)).toBe(10.08)
    expect(netoDelRenglon()).toBeCloseTo(10.07, 2)
  })

  it('línea ajustada con catálogo 50 % y tope maxDiscountAmount 10: la parte del catálogo se topa en 10', async () => {
    prismaMock.discount.findMany.mockResolvedValue([
      descuento({ id: 'disc-50', name: '50%', value: new Decimal(50), maxDiscountAmount: new Decimal(10) }),
    ])

    await crear({ items: [{ productId: 'prod-1', quantity: 1, discountId: 'disc-50', externalId: 'e1', adjustedUnitPrice: 8000 }] })

    const [catalogo] = filasDeDescuento().filter(f => f.name === '50%')
    expect(Number(catalogo.amount)).toBe(10)
    expect(Number(filasDeAjuste()[0].amount)).toBe(20)
    expect(Number(lineasCreadas()[0].discountAmount)).toBe(30)
  })

  it('ajuste honrado cuyo descuento manual redondea a 0 (por peso): el catálogo igual va en centavos enteros y no hay fila de ajuste', async () => {
    // $100.14/kg, 0.350 kg ⇒ línea 35.05; ajustada a 10013 ¢/kg ⇒ round(0.350 × 10013) = 3505 ¢ ⇒ el ajuste vale 0.
    // En pesos flotantes 35.05 × 50 % daba 17.52 y las apps (Math.round(3505 × 50 / 100) = 1753) 17.53.
    prismaMock.product.findMany.mockResolvedValue([playera({ price: new Decimal(100.14), soldByWeight: true })])
    prismaMock.discount.findMany.mockResolvedValue([descuento({ id: 'disc-50', name: '50%', value: new Decimal(50) })])

    await crear({
      items: [
        { productId: 'prod-1', quantity: 1, weightQuantity: 0.35, discountId: 'disc-50', externalId: 'e1', adjustedUnitPrice: 10013 },
      ],
    })

    const [catalogo] = filasDeDescuento().filter(f => f.name === '50%')
    expect(Number(catalogo.amount)).toBe(17.53)
    expect(netoDelRenglon()).toBeCloseTo(17.52, 2)
    expect(filasDeAjuste()).toEqual([])
    expect(lineasCreadas()[0].id).toBeUndefined()
  })

  it('con un extra de $15: el ajuste pega al producto, el extra se cobra entero', async () => {
    prismaMock.modifier.findMany.mockResolvedValue([{ id: 'mod-1', name: 'Estampado', price: new Decimal(15), sku: null }])

    await crear({ items: [{ productId: 'prod-1', quantity: 1, modifierIds: ['mod-1'], externalId: 'e1', adjustedUnitPrice: 8000 }] })

    expect(Number(lineasCreadas()[0].discountAmount)).toBe(20)
    expect(Number(lineasCreadas()[0].total)).toBe(115)
    expect(Number(datosDeLaOrden().total)).toBe(95)
  })

  it('con descuento de catálogo 10 % en la misma línea: el % pega sobre lo ajustado y la fila del catálogo NO repite el ajuste', async () => {
    prismaMock.discount.findMany.mockResolvedValue([descuento()])

    await crear({ items: [{ productId: 'prod-1', quantity: 1, discountId: 'disc-10', externalId: 'e1', adjustedUnitPrice: 8000 }] })

    expect(Number(lineasCreadas()[0].discountAmount)).toBe(28)
    expect(Number(datosDeLaOrden().discountAmount)).toBe(28)
    expect(Number(datosDeLaOrden().total)).toBe(72)
    const [catalogo] = filasDeDescuento().filter(f => f.name === '10%')
    expect(Number(catalogo.amount)).toBe(8)
    expect(Number(filasDeAjuste()[0].amount)).toBe(20)
    // Σ de las filas = el descuento del renglón: nada se cuenta dos veces ni se pierde.
    expect(filasDeDescuento().reduce((s, f) => s + Number(f.amount), 0)).toBe(28)
  })

  it.each([
    ['igual al precio', 10000],
    ['mayor al precio', 12000],
  ])('ajuste %s: se ignora (sin descuento ni fila)', async (_, ajuste) => {
    await crear({ items: [{ productId: 'prod-1', quantity: 1, externalId: 'e1', adjustedUnitPrice: ajuste }] })

    expect(Number(lineasCreadas()[0].discountAmount)).toBe(0)
    expect(Number(datosDeLaOrden().total)).toBe(100)
    expect(filasDeAjuste()).toEqual([])
    expect(lineasCreadas()[0].id).toBeUndefined()
  })

  it('cortesía con adjustedUnitPrice: queda como cortesía (descuento = total) y sin fila «Ajuste de precio»', async () => {
    await crear({
      canCompItems: true,
      performedBy: 'staff-1',
      items: [{ productId: 'prod-1', quantity: 1, externalId: 'e1', isCortesia: true, cortesiaReason: 'Prueba', adjustedUnitPrice: 8000 }],
    })

    expect(Number(lineasCreadas()[0].discountAmount)).toBe(100)
    expect(Number(lineasCreadas()[0].total)).toBe(100)
    expect(Number(datosDeLaOrden().total)).toBe(0)
    expect(filasDeAjuste()).toEqual([])
  })

  it.each([
    ['negativo', -5],
    ['con decimales', 1.5],
    ['texto', '80'],
    ['pasado de 32 bits', 2_147_483_648],
    ['nulo', null],
  ])('basura (%s): se ignora, sin descuento y sin 400', async (_, basura) => {
    await crear({ items: [{ productId: 'prod-1', quantity: 1, externalId: 'e1', adjustedUnitPrice: basura as any }] })

    expect(Number(lineasCreadas()[0].discountAmount)).toBe(0)
    expect(Number(datosDeLaOrden().total)).toBe(100)
    expect(filasDeAjuste()).toEqual([])
  })

  it('ajuste de 0 centavos: se ignora como basura (sin descuento y sin fila)', async () => {
    await crear({ items: [{ productId: 'prod-1', quantity: 1, externalId: 'e1', adjustedUnitPrice: 0 }] })

    expect(Number(lineasCreadas()[0].discountAmount)).toBe(0)
    expect(Number(datosDeLaOrden().total)).toBe(100)
    expect(filasDeAjuste()).toEqual([])
  })

  it('con un descuento libre de la CUENTA (centavos): se aplica sobre lo que queda tras el ajuste', async () => {
    await crear({ discount: 1000, items: [{ productId: 'prod-1', quantity: 1, externalId: 'e1', adjustedUnitPrice: 8000 }] })

    expect(Number(lineasCreadas()[0].discountAmount)).toBe(20)
    expect(Number(datosDeLaOrden().discountAmount)).toBe(30)
    expect(Number(datosDeLaOrden().total)).toBe(70)
    expect(filasDeDescuento().map(f => [f.name, Number(f.amount)])).toEqual([
      ['Ajuste de precio', 20],
      ['Descuento de la cuenta', 10],
    ])
  })

  it('el descuento libre de la CUENTA nunca pasa de lo que queda tras el ajuste (9000 ¢ sobre $80 ⇒ $80, total 0)', async () => {
    await crear({ discount: 9000, items: [{ productId: 'prod-1', quantity: 1, externalId: 'e1', adjustedUnitPrice: 8000 }] })

    expect(Number(datosDeLaOrden().discountAmount)).toBe(100)
    expect(Number(datosDeLaOrden().total)).toBe(0)
    expect(filasDeDescuento().map(f => [f.name, Number(f.amount)])).toEqual([
      ['Ajuste de precio', 20],
      ['Descuento de la cuenta', 80],
    ])
  })

  it('«Otro importe» (sin productId) con adjustedUnitPrice: se ignora y cobra su unitPrice', async () => {
    await crear({ items: [{ name: 'Otro importe', unitPrice: 5000, quantity: 1, externalId: 'e1', adjustedUnitPrice: 3000 }] })

    expect(Number(lineasCreadas()[0].unitPrice)).toBe(50)
    expect(Number(lineasCreadas()[0].discountAmount)).toBe(0)
    expect(Number(datosDeLaOrden().total)).toBe(50)
    expect(filasDeAjuste()).toEqual([])
  })

  it('precio que vio el cliente respetado: catálogo hoy 120, vio 100, ajusta a 80 ⇒ unitPrice 100 y descuento 20', async () => {
    prismaMock.product.findMany.mockResolvedValue([playera({ price: new Decimal(120) })])
    prismaMock.$queryRaw.mockResolvedValue([{ i: 0 }])

    await crear({
      items: [{ productId: 'prod-1', quantity: 1, externalId: 'e1', displayedUnitPrice: 10000, catalogAt: CAT, adjustedUnitPrice: 8000 }],
    })

    expect(Number(lineasCreadas()[0].unitPrice)).toBe(100)
    expect(Number(lineasCreadas()[0].discountAmount)).toBe(20)
    expect(Number(datosDeLaOrden().total)).toBe(80)
  })

  it('el catálogo bajó por debajo del ajuste (hoy 70, ajuste 80): el ajuste no baja nada y se ignora', async () => {
    prismaMock.product.findMany.mockResolvedValue([playera({ price: new Decimal(70) })])

    await crear({ items: [{ productId: 'prod-1', quantity: 1, externalId: 'e1', adjustedUnitPrice: 8000 }] })

    expect(Number(lineasCreadas()[0].unitPrice)).toBe(70)
    expect(Number(lineasCreadas()[0].discountAmount)).toBe(0)
    expect(filasDeAjuste()).toEqual([])
  })

  it('desde la cola (isOfflineReplay): el mismo resultado que en línea, una sola fila', async () => {
    await crear({ isOfflineReplay: true, items: [{ productId: 'prod-1', quantity: 1, externalId: 'e1', adjustedUnitPrice: 8000 }] })

    expect(Number(lineasCreadas()[0].discountAmount)).toBe(20)
    expect(Number(datosDeLaOrden().total)).toBe(80)
    expect(filasDeAjuste()).toHaveLength(1)
    expect(Number(filasDeAjuste()[0].amount)).toBe(20)
  })

  it('dos renglones ajustados: UNA sola fila con los dos, y cada renglón lleva su descuento', async () => {
    await crear({
      items: [
        { productId: 'prod-1', quantity: 1, externalId: 'e1', adjustedUnitPrice: 8000 },
        { productId: 'prod-1', quantity: 2, externalId: 'e2', adjustedUnitPrice: 9000 },
        { productId: 'prod-1', quantity: 1, externalId: 'e3' },
      ],
    })

    const lineas = lineasCreadas()
    expect(lineas.map(l => Number(l.discountAmount))).toEqual([20, 20, 0])
    expect(lineas[2].id).toBeUndefined()
    expect(filasDeAjuste()).toHaveLength(1)
    const fila = filasDeAjuste()[0]
    expect(fila.appliedToItemIds).toEqual([lineas[0].id, lineas[1].id])
    expect(Number(fila.amount)).toBe(40)
    expect(Number(datosDeLaOrden().total)).toBe(360)
  })

  it('sin activación (como la llaman los vales) adjustedUnitPrice se ignora', async () => {
    const r = await buildOrderItemsData('venue-1', [{ productId: 'prod-1', quantity: 1, externalId: 'e1', adjustedUnitPrice: 8000 }], null)

    expect(Number(r.itemsData[0].discountAmount)).toBe(0)
    expect(r.itemsData[0].id).toBeUndefined()
    expect(r.ajustesDePrecio).toEqual([])
  })
})

describe('filaDeAjustesDePrecio', () => {
  it('suma los renglones, los apunta y reparte espejo', () => {
    const fila = filaDeAjustesDePrecio({
      orderId: 'o1',
      renglones: [
        { itemId: 'i1', pesos: 20 },
        { itemId: 'i2', pesos: 10.5 },
      ],
      appliedById: null,
    })

    expect(fila).toMatchObject({
      orderId: 'o1',
      discountId: null,
      type: 'FIXED_AMOUNT',
      name: 'Ajuste de precio',
      isManual: true,
      isComp: false,
      appliedById: null,
      appliedToItemIds: ['i1', 'i2'],
    })
    expect(Number(fila.amount)).toBe(30.5)
    expect(fila.reparto).toMatchObject({ alcance: 'DIRIGIDO', espejo: true, renglones: { i1: 2000, i2: 1050 } })
  })
})

/**
 * 🔴 DINERO — «se cobra el precio que vio el cliente» en la creación de mostrador (Task 3).
 *
 * La tablet puede cobrar con una lista vieja. El cliente paga el MÁS BAJO entre el precio que vio (si fue real en las
 * 72 h anteriores a la venta) y el de hoy. La orden usa la regla y la búsqueda de `precioQueVioElCliente.ts`: precio por
 * línea, `priceChanges` en la respuesta, 409 `ORDER_PRICE_CHANGED` en línea cuando no se reconoce (nunca desde la cola) y
 * una fila `ORDER_PREVIOUS_PRICE_HONORED` en la misma transacción de la venta.
 */
jest.mock('@/services/venueSalesGuard', () => ({
  __esModule: true,
  assertVenueSalesEnabled: jest.fn(),
}))
jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { getBroadcastingService: jest.fn(() => null) },
}))

import { Prisma } from '@prisma/client'
import { Decimal } from '@prisma/client/runtime/library'
import logger from '@/config/logger'
import * as basePlan from '@/services/access/basePlan.service'
import * as tableOrderLock from '@/services/shared/tableOrderLock'
import { buildOrderItemsData, createOrderWithItems, type CreateOrderInput } from '@/services/mobile/order.mobile.service'
import { prismaMock } from '../../../__helpers__/setup'

const HORA = 3_600_000
const CAT = new Date(Date.now() - 3 * HORA).toISOString()
const HACE_4_DIAS = new Date(Date.now() - 96 * HORA).toISOString()

function cafe(extra: Record<string, unknown> = {}) {
  return { id: 'prod-1', name: 'Café', price: new Decimal(50), sku: 'CAFE-1', categoryId: 'cat-1', category: { name: 'Bebidas' }, ...extra }
}

/** La orden que «guarda» la base: lo que se mandó a crear, con ids. */
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
      // Guardado = el precio cobrado; `modifier` = el extra VIVO (hoy a 15), como lo trae `createdOrderInclude`.
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
const lineasCreadas = () => datosDeLaOrden().items.create as Array<{ unitPrice: Decimal; total: Decimal; discountAmount: Decimal }>
const rastro = () => (prismaMock.activityLog.create as jest.Mock).mock.calls.map(c => c[0].data)

function crear(extra: Partial<CreateOrderInput>) {
  return createOrderWithItems('venue-1', { staffId: 'staff-1', source: 'AVOQADO_ANDROID', items: [], ...extra } as CreateOrderInput)
}

beforeEach(() => {
  jest.clearAllMocks()
  prismaMock.$transaction.mockImplementation(async (callback: any) => callback(prismaMock))
  prismaMock.staff.findUnique.mockResolvedValue({ id: 'staff-1', venueId: 'venue-1' })
  prismaMock.staffVenue.findFirst.mockResolvedValue({ id: 'sv-1', staffId: 'staff-1', venueId: 'venue-1', active: true })
  prismaMock.product.findMany.mockResolvedValue([cafe()])
  prismaMock.modifier.findMany.mockResolvedValue([])
  prismaMock.discount.findMany.mockResolvedValue([])
  prismaMock.order.findUnique.mockResolvedValue(null)
  prismaMock.order.create.mockImplementation(async (args: any) => ordenDesdeLosDatos(args))
  prismaMock.activityLog.create.mockResolvedValue({ id: 'log-1' })
  // Sin respuesta preparada, el historial no reconoce nada.
  prismaMock.$queryRaw.mockResolvedValue([])
})

describe('precio que vio el cliente — creación de mostrador', () => {
  it('1. sin campos nuevos: no consulta el historial y cobra el precio de la base', async () => {
    const r = await crear({ items: [{ productId: 'prod-1', quantity: 1, externalId: 'e1' }] })

    expect(prismaMock.$queryRaw).not.toHaveBeenCalled()
    expect(Number(lineasCreadas()[0].unitPrice)).toBe(50)
    expect(r).not.toHaveProperty('priceChanges')
  })

  it('2. sin activación (como la llaman los vales) los campos se ignoran', async () => {
    const r = await buildOrderItemsData(
      'venue-1',
      [{ productId: 'prod-1', quantity: 1, displayedUnitPrice: 4500, catalogAt: HACE_4_DIAS, externalId: 'e1' }],
      null,
    )

    expect(Number(r.itemsData[0].unitPrice)).toBe(50)
    expect(r.cambiosDePrecio).toEqual([])
    expect(r.preciosRespetados).toEqual([])
    expect(prismaMock.$queryRaw).not.toHaveBeenCalled()
  })

  it('3. el dueño bajó (5500 → 50): cobra 50 y lo dice por línea', async () => {
    const r = await crear({ items: [{ productId: 'prod-1', quantity: 1, externalId: 'e1', displayedUnitPrice: 5500, catalogAt: CAT }] })

    expect(Number(lineasCreadas()[0].unitPrice)).toBe(50)
    expect(r.priceChanges).toEqual([
      { externalId: 'e1', productId: 'prod-1', productName: 'Café', catalogAt: CAT, displayedUnitPriceCents: 5500, unitPriceCents: 5000 },
    ])
    expect(prismaMock.activityLog.create).not.toHaveBeenCalled()
  })

  it('4. subió y se reconoce: cobra 45, subtotal y saldo, y deja el rastro en la transacción', async () => {
    prismaMock.$queryRaw.mockResolvedValue([{ i: 0 }])
    // La transacción con su PROPIO activityLog: si el rastro se escribiera con `prisma`, no caería aquí.
    const rastroEnTx = jest.fn().mockResolvedValue({ id: 'log-1' })
    prismaMock.$transaction.mockImplementation(async (callback: any) => callback({ ...prismaMock, activityLog: { create: rastroEnTx } }))

    const r = await crear({ items: [{ productId: 'prod-1', quantity: 2, externalId: 'e1', displayedUnitPrice: 4500, catalogAt: CAT }] })

    expect(Number(lineasCreadas()[0].unitPrice)).toBe(45)
    expect(Number(lineasCreadas()[0].total)).toBe(90)
    expect(Number(datosDeLaOrden().subtotal)).toBe(90)
    expect(Number(datosDeLaOrden().total)).toBe(90)
    expect(Number(datosDeLaOrden().remainingBalance)).toBe(90)
    expect(r).not.toHaveProperty('priceChanges')
    expect(prismaMock.activityLog.create).not.toHaveBeenCalled()
    expect(rastroEnTx).toHaveBeenCalledTimes(1)
    const fila = rastroEnTx.mock.calls[0][0].data
    expect(fila).toMatchObject({ action: 'ORDER_PREVIOUS_PRICE_HONORED', entity: 'Order', entityId: 'order-1', venueId: 'venue-1' })
    expect(fila.data).toMatchObject({ orderNumber: datosDeLaOrden().orderNumber, source: 'AVOQADO_ANDROID', enLaCola: false })
    expect(Math.abs(Date.parse(fila.data.horaDeLaVenta) - Date.now())).toBeLessThan(60_000)
    expect(fila.data.horaDeLaVenta).toBe(new Date(fila.data.horaDeLaVenta).toISOString())
    expect(fila.data.lineas).toEqual([
      {
        externalId: 'e1',
        productId: 'prod-1',
        producto: 'Café',
        cantidad: 2,
        pesoKg: null,
        precioRespetado: 45,
        precioActual: 50,
        horaDelCatalogo: CAT,
      },
    ])
  })

  it('4b. si el rastro no se puede escribir, la venta tampoco (no hay precio respetado sin rastro)', async () => {
    prismaMock.$queryRaw.mockResolvedValue([{ i: 0 }])
    prismaMock.activityLog.create.mockRejectedValue(new Error('activityLog caído'))

    await expect(
      crear({ items: [{ productId: 'prod-1', quantity: 1, externalId: 'e1', displayedUnitPrice: 4500, catalogAt: CAT }] }),
    ).rejects.toThrow('activityLog caído')
  })

  it('5. subió y no se reconoce en línea: 409 ORDER_PRICE_CHANGED y no se crea nada', async () => {
    await expect(
      crear({ items: [{ productId: 'prod-1', quantity: 1, externalId: 'e1', displayedUnitPrice: 4500, catalogAt: CAT }] }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'ORDER_PRICE_CHANGED',
      details: { priceChanges: [{ externalId: 'e1', displayedUnitPriceCents: 4500, unitPriceCents: 5000 }] },
    })
    expect(prismaMock.order.create).not.toHaveBeenCalled()
    expect(prismaMock.activityLog.create).not.toHaveBeenCalled()
  })

  it('5b. un catálogo de más de 72 h en línea tampoco se reconoce (sin consultar): 409', async () => {
    await expect(
      crear({ items: [{ productId: 'prod-1', quantity: 1, externalId: 'e1', displayedUnitPrice: 4500, catalogAt: HACE_4_DIAS }] }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'ORDER_PRICE_CHANGED' })
    expect(prismaMock.$queryRaw).not.toHaveBeenCalled()
    expect(prismaMock.order.create).not.toHaveBeenCalled()
  })

  it('6. el mismo caso desde la cola nunca es 409', async () => {
    const r = await crear({
      isOfflineReplay: true,
      items: [{ productId: 'prod-1', quantity: 1, externalId: 'e1', displayedUnitPrice: 4500, catalogAt: CAT }],
    })

    expect(Number(lineasCreadas()[0].unitPrice)).toBe(50)
    expect(r.priceChanges).toEqual([
      { externalId: 'e1', productId: 'prod-1', productName: 'Café', catalogAt: CAT, displayedUnitPriceCents: 4500, unitPriceCents: 5000 },
    ])
    expect(prismaMock.activityLog.create).not.toHaveBeenCalled()
  })

  it('7. cola: la ventana se cuenta hasta la hora de la venta', async () => {
    const venta = Date.now() - 10 * HORA
    const catalogo = new Date(Date.now() - 80 * HORA).toISOString()
    prismaMock.$queryRaw.mockResolvedValue([{ i: 0 }])

    const r = await crear({
      isOfflineReplay: true,
      createdAtLocal: venta,
      items: [{ productId: 'prod-1', quantity: 1, externalId: 'e1', displayedUnitPrice: 4500, catalogAt: catalogo }],
    })

    expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(1)
    const valores = (prismaMock.$queryRaw as jest.Mock).mock.calls[0][0].values
    expect(valores).toContain(new Date(venta).toISOString()) // hasta = la venta, no la llegada
    expect(valores).toContain(new Date(Date.parse(catalogo) - 60_000).toISOString()) // desde = catálogo − holgura
    expect(Number(lineasCreadas()[0].unitPrice)).toBe(45)
    expect(r).not.toHaveProperty('priceChanges')
    expect(rastro()[0].data).toMatchObject({ enLaCola: true, horaDeLaVenta: new Date(venta).toISOString() })
  })

  it('8. dos líneas del mismo producto: e1 a 45 respetado, e2 a 50 igual', async () => {
    prismaMock.$queryRaw.mockResolvedValue([{ i: 0 }])

    const r = await crear({
      items: [
        { productId: 'prod-1', quantity: 1, externalId: 'e1', displayedUnitPrice: 4500, catalogAt: CAT },
        { productId: 'prod-1', quantity: 1, externalId: 'e2', displayedUnitPrice: 5000, catalogAt: CAT },
      ],
    })

    expect(lineasCreadas().map(l => Number(l.unitPrice))).toEqual([45, 50])
    expect(r).not.toHaveProperty('priceChanges')
    expect(rastro()[0].data.lineas.map((l: any) => l.externalId)).toEqual(['e1'])
  })

  it('9. venta por peso: el mostrado es por kilo', async () => {
    prismaMock.product.findMany.mockResolvedValue([cafe({ soldByWeight: true })])
    prismaMock.$queryRaw.mockResolvedValue([{ i: 0 }])

    await crear({
      items: [{ productId: 'prod-1', quantity: 1, weightQuantity: 0.5, externalId: 'e1', displayedUnitPrice: 4500, catalogAt: CAT }],
    })

    expect(Number(lineasCreadas()[0].unitPrice)).toBe(45)
    expect(Number(lineasCreadas()[0].total)).toBe(22.5)
    expect(rastro()[0].data.lineas[0]).toMatchObject({ cantidad: 1, pesoKg: 0.5, precioRespetado: 45, precioActual: 50 })
  })

  it('9b. un descuento % de LÍNEA pega sobre el precio respetado', async () => {
    prismaMock.discount.findMany.mockResolvedValue([
      { id: 'disc-10', venueId: 'venue-1', name: '10%', type: 'PERCENTAGE', value: new Decimal(10), active: true },
    ])
    prismaMock.$queryRaw.mockResolvedValue([{ i: 0 }])

    await crear({
      items: [{ productId: 'prod-1', quantity: 1, discountId: 'disc-10', externalId: 'e1', displayedUnitPrice: 4500, catalogAt: CAT }],
    })

    expect(Number(lineasCreadas()[0].discountAmount)).toBe(4.5)
  })

  it('10. el descuento de CUENTA fijo se conserva', async () => {
    prismaMock.product.findMany.mockResolvedValue([cafe({ price: new Decimal(80) })])

    const r = await crear({
      discount: 1000,
      items: [{ productId: 'prod-1', quantity: 1, externalId: 'e1', displayedUnitPrice: 10000, catalogAt: CAT }],
    })

    expect(Number(datosDeLaOrden().discountAmount)).toBe(10)
    expect(Number(datosDeLaOrden().total)).toBe(70)
    expect(r.priceChanges).toEqual([expect.objectContaining({ externalId: 'e1', displayedUnitPriceCents: 10000, unitPriceCents: 8000 })])
  })

  it('11. respuesta perdida con dos precios del mismo producto y otro catálogo en el reintento', async () => {
    const linea = (id: string, externalId: string, precio: number) => ({
      id,
      externalId,
      productId: 'prod-1',
      productName: 'Café',
      quantity: 1,
      unitPrice: new Decimal(precio),
      total: new Decimal(precio),
      discountAmount: new Decimal(0),
      product: { id: 'prod-1', name: 'Café', price: new Decimal(50) },
      modifiers: [],
    })
    prismaMock.order.findUnique.mockResolvedValue({
      id: 'order-viejo',
      orderNumber: 'ORD-VIEJO',
      externalId: 'venta-1',
      status: 'CONFIRMED',
      paymentStatus: 'PENDING',
      subtotal: new Decimal(95),
      discountAmount: new Decimal(0),
      taxAmount: new Decimal(0),
      total: new Decimal(95),
      createdAt: new Date(),
      items: [linea('oi-1', 'e1', 45), linea('oi-2', 'e2', 50)],
      promotions: [],
    })

    const r = await crear({
      externalId: 'venta-1',
      items: [
        { productId: 'prod-1', quantity: 1, externalId: 'e1', displayedUnitPrice: 4500, catalogAt: 'C2' },
        { productId: 'prod-1', quantity: 1, externalId: 'e2', displayedUnitPrice: 5500, catalogAt: 'C2' },
      ],
    })

    expect(r.id).toBe('order-viejo')
    expect(r.priceChanges).toEqual([
      { externalId: 'e2', productId: 'prod-1', productName: 'Café', catalogAt: 'C2', displayedUnitPriceCents: 5500, unitPriceCents: 5000 },
    ])
    expect(prismaMock.order.create).not.toHaveBeenCalled()
    expect(prismaMock.order.update).not.toHaveBeenCalled()
    expect(prismaMock.orderItem.update).not.toHaveBeenCalled()
  })

  it('12. basura en la cola nunca truena', async () => {
    const r = await crear({
      isOfflineReplay: true,
      createdAtLocal: 'ayer' as any,
      items: [
        { productId: 'prod-1', quantity: 1, externalId: 'e1', displayedUnitPrice: -1, catalogAt: 'zzz' },
        { productId: 'prod-1', quantity: 1, externalId: 'e2', displayedUnitPrice: 'x' as any, catalogAt: 'zzz' },
      ],
    })

    expect(lineasCreadas().map(l => Number(l.unitPrice))).toEqual([50, 50])
    expect(Number(datosDeLaOrden().total)).toBe(100)
    expect(r).not.toHaveProperty('priceChanges')
    expect(prismaMock.$queryRaw).not.toHaveBeenCalled()
    expect(prismaMock.activityLog.create).not.toHaveBeenCalled()
  })
})

/**
 * Task S3 (cobrar sin red) — el precio que vio el cliente también en los EXTRAS. Cada extra de la línea se decide solo con
 * la misma regla (`clasificarLinea`) contra su historial (`ModifierPriceHistory`); `displayedModifierPrices` sólo cuenta si
 * la línea trae `catalogAt`. El precio decidido va al total de la línea y al `price` guardado del extra.
 */
describe('Task S3 — precio visto de los extras', () => {
  const avena = { id: 'mod-1', name: 'Leche de avena', price: new Decimal(15), sku: null }
  const extrasCreados = (k = 0) => (lineasCreadas()[k] as any).modifiers.create as Array<{ modifierId: string; price: Decimal }>
  const consultas = () => (prismaMock.$queryRaw as jest.Mock).mock.calls.map(c => c[0])
  const linea = (extra: Record<string, unknown> = {}) => ({
    productId: 'prod-1',
    quantity: 2,
    externalId: 'e1',
    modifierIds: ['mod-1'],
    displayedUnitPrice: 5000,
    catalogAt: CAT,
    ...extra,
  })

  beforeEach(() => prismaMock.modifier.findMany.mockResolvedValue([avena]))

  it('extra que SUBIÓ tras catalogAt y fue vigente ⇒ se cobra lo mostrado (total, extra guardado, respuesta y rastro)', async () => {
    prismaMock.$queryRaw.mockResolvedValue([{ i: 0 }])

    const r = await crear({ items: [linea({ displayedModifierPrices: { 'mod-1': 1000 } })] })

    // Sólo el extra se busca (el producto mostró lo de hoy), y en SU historial.
    expect(consultas()).toHaveLength(1)
    expect(consultas()[0].text).toContain('"ModifierPriceHistory"')
    expect(consultas()[0].values).toContain('mod-1')
    expect(Number(extrasCreados()[0].price)).toBe(10)
    expect(Number(lineasCreadas()[0].total)).toBe(120) // (50 + 10) × 2
    expect(Number(datosDeLaOrden().total)).toBe(120)
    expect(r).not.toHaveProperty('priceChanges')
    // La respuesta dice lo COBRADO, no el precio vivo del extra (15).
    expect(r.items[0].modifiers).toEqual([expect.objectContaining({ id: 'mod-1', price: 10 })])
    expect(rastro()[0].data.lineas).toEqual([
      {
        externalId: 'e1',
        productId: 'prod-1',
        producto: 'Café',
        modifierId: 'mod-1',
        extra: 'Leche de avena',
        cantidad: 2,
        pesoKg: null,
        precioRespetado: 10,
        precioActual: 15,
        horaDelCatalogo: CAT,
      },
    ])
  })

  it('producto y extra que subieron y se reconocen en la MISMA línea: los dos a lo mostrado, una consulta por historial', async () => {
    prismaMock.$queryRaw.mockResolvedValue([{ i: 0 }])

    await crear({ items: [linea({ displayedUnitPrice: 4500, displayedModifierPrices: { 'mod-1': 1000 } })] })

    expect(consultas().map(q => (q.text.includes('"ModifierPriceHistory"') ? 'extra' : 'producto'))).toEqual(['producto', 'extra'])
    expect(Number(lineasCreadas()[0].unitPrice)).toBe(45)
    expect(Number(extrasCreados()[0].price)).toBe(10)
    expect(Number(lineasCreadas()[0].total)).toBe(110) // (45 + 10) × 2
    expect(rastro()[0].data.lineas.map((l: any) => [l.modifierId ?? null, l.precioRespetado])).toEqual([
      [null, 45],
      ['mod-1', 10],
    ])
  })

  it('extra que BAJÓ ⇒ se cobra el vigente y se avisa con su modifierId, sin consultar ni 409', async () => {
    const r = await crear({ items: [linea({ displayedModifierPrices: { 'mod-1': 2000 } })] })

    expect(prismaMock.$queryRaw).not.toHaveBeenCalled()
    expect(Number(extrasCreados()[0].price)).toBe(15)
    expect(r.priceChanges).toEqual([
      {
        externalId: 'e1',
        productId: 'prod-1',
        productName: 'Café',
        modifierId: 'mod-1',
        catalogAt: CAT,
        displayedUnitPriceCents: 2000,
        unitPriceCents: 1500,
      },
    ])
  })

  it('extra mostrado no reconocido con isOfflineReplay ⇒ el vigente + priceChanges con modifierId', async () => {
    const r = await crear({ isOfflineReplay: true, items: [linea({ displayedModifierPrices: { 'mod-1': 1000 } })] })

    expect(consultas()).toHaveLength(1)
    expect(Number(extrasCreados()[0].price)).toBe(15)
    expect(Number(lineasCreadas()[0].total)).toBe(130)
    expect(r.priceChanges).toEqual([
      expect.objectContaining({ externalId: 'e1', modifierId: 'mod-1', displayedUnitPriceCents: 1000, unitPriceCents: 1500 }),
    ])
    expect(prismaMock.activityLog.create).not.toHaveBeenCalled()
  })

  it('extra no reconocido en línea ⇒ 409 ORDER_PRICE_CHANGED y no se crea nada', async () => {
    await expect(crear({ items: [linea({ displayedModifierPrices: { 'mod-1': 1000 } })] })).rejects.toMatchObject({
      statusCode: 409,
      code: 'ORDER_PRICE_CHANGED',
      details: { priceChanges: [expect.objectContaining({ modifierId: 'mod-1', displayedUnitPriceCents: 1000, unitPriceCents: 1500 })] },
    })
    expect(prismaMock.order.create).not.toHaveBeenCalled()
  })

  it('sin displayedModifierPrices todo como hoy: el extra a su precio, sin consultar', async () => {
    const r = await crear({ items: [linea()] })

    expect(prismaMock.$queryRaw).not.toHaveBeenCalled()
    expect(Number(extrasCreados()[0].price)).toBe(15)
    expect(Number(lineasCreadas()[0].total)).toBe(130)
    expect(r).not.toHaveProperty('priceChanges')
  })

  it('displayedModifierPrices sin catalogAt en la línea no cuenta: ni consulta, ni aviso, ni 409', async () => {
    const r = await crear({
      items: [{ productId: 'prod-1', quantity: 1, externalId: 'e1', modifierIds: ['mod-1'], displayedModifierPrices: { 'mod-1': 1000 } }],
    })

    expect(prismaMock.$queryRaw).not.toHaveBeenCalled()
    expect(Number(extrasCreados()[0].price)).toBe(15)
    expect(r).not.toHaveProperty('priceChanges')
  })

  it.each([
    ['un arreglo', [1000]],
    ['un texto', '{"mod-1":1000}'],
    ['un precio negativo', { 'mod-1': -1 }],
    ['un precio con decimales', { 'mod-1': 10.5 }],
  ])('displayedModifierPrices basura (%s) se ignora: como hoy, nunca truena', async (_, basura) => {
    const r = await crear({ items: [linea({ displayedModifierPrices: basura })] })

    expect(Number(extrasCreados()[0].price)).toBe(15)
    expect(r).not.toHaveProperty('priceChanges')
  })
})

/**
 * Task S3 — reloj del aparato (Review Focus 1; Codex plan-r2 #9). `catalogAt` lo selló el servidor; `createdAtLocal`, el
 * aparato. De la cola, la ventana de la línea es `[catalogAt − 60 s, min(llegada, max(horaDeLaVenta, catalogAt))]`.
 */
describe('Task S3 — ventana de la línea con el reloj del aparato', () => {
  const MIN = 60_000
  const valores = () => (prismaMock.$queryRaw as jest.Mock).mock.calls[0][0].values as unknown[]
  const cola = (createdAtLocal: number, catalogAt: string) =>
    crear({
      isOfflineReplay: true,
      createdAtLocal,
      items: [{ productId: 'prod-1', quantity: 1, externalId: 'e1', displayedUnitPrice: 4500, catalogAt }],
    })

  it('catalogAt del servidor y createdAtLocal con reloj +5 min ⇒ reconocido', async () => {
    prismaMock.$queryRaw.mockResolvedValue([{ i: 0 }])
    const catalogAt = new Date(Date.now() - 2 * MIN).toISOString()

    const r = await cola(Date.now() - MIN + 5 * MIN, catalogAt) // vendió hace 1 min con el reloj 5 min adelantado

    expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(1)
    expect(Number(lineasCreadas()[0].unitPrice)).toBe(45)
    expect(r).not.toHaveProperty('priceChanges')
  })

  // Codex servidor r1 #5: la hora capturada cae 4 min ANTES del catálogo (reloj mal) ⇒ no dice cuándo se vendió: hasta la LLEGADA.
  it('… con reloj ATRASADO 5 min (catálogo fresco) ⇒ reconocido, con la ventana hasta la llegada', async () => {
    prismaMock.$queryRaw.mockResolvedValue([{ i: 0 }])
    const catalogAt = new Date(Date.now() - 30 * MIN).toISOString()

    const antes = Date.now()
    const r = await cola(Date.parse(catalogAt) + MIN - 5 * MIN, catalogAt) // vendió 1 min después de leerlo, reloj −5 min
    const despues = Date.now()

    expect(valores()).toContain(new Date(Date.parse(catalogAt) - MIN).toISOString()) // desde = catálogo − holgura
    expect(valores()).not.toContain(catalogAt)
    const hasta = valores()
      .filter((v): v is string => typeof v === 'string' && /^\d{4}-\d\d-\d\dT/.test(v))
      .map(Date.parse)
    expect(hasta.some(t => t >= antes && t <= despues)).toBe(true) // hasta = la llegada
    expect(Number(lineasCreadas()[0].unitPrice)).toBe(45)
    expect(r).not.toHaveProperty('priceChanges')
  })

  it('🔴 catálogo de 96 h con el reloj del aparato ANTES del catálogo ⇒ no reconocido (sin consultar): el vigente y el aviso', async () => {
    const catalogAt = new Date(Date.now() - 96 * 60 * MIN).toISOString()

    const r = await cola(Date.parse(catalogAt) - 24 * 60 * MIN, catalogAt)

    expect(prismaMock.$queryRaw).not.toHaveBeenCalled()
    expect(Number(lineasCreadas()[0].unitPrice)).toBe(50)
    expect(r.priceChanges).toEqual([expect.objectContaining({ externalId: 'e1', displayedUnitPriceCents: 4500, unitPriceCents: 5000 })])
  })

  it('catalogAt posterior a la llegada ⇒ no reconocido (sin consultar): el vigente y el aviso', async () => {
    const catalogAt = new Date(Date.now() + 30_000).toISOString()

    const r = await cola(Date.now() - 10_000, catalogAt)

    expect(prismaMock.$queryRaw).not.toHaveBeenCalled()
    expect(Number(lineasCreadas()[0].unitPrice)).toBe(50)
    expect(r.priceChanges).toEqual([expect.objectContaining({ externalId: 'e1', displayedUnitPriceCents: 4500, unitPriceCents: 5000 })])
  })
})

/**
 * Task S3 (Codex plan-r4 R1) — cada renglón guarda su `externalId`, también la línea libre («Otro importe»), y la respuesta
 * lo devuelve por renglón: la terminal correlaciona su venta guardada con lo que quedó en el servidor.
 */
describe('Task S3 — externalId por renglón', () => {
  const cuerpo = {
    externalId: 'venta-s3',
    items: [
      { productId: 'prod-1', quantity: 1, externalId: 'e1' },
      { name: 'Otro importe', unitPrice: 1234, quantity: 1, externalId: 'e2' },
    ],
  }

  it('respuesta de crear (nueva y recuperada) trae externalId en cada renglón, incluida la línea libre', async () => {
    const nueva = await crear(cuerpo)

    expect(datosDeLaOrden().items.create.map((l: any) => l.externalId ?? null)).toEqual(['e1', 'e2'])
    expect(nueva.items.map(i => [i.productName, i.externalId])).toEqual([
      ['Café', 'e1'],
      ['Otro importe', 'e2'],
    ])

    // La respuesta se perdió: el reintento encuentra lo guardado.
    prismaMock.order.findUnique.mockResolvedValue(ordenDesdeLosDatos((prismaMock.order.create as jest.Mock).mock.calls[0][0]))
    const recuperada = await crear(cuerpo)

    expect(prismaMock.order.create).toHaveBeenCalledTimes(1)
    expect(recuperada.items.map(i => i.externalId)).toEqual(['e1', 'e2'])
  })

  it('una línea libre con externalId basura no lo guarda (como hoy) y no truena', async () => {
    const r = await crear({ items: [{ name: 'Otro importe', unitPrice: 100, quantity: 1, externalId: 42 as any }] })

    expect(datosDeLaOrden().items.create[0]).not.toHaveProperty('externalId')
    expect(r.items[0].externalId).toBeNull()
  })
})

/**
 * Task 4 — una venta, una orden. Con `externalId` la creación toma PRIMERO el candado de su llave, re-verifica con la
 * transacción y sólo entonces arma las líneas (y su posible 409) con esa misma transacción. Contra Postgres real:
 * `tests/integration/mobile/precioQueVioElCliente.orden.integration.test.ts`.
 */
describe('Task 4 — una venta, una orden', () => {
  const p2002 = (target: string[]) =>
    new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test', meta: { target } } as any)
  const ordenGuardada = () => ({
    id: 'order-ganadora',
    orderNumber: 'ORD-G',
    externalId: 'venta-K',
    status: 'CONFIRMED',
    paymentStatus: 'PENDING',
    subtotal: new Decimal(50),
    discountAmount: new Decimal(0),
    taxAmount: new Decimal(0),
    total: new Decimal(50),
    createdAt: new Date(),
    items: [
      {
        id: 'oi-1',
        externalId: 'e1',
        productId: 'prod-1',
        productName: 'Café',
        quantity: 1,
        unitPrice: new Decimal(50),
        total: new Decimal(50),
        discountAmount: new Decimal(0),
        product: { id: 'prod-1', name: 'Café', price: new Decimal(50) },
        modifiers: [],
      },
    ],
    promotions: [],
  })
  /** Una transacción con SUS propios clientes de lectura: lo que lea `prisma` en vez de `tx` no cae aquí. */
  function transaccionPropia(reverificada: unknown = null) {
    const tx = {
      ...prismaMock,
      $queryRaw: jest.fn().mockResolvedValue([]),
      order: { ...prismaMock.order, findUnique: jest.fn().mockResolvedValue(reverificada) },
      product: { findMany: jest.fn().mockResolvedValue([cafe()]) },
    }
    prismaMock.$transaction.mockImplementation(async (callback: any) => callback(tx))
    return tx
  }

  const espias: jest.SpyInstance[] = []
  afterEach(() => {
    espias.splice(0).forEach(e => e.mockRestore())
    ;(prismaMock.order.findUnique as jest.Mock).mockReset() // que ninguna respuesta preparada pase a la siguiente prueba
  })

  it('13. con externalId: el candado de SU llave va primero, re-verifica y arma las líneas con la transacción, y después la mesa', async () => {
    const tx = transaccionPropia()
    const mesa = jest.spyOn(tableOrderLock, 'lockTableOrderScope').mockResolvedValue({} as any)
    espias.push(mesa)

    await crear({ externalId: 'venta-K', tableId: 'mesa-1', items: [{ productId: 'prod-1', quantity: 1 }] })

    const candado = tx.$queryRaw.mock.calls[0][0]
    expect(candado.text).toMatch(/^SELECT pg_advisory_xact_lock\(hashtextextended\(\$1, 0\)\)::text$/)
    expect(candado.values).toEqual(['avoqado:order-mobile-external:v1:venue-1:venta-K'])
    expect(tx.order.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { venueId_externalId: { venueId: 'venue-1', externalId: 'venta-K' } } }),
    )
    expect(prismaMock.product.findMany).not.toHaveBeenCalled() // las líneas se arman con `tx`
    const orden = [
      tx.$queryRaw.mock.invocationCallOrder[0],
      tx.order.findUnique.mock.invocationCallOrder[0],
      tx.product.findMany.mock.invocationCallOrder[0],
      mesa.mock.invocationCallOrder[0],
      (prismaMock.order.create as jest.Mock).mock.invocationCallOrder[0],
    ]
    expect(orden).toEqual([...orden].sort((a, b) => a - b))
  })

  it('13b. sin externalId no hay candado ni re-verificación (no hay idempotencia que proteger)', async () => {
    const tx = transaccionPropia()

    await crear({ items: [{ productId: 'prod-1', quantity: 1 }] })

    expect(tx.$queryRaw).not.toHaveBeenCalled()
    expect(tx.order.findUnique).not.toHaveBeenCalled()
    expect(prismaMock.order.create).toHaveBeenCalledTimes(1)
  })

  it('14. la re-verificación encuentra la venta que confirmó el primer intento: ni arma, ni crea, ni 409', async () => {
    // Sola, esta venta sería 409: catálogo de hace 4 días y un precio menor.
    const tx = transaccionPropia(ordenGuardada())

    const r = await crear({
      externalId: 'venta-K',
      items: [{ productId: 'prod-1', quantity: 1, externalId: 'e1', displayedUnitPrice: 4000, catalogAt: HACE_4_DIAS }],
    })

    expect(r.id).toBe('order-ganadora')
    expect(tx.product.findMany).not.toHaveBeenCalled()
    expect(prismaMock.order.create).not.toHaveBeenCalled()
    expect(r.priceChanges).toEqual([
      {
        externalId: 'e1',
        productId: 'prod-1',
        productName: 'Café',
        catalogAt: HACE_4_DIAS,
        displayedUnitPriceCents: 4000,
        unitPriceCents: 5000,
      },
    ])
  })

  it('15. la misma llave de línea dos veces en el MISMO pedido: una orden, la segunda línea sin llave y con su precio decidido', async () => {
    const r = await crear({
      externalId: 'venta-15',
      items: [
        { productId: 'prod-1', quantity: 1, externalId: 'e1', displayedUnitPrice: 5500, catalogAt: CAT },
        { productId: 'prod-1', quantity: 1, externalId: 'e1', displayedUnitPrice: 5500, catalogAt: CAT },
      ],
    })

    expect(prismaMock.order.create).toHaveBeenCalledTimes(1)
    expect(datosDeLaOrden().items.create.map((l: any) => l.externalId ?? null)).toEqual(['e1', null])
    expect(lineasCreadas().map(l => Number(l.unitPrice))).toEqual([50, 50])
    expect(r.priceChanges?.map(c => c.externalId)).toEqual(['e1', null])
  })

  it('16. un P2002 que NO es de la llave de la orden (una línea) sube tal cual: no se busca ganadora', async () => {
    transaccionPropia()
    const choque = p2002(['orderId', 'externalId'])
    prismaMock.order.create.mockRejectedValue(choque)
    // Si se buscara «ganadora», habría una (de otra venta con la llave): leer este choque como la carrera la devolvería.
    prismaMock.order.findUnique.mockResolvedValueOnce(null).mockResolvedValue(ordenGuardada())

    await expect(crear({ externalId: 'venta-K', items: [{ productId: 'prod-1', quantity: 1 }] })).rejects.toBe(choque)
    expect(prismaMock.order.findUnique).toHaveBeenCalledTimes(1) // sólo el atajo de fuera
  })

  it('17. un P2002 de la llave de la orden responde la ganadora con `priceChanges` (el mismo ayudante)', async () => {
    transaccionPropia() // la re-verificación no la ve: la ganadora confirmó entre el candado y el insert (otro escritor de la llave)
    prismaMock.order.findUnique.mockResolvedValueOnce(null).mockResolvedValue(ordenGuardada())
    prismaMock.order.create.mockRejectedValue(p2002(['venueId', 'externalId']))

    const r = await crear({
      externalId: 'venta-K',
      items: [{ productId: 'prod-1', quantity: 1, externalId: 'e1', displayedUnitPrice: 5500, catalogAt: CAT }],
    })

    expect(r.id).toBe('order-ganadora')
    expect(r.priceChanges).toEqual([
      { externalId: 'e1', productId: 'prod-1', productName: 'Café', catalogAt: CAT, displayedUnitPriceCents: 5500, unitPriceCents: 5000 },
    ])
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/Concurrent duplicate blocked by unique index/))
  })

  it('18. el chequeo de preparación corre en la creación, con todas las líneas, ANTES de abrir la transacción', async () => {
    espias.push(jest.spyOn(basePlan, 'venueHasFeatureAccess').mockResolvedValue(false))

    await expect(
      crear({ externalId: 'venta-18', items: [{ productId: 'prod-1', quantity: 1, serviceCourse: { preparationVersion: 1 } as any }] }),
    ).rejects.toMatchObject({ statusCode: 403, message: 'La preparación por producto requiere Pro.' })
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
  })

  it('19. el reintento de un cuerpo con la llave de línea repetida responde el MISMO cambio de e1 que la creación, una sola vez', async () => {
    const cuerpo = {
      externalId: 'venta-19',
      items: [
        { productId: 'prod-1', quantity: 1, externalId: 'e1', displayedUnitPrice: 5500, catalogAt: CAT },
        { productId: 'prod-1', quantity: 1, externalId: 'e1', displayedUnitPrice: 5500, catalogAt: CAT },
      ],
    }
    const creada = await crear(cuerpo)
    // La respuesta se perdió: el reintento encuentra lo que la creación guardó (la 2.ª línea, sin llave).
    prismaMock.order.findUnique.mockResolvedValue(ordenDesdeLosDatos((prismaMock.order.create as jest.Mock).mock.calls[0][0]))

    const reintento = await crear(cuerpo)

    expect(reintento.id).toBe(creada.id)
    expect(prismaMock.order.create).toHaveBeenCalledTimes(1)
    const deE1 = creada.priceChanges!.filter(c => c.externalId === 'e1')
    expect(deE1).toHaveLength(1)
    // La línea repetida viajó sin llave: el reintento no tiene con qué correlacionarla (techo del arreglo a).
    expect(reintento.priceChanges).toEqual(deE1)
  })
})

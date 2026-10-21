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
    items: data.items.create.map((it: any, k: number) => ({ id: `oi-${k}`, ...it, modifiers: [] })),
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

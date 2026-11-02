/**
 * 🔴 DINERO — cortesías y descuento de CUENTA de catálogo en la orden de mobile («Cobrar sin red», S4).
 *
 * La terminal sube por `POST /mobile/venues/:venueId/orders` las ventas que hizo sin red. Hoy manda a `/tpv/with-items`
 * `isCortesia`/`cortesiaReason` por línea y `orderDiscountId` en la raíz; mobile no los aceptaba y una cortesía hecha sin red
 * subía a precio completo. Aquí mobile los acepta con la MISMA semántica que `/tpv` (`order.tpv.service.ts` createOrderWithItems):
 * la línea regalada entera (`discountAmount` = bruto), su fila COMP «Cortesía» espejo, una OrderAction COMP por línea, y el
 * descuento de catálogo de la cuenta sobre lo que no es cortesía. A diferencia de `/tpv`, la orden en $0 NO se cierra al
 * crearse: la cola publicada de Android crea y luego paga $0, y ese pago es el que la cierra.
 */
jest.mock('@/services/venueSalesGuard', () => ({ __esModule: true, assertVenueSalesEnabled: jest.fn() }))
jest.mock('@/middlewares/permissionFlag.middleware', () => ({ tienePermisoEnVenue: jest.fn().mockResolvedValue(true) }))
jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: jest.fn(() => null) } }))

import type { NextFunction, Request, Response } from 'express'
import { Decimal } from '@prisma/client/runtime/library'
import { createOrder } from '@/controllers/mobile/order.mobile.controller'
import * as orderMobileService from '@/services/mobile/order.mobile.service'
import { buildOrderItemsData, createOrderWithItems, type CreateOrderInput } from '@/services/mobile/order.mobile.service'
import { prismaMock } from '../../../__helpers__/setup'

const PRODUCTOS = [
  { id: 'cafe', name: 'Café', price: new Decimal(50), sku: 'CAFE', categoryId: 'c1', category: { name: 'Bebidas' } },
  { id: 'pan', name: 'Pan', price: new Decimal(30), sku: 'PAN', categoryId: 'c1', category: { name: 'Pan' } },
  { id: 'jugo', name: 'Jugo', price: new Decimal(20), sku: 'JUGO', categoryId: 'c1', category: { name: 'Bebidas' } },
]
const catalogo = (id: string, extra: Record<string, unknown>) => ({
  id,
  venueId: 'venue-1',
  name: id,
  active: true,
  validFrom: null,
  validUntil: null,
  maxTotalUses: null,
  currentUses: 0,
  minPurchaseAmount: null,
  maxDiscountAmount: null,
  compReason: null,
  ...extra,
})
const ORDEN10 = catalogo('orden10', { type: 'PERCENTAGE', value: new Decimal(10), scope: 'ORDER', name: 'Diez por ciento' })
const ART5 = catalogo('art5', { type: 'FIXED_AMOUNT', value: new Decimal(5), scope: 'ITEM', targetItemIds: [] })

let filas: any[]
let acciones: any[]
let ordenGuardada: any

/** La orden que «guarda» la base: lo que se mandó a crear, con ids `oi-<k>` en el orden de `items.create`. */
function ordenDesdeLosDatos({ data }: any) {
  ordenGuardada = {
    id: 'order-1',
    orderNumber: data.orderNumber,
    status: data.status,
    paymentStatus: data.paymentStatus,
    type: data.type,
    source: data.source,
    subtotal: data.subtotal,
    discountAmount: data.discountAmount,
    taxAmount: data.taxAmount,
    total: data.total,
    createdAt: new Date(),
    items: data.items.create.map((it: any, k: number) => ({
      id: `oi-${k}`,
      isCortesia: false,
      cortesiaReason: null,
      ...it,
      modifiers: [],
    })),
    promotions: [],
  }
  return ordenGuardada
}

const datosDeLaOrden = () => (prismaMock.order.create as jest.Mock).mock.calls[0][0].data
const lineas = () => datosDeLaOrden().items.create as any[]

function crear(extra: Partial<CreateOrderInput>) {
  return createOrderWithItems('venue-1', {
    staffId: 'staff-1',
    canCompItems: true,
    performedBy: 'staff-1',
    source: 'TPV',
    orderType: 'TAKEOUT',
    items: [],
    ...extra,
  } as CreateOrderInput)
}

beforeEach(() => {
  jest.clearAllMocks()
  filas = []
  acciones = []
  ordenGuardada = null
  prismaMock.$transaction.mockImplementation(async (callback: any) => callback(prismaMock))
  prismaMock.$queryRaw.mockResolvedValue([])
  prismaMock.staff.findUnique.mockResolvedValue({ id: 'staff-1', venueId: 'venue-1' })
  prismaMock.staffVenue.findFirst.mockResolvedValue({ id: 'sv-1', staffId: 'staff-1', venueId: 'venue-1', active: true })
  prismaMock.product.findMany.mockImplementation(async ({ where }: any) => PRODUCTOS.filter(p => where.id.in.includes(p.id)))
  prismaMock.modifier.findMany.mockResolvedValue([])
  prismaMock.discount.findMany.mockImplementation(async ({ where }: any) => [ORDEN10, ART5].filter(d => where.id.in.includes(d.id)))
  prismaMock.discount.findFirst.mockImplementation(async ({ where }: any) => [ORDEN10, ART5].find(d => d.id === where.id) ?? null)
  prismaMock.discount.updateMany.mockResolvedValue({ count: 1 })
  prismaMock.order.findUnique.mockResolvedValue(null)
  prismaMock.order.create.mockImplementation(async (args: any) => ordenDesdeLosDatos(args))
  prismaMock.orderDiscount.create.mockImplementation(async ({ data }: any) => {
    const f = { id: `od-${filas.length + 1}`, createdAt: new Date(0), taxReduction: 0, appliedToItemIds: [], ...data }
    filas.push(f)
    return f
  })
  prismaMock.orderDiscount.findMany.mockImplementation(async () => filas)
  prismaMock.orderDiscount.update.mockResolvedValue({})
  // Los renglones para el reparto: los de la orden recién guardada.
  prismaMock.orderItem.findMany.mockImplementation(async () =>
    (ordenGuardada?.items ?? []).map((i: any) => ({
      id: i.id,
      total: i.total,
      discountAmount: i.discountAmount,
      orderPromotionId: null,
      isCortesia: i.isCortesia ?? false,
      taxAmount: new Decimal(0),
      productId: i.productId,
      product: i.productId ? { categoryId: 'c1' } : null,
    })),
  )
  ;(prismaMock as any).orderAction ??= { create: jest.fn() }
  ;(prismaMock as any).orderAction.create.mockImplementation(async ({ data }: any) => {
    acciones.push(data)
    return { id: `oa-${acciones.length}` }
  })
})

describe('cortesías y descuento de cuenta en la orden de mobile — servicio', () => {
  it('línea cortesía queda en $0 con su OrderDiscount COMP (espejo) y su OrderAction COMP, como /tpv', async () => {
    const r = await crear({
      items: [
        { productId: 'cafe', quantity: 2, externalId: 'k:0', isCortesia: true, cortesiaReason: 'Invitación de la casa' },
        { productId: 'pan', quantity: 1, externalId: 'k:1' },
      ],
    })

    // La línea regalada guarda su bruto en `total` y lo mismo en `discountAmount` (convención de «Cobrar»).
    expect(lineas()[0]).toMatchObject({ isCortesia: true, cortesiaReason: 'Invitación de la casa', appliedDiscountId: null })
    expect(Number(lineas()[0].total)).toBe(100)
    expect(Number(lineas()[0].discountAmount)).toBe(100)
    expect(lineas()[1]).not.toHaveProperty('isCortesia')
    expect(Number(lineas()[1].discountAmount)).toBe(0)
    expect(datosDeLaOrden()).toMatchObject({ status: 'CONFIRMED', paymentStatus: 'PENDING' })
    expect(Number(datosDeLaOrden().subtotal)).toBe(130)
    expect(Number(datosDeLaOrden().discountAmount)).toBe(100)
    expect(Number(datosDeLaOrden().total)).toBe(30)
    expect(Number(datosDeLaOrden().remainingBalance)).toBe(30)
    expect(r.total).toBe(30) // pesos, como siempre en la respuesta de crear

    expect(filas).toHaveLength(1)
    expect(filas[0]).toMatchObject({
      orderId: 'order-1',
      type: 'COMP',
      name: 'Cortesía',
      isComp: true,
      isManual: true,
      compReason: 'Invitación de la casa',
      appliedById: 'sv-1',
      appliedToItemIds: ['oi-0'],
      reparto: { v: 1, alcance: 'DIRIGIDO', conPromociones: null, espejo: true, renglones: { 'oi-0': 10000 } },
    })
    expect(Number(filas[0].amount)).toBe(100)
    expect(Number(filas[0].value)).toBe(100)

    expect(acciones).toEqual([
      {
        orderId: 'order-1',
        actionType: 'COMP',
        performedById: 'staff-1',
        reason: 'Invitación de la casa',
        metadata: {
          orderItemId: 'oi-0',
          productId: 'cafe',
          productName: 'Café',
          lineSubtotalGivenAway: 100,
          cortesiaReason: 'Invitación de la casa',
        },
      },
    ])
    // Sin cobro al crear: lo cierra el /pay de la cola, como Android.
    expect(prismaMock.payment.create).not.toHaveBeenCalled()
  })

  it('la línea libre («Otro importe») también puede ir en cortesía', async () => {
    await crear({
      items: [
        { productId: 'pan', quantity: 1 },
        { name: 'Pastel', unitPrice: 4500, quantity: 1, isCortesia: true, cortesiaReason: 'Cumpleaños' },
      ],
    })

    // Las líneas libres van después de las de producto en `items.create`.
    expect(lineas()[1]).toMatchObject({ productId: null, productName: 'Pastel', isCortesia: true, cortesiaReason: 'Cumpleaños' })
    expect(Number(lineas()[1].discountAmount)).toBe(45)
    expect(Number(datosDeLaOrden().total)).toBe(30)
    expect(acciones[0].metadata).toMatchObject({ orderItemId: 'oi-1', productId: null, productName: 'Pastel', lineSubtotalGivenAway: 45 })
  })

  it('cortesía junto con discountId de línea ⇒ 400 en el servicio también (como /tpv), sin escribir nada', async () => {
    await expect(
      crear({ items: [{ productId: 'cafe', quantity: 1, isCortesia: true, cortesiaReason: 'x', discountId: 'art5' }] }),
    ).rejects.toMatchObject({ statusCode: 400 })
    expect(prismaMock.order.create).not.toHaveBeenCalled()
  })

  it('orderDiscountId aplica sobre lo que no es cortesía; el `discount` libre no se suma encima', async () => {
    await crear({
      items: [
        { productId: 'cafe', quantity: 2, isCortesia: true, cortesiaReason: 'Cliente frecuente' },
        { productId: 'pan', quantity: 1 },
        { productId: 'jugo', quantity: 1 },
      ],
      orderDiscountId: 'orden10',
      discount: 500, // centavos: la terminal no los manda junto con el de catálogo; si llegan, el de catálogo manda (como /tpv)
    })

    // Base del de cuenta = 150 bruto − 100 de cortesía = 50 ⇒ 10 % = 5.
    expect(Number(datosDeLaOrden().subtotal)).toBe(150)
    expect(Number(datosDeLaOrden().discountAmount)).toBe(105)
    expect(Number(datosDeLaOrden().total)).toBe(45)
    const deCuenta = filas.find(f => f.discountId === 'orden10')
    expect(deCuenta).toMatchObject({
      type: 'PERCENTAGE',
      name: 'Diez por ciento',
      isComp: false,
      isManual: true,
      compReason: null,
      appliedById: 'sv-1',
      appliedToItemIds: ['oi-1', 'oi-2'],
    })
    expect(Number(deCuenta.amount)).toBe(5)
    expect(deCuenta.reparto).toEqual({
      v: 1,
      alcance: 'CUENTA',
      conPromociones: false,
      base: ['oi-1', 'oi-2'],
      espejo: false,
      renglones: {},
    })
    // Ninguna fila de «Descuento de la cuenta» libre: el `discount` se ignoró.
    expect(filas.map(f => f.name)).toEqual(['Cortesía', 'Diez por ciento'])
    // El reparto de la fila de cuenta se sincroniza en la transacción: 500 centavos sobre pan (3 000) y jugo (2 000).
    expect(prismaMock.orderDiscount.update).toHaveBeenCalledWith({
      where: { id: deCuenta.id },
      data: { reparto: { ...deCuenta.reparto, renglones: { 'oi-1': 300, 'oi-2': 200 } } },
    })
    // currentUses++ del descuento de catálogo.
    expect(prismaMock.discount.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['orden10'] } },
      data: { currentUses: { increment: 1 } },
    })
  })

  it('orderDiscountId de otro negocio o inexistente ⇒ 400, sin crear la orden', async () => {
    await expect(crear({ items: [{ productId: 'pan', quantity: 1 }], orderDiscountId: 'ajeno' })).rejects.toMatchObject({ statusCode: 400 })
    expect(prismaMock.discount.findFirst).toHaveBeenCalledWith({ where: { id: 'ajeno', venueId: 'venue-1' } })
    expect(prismaMock.order.create).not.toHaveBeenCalled()
  })

  it('orderDiscountId junto con una promoción ⇒ 400 (la base de la cuenta con combos no está definida todavía)', async () => {
    await expect(
      crear({
        items: [{ quantity: 1, promotionRef: { promotionId: 'p', promotionInstanceId: 'i', selections: [] } } as any],
        orderDiscountId: 'orden10',
      }),
    ).rejects.toMatchObject({ statusCode: 400 })
    expect(prismaMock.order.create).not.toHaveBeenCalled()
  })

  it('orden toda en cortesía ⇒ total 0 y saldo 0, pero NO se cierra al crearse (el /pay de $0 de la cola la cierra)', async () => {
    const r = await crear({
      items: [
        { productId: 'cafe', quantity: 1, isCortesia: true, cortesiaReason: 'Invitación' },
        { name: 'Galleta', unitPrice: 1500, quantity: 2, isCortesia: true, cortesiaReason: 'Invitación' },
      ],
      externalId: 'venta-0',
      isOfflineReplay: true,
    })

    expect(Number(datosDeLaOrden().subtotal)).toBe(80)
    expect(Number(datosDeLaOrden().total)).toBe(0)
    expect(Number(datosDeLaOrden().remainingBalance)).toBe(0)
    expect(datosDeLaOrden()).toMatchObject({ status: 'CONFIRMED', paymentStatus: 'PENDING' })
    expect(r).toMatchObject({ id: 'order-1', total: 0, paymentStatus: 'PENDING' })
    // Una sola fila COMP para toda la venta, con los dos renglones; una acción por renglón.
    expect(filas).toHaveLength(1)
    expect(filas[0].appliedToItemIds).toEqual(['oi-0', 'oi-1'])
    expect(filas[0].compReason).toBe('Invitación; Invitación')
    expect(Number(filas[0].amount)).toBe(80)
    expect(acciones).toHaveLength(2)
    // Nada de cobro, inventario ni cierre en la creación.
    expect(prismaMock.payment.create).not.toHaveBeenCalled()
    expect(prismaMock.order.update).not.toHaveBeenCalled()
  })

  it('la misma orden $0 pedida otra vez con su externalId ⇒ la misma orden, sin escribir nada (ni segundo inventario)', async () => {
    const venta = {
      items: [{ productId: 'cafe', quantity: 1, externalId: 'venta-0:0', isCortesia: true, cortesiaReason: 'Invitación' }],
      externalId: 'venta-0',
      isOfflineReplay: true,
    }
    const primera = await crear(venta)
    prismaMock.order.findUnique.mockResolvedValue(ordenGuardada)
    const segunda = await crear(venta)

    expect(segunda.id).toBe(primera.id)
    expect(segunda.total).toBe(0)
    expect(prismaMock.order.create).toHaveBeenCalledTimes(1)
    expect(prismaMock.orderDiscount.create).toHaveBeenCalledTimes(1)
    expect(acciones).toHaveLength(1)
    expect(prismaMock.discount.updateMany).not.toHaveBeenCalled()
    expect(prismaMock.payment.create).not.toHaveBeenCalled()
    expect(prismaMock.inventoryPosting.create).not.toHaveBeenCalled()
  })

  it('sin campos nuevos ⇒ como hoy: sin marca de cortesía, sin filas ni acciones, sin buscar descuento de cuenta', async () => {
    await crear({ items: [{ productId: 'cafe', quantity: 1 }], discount: 1000 })

    expect(lineas()[0]).not.toHaveProperty('isCortesia')
    expect(lineas()[0]).not.toHaveProperty('cortesiaReason')
    expect(Number(datosDeLaOrden().discountAmount)).toBe(10)
    expect(Number(datosDeLaOrden().total)).toBe(40)
    expect(filas.map(f => f.name)).toEqual(['Descuento de la cuenta'])
    expect(acciones).toEqual([])
    expect(prismaMock.discount.findFirst).not.toHaveBeenCalled()
  })

  it('los vales (buildOrderItemsData sin activar cortesías) ignoran isCortesia como hoy', async () => {
    const r = await buildOrderItemsData('venue-1', [{ productId: 'cafe', quantity: 1, isCortesia: true, cortesiaReason: 'x' }], null)

    expect(r.itemsData[0]).not.toHaveProperty('isCortesia')
    expect(Number(r.itemsData[0].discountAmount)).toBe(0)
    expect(r.itemDiscountTotal).toBe(0)
  })
})

// ── Frontera (controlador): validación a mano, sin Zod ─────────────────────────────────────────────────────────────

function buildRes() {
  const res = {} as Response & { statusCode?: number; body?: any }
  res.status = jest.fn().mockImplementation((code: number) => {
    res.statusCode = code
    return res
  }) as unknown as Response['status']
  res.json = jest.fn().mockImplementation((body: any) => {
    res.body = body
    return res
  }) as unknown as Response['json']
  return res
}

async function enviar(body: Record<string, unknown>) {
  const res = buildRes()
  const next = jest.fn() as NextFunction
  await createOrder(
    { params: { venueId: 'venue-1' }, body: { staffId: 'staff-1', ...body }, authContext: { userId: 'staff-1' } } as unknown as Request,
    res,
    next,
  )
  return res
}

describe('cortesías y descuento de cuenta en la orden de mobile — controlador', () => {
  let servicio: jest.SpyInstance
  beforeEach(() => {
    servicio = jest.spyOn(orderMobileService, 'createOrderWithItems').mockResolvedValue({ id: 'order-1' } as any)
  })
  afterEach(() => servicio.mockRestore())

  it('cortesía sin motivo (ausente, vacío o en blanco) ⇒ 400', async () => {
    for (const cortesiaReason of [undefined, null, '', '   ', 42]) {
      const res = await enviar({ items: [{ productId: 'cafe', quantity: 1, isCortesia: true, cortesiaReason }] })
      expect(res.statusCode).toBe(400)
      expect(res.body.message).toBe('La razón de cortesía es requerida.')
    }
    expect(servicio).not.toHaveBeenCalled()
  })

  it('cortesía junto con discountId de línea ⇒ 400', async () => {
    const res = await enviar({ items: [{ productId: 'cafe', quantity: 1, isCortesia: true, cortesiaReason: 'x', discountId: 'art5' }] })
    expect(res.statusCode).toBe(400)
    expect(res.body.message).toBe('Un ítem no puede tener cortesía y descuento al mismo tiempo.')
    expect(servicio).not.toHaveBeenCalled()
  })

  it('isCortesia que no es booleano ⇒ 400 (nunca se cobra completo en silencio lo que la caja regaló)', async () => {
    const res = await enviar({ items: [{ productId: 'cafe', quantity: 1, isCortesia: 'true', cortesiaReason: 'x' }] })
    expect(res.statusCode).toBe(400)
    expect(servicio).not.toHaveBeenCalled()
  })

  it('una promoción no puede ir en cortesía ⇒ 400', async () => {
    const res = await enviar({
      items: [{ promotionRef: { promotionId: 'p', promotionInstanceId: 'i', selections: [] }, isCortesia: true, cortesiaReason: 'x' }],
    })
    expect(res.statusCode).toBe(400)
    expect(servicio).not.toHaveBeenCalled()
  })

  it('orderDiscountId que no es texto ⇒ 400', async () => {
    for (const orderDiscountId of [42, '', { id: 'x' }]) {
      const res = await enviar({ items: [{ productId: 'cafe', quantity: 1 }], orderDiscountId })
      expect(res.statusCode).toBe(400)
    }
    expect(servicio).not.toHaveBeenCalled()
  })

  it('pasa al servicio la cortesía de la línea y el orderDiscountId; sin ellos, como hoy', async () => {
    const linea = { productId: 'cafe', quantity: 1, isCortesia: true, cortesiaReason: 'Invitación' }
    let res = await enviar({ items: [linea], orderDiscountId: 'orden10' })
    expect(res.statusCode).toBe(201)
    expect(servicio.mock.calls[0][1]).toMatchObject({ items: [linea], orderDiscountId: 'orden10' })

    servicio.mockClear()
    res = await enviar({ items: [{ productId: 'cafe', quantity: 1, isCortesia: false }] })
    expect(res.statusCode).toBe(201)
    expect(servicio.mock.calls[0][1].orderDiscountId).toBeNull()
  })
})

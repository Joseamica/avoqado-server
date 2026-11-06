// tests/unit/services/online-ordering/order.service.test.ts
import { Prisma } from '@prisma/client'
import { prismaMock } from '@tests/__helpers__/setup'
import AppError, { ForbiddenError, ServiceUnavailableError, UnauthorizedError } from '@/errors/AppError'

jest.mock('@/services/online-ordering/presence.service', () => ({ __esModule: true, getAcceptingStatus: jest.fn() }))
jest.mock('@/services/online-ordering/quote.service', () => ({
  __esModule: true,
  quoteCart: jest.fn(),
  toPublicQuote: jest.fn((q: any) => ({ total: Number(q.total.toFixed(2)) })),
}))
jest.mock('@/communication/sockets/managers/socketManager', () => ({
  __esModule: true,
  socketManager: { broadcastToVenue: jest.fn() },
}))

import { getAcceptingStatus } from '@/services/online-ordering/presence.service'
import { quoteCart } from '@/services/online-ordering/quote.service'
import { socketManager } from '@/communication/sockets/managers/socketManager'
import { examinarRenglon } from '@/services/fiscal/cfdi.service'
import {
  createOnlineOrder,
  fromQuoteSnapshot,
  getTrackingByToken,
  onlineOrderRequestHash,
  toQuoteSnapshot,
  writeOnlineOrderInTx,
  type CreateOnlineOrderOptions,
} from '@/services/online-ordering/order.service'

const D = (v: string) => new Prisma.Decimal(v)
/** P1-06: plan y negocio operativo PASAN (son obligatorios en la firma; sus rechazos se prueban en los bloques P1-06 y R2-2). */
const PUEDE_CREAR: CreateOnlineOrderOptions = { assertCanCreate: async () => {} }
const NOW = new Date('2026-10-14T18:30:00.000Z')
const KEY = 'k'.repeat(32)
const PHONE = '+525543453965'
/** Codex r2: el candado de la llave (va primero) y el del negocio (R4). */
const KEY_LOCK = `online-order-key:v1:web:${KEY}`
const ADMISSION_LOCK = 'online-order-admission:v1'

const OPEN = { status: 'OPEN', reason: null, config: { acceptsPayAtPickup: true, defaultPrepMinutes: 15 } }
const QUOTE_OK = {
  ok: true,
  issues: [],
  subtotal: D('206.00'),
  total: D('206.00'),
  minOrderAmount: D('0'),
  lines: [
    {
      productId: 'p1',
      productName: 'Flautas',
      productSku: 'FLA-1',
      categoryName: 'Flautas',
      quantity: 2,
      unitPrice: D('93.00'),
      modifiers: [{ modifierId: 'm2', name: 'Salsa verde', quantity: 1, unitPrice: D('10.00') }],
      note: 'sin crema',
      lineTotal: D('206.00'),
    },
  ],
}

const input = (o: Record<string, unknown> = {}) => ({
  venueId: 'v1',
  idempotencyKey: KEY,
  items: [{ productId: 'p1', quantity: 2, modifiers: [{ modifierId: 'm2' }] }],
  paymentMode: 'PAY_AT_PICKUP' as const,
  expectedTotal: '206.00',
  customer: { name: 'María G.', phone: '55 4345 3965', email: null },
  customerId: 'cust1',
  verifiedPhone: PHONE,
  note: null,
  whatsappConsent: true,
  now: NOW,
  ...o,
})

/** A1: la huella de la solicitud `input(o)` tal como la guarda el servicio (teléfono canónico, nombre tal cual llega). */
const huella = (o: Record<string, unknown> = {}) => {
  const i = input(o) as any
  return onlineOrderRequestHash({
    venueId: i.venueId,
    customerId: i.customerId,
    paymentMode: i.paymentMode,
    expectedTotal: i.expectedTotal,
    items: i.items,
    customerName: i.customer.name,
    customerPhone: PHONE,
  })
}
/** El pedido en línea ya creado con esta llave; por omisión, con la huella de `input()`. */
const oo = (o: Record<string, unknown> = {}) => ({
  id: 'oo1',
  status: 'ACCEPTED',
  trackingToken: 'T'.repeat(32),
  acceptDeadlineAt: NOW,
  requestHash: huella(),
  ...o,
})
const existing = (o: Record<string, unknown> = {}) => ({
  id: 'ord1',
  orderNumber: 'WABCD',
  total: D('206.00'),
  customerId: 'cust1',
  onlineOrder: oo(),
  ...o,
})

beforeEach(() => {
  ;(getAcceptingStatus as jest.Mock).mockResolvedValue(OPEN)
  ;(quoteCart as jest.Mock).mockResolvedValue(QUOTE_OK)
  prismaMock.order.findUnique.mockReset() // sin lecturas «Once» sobrantes de otra prueba
  prismaMock.order.findUnique.mockResolvedValue(null)
  prismaMock.order.findFirst.mockResolvedValue(null)
  prismaMock.onlineOrder.count.mockResolvedValue(0)
  prismaMock.onlineOrderCharge.count.mockResolvedValue(0) // borradores de tarjeta vigentes (fase 2)
  ;(prismaMock.$transaction as jest.Mock).mockImplementation(async (fn: any) => fn(prismaMock))
  prismaMock.order.create.mockResolvedValue({ id: 'ord1', orderNumber: 'WABCD' } as any)
  prismaMock.onlineOrder.create.mockImplementation(async (a: any) => ({ id: 'oo1', ...a.data }) as any)
  // Codex r3: los rechazos guardados de la llave (tabla genérica `IdempotencyRequest`). Por omisión, ninguno.
  prismaMock.idempotencyRequest = { findUnique: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue({}) }
  // R47: sin sesión el servicio lee SÓLO el modo de la tienda; sin fila de ajustes es «Mi equipo» (R37).
  prismaMock.onlineOrderingSettings.findUnique.mockResolvedValue(null)
})

describe('createOnlineOrder', () => {
  it('crea Order PICKUP/WEB con renglones, categoría y extras POR UNIDAD como la terminal (F2, R3)', async () => {
    const res = await createOnlineOrder(input(), PUEDE_CREAR)

    const data = (prismaMock.order.create.mock.calls[0][0] as any).data
    expect(data).toMatchObject({
      venueId: 'v1',
      type: 'PICKUP',
      source: 'WEB',
      externalId: `web:${KEY}`,
      status: 'PENDING',
      paymentStatus: 'PENDING',
      contratoDePrecio: 'IVA_INCLUIDO',
      customerName: 'María G.',
      customerPhone: PHONE,
      customerId: 'cust1',
    })
    expect(data.total.toFixed(2)).toBe('206.00')
    expect(data.remainingBalance.toFixed(2)).toBe('206.00')
    expect(data.tipAmount.toFixed(2)).toBe('0.00')
    // Nace desde el teléfono del comensal, no en el mostrador: no se ata al turno (el cobro sí, en `Payment.shiftId`).
    expect(data).not.toHaveProperty('shiftId')

    const item = data.items.create[0]
    expect(item).toMatchObject({
      productId: 'p1',
      productName: 'Flautas',
      categoryName: 'Flautas',
      quantity: 2,
      notes: 'sin crema',
      externalId: `web:${KEY}-0`,
    })
    expect(item.total.toFixed(2)).toBe('206.00')
    // F2: `price` = precio POR UNIDAD del extra; `quantity` = cuántos por unidad del platillo
    const m = item.modifiers.create[0]
    expect(m.quantity).toBe(1)
    expect(m.price.toFixed(2)).toBe('10.00')

    expect(res).toMatchObject({ orderId: 'ord1', status: 'PENDING_ACCEPTANCE', replay: false, total: '206.00' })
    expect(res.trackingToken).toMatch(/^[A-Za-z0-9_-]{32}$/)
    expect(new Date(res.acceptDeadlineAt).getTime()).toBe(NOW.getTime() + 10 * 60_000)
    expect(socketManager.broadcastToVenue).toHaveBeenCalled()
  })

  it('el renglón creado cuadra con la factura: examinarRenglon no devuelve motivos (R3)', async () => {
    await createOnlineOrder(input(), PUEDE_CREAR)
    const item = (prismaMock.order.create.mock.calls[0][0] as any).data.items.create[0]
    const r = examinarRenglon(
      {
        productName: item.productName,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        discountAmount: item.discountAmount,
        total: item.total,
        modifiers: item.modifiers.create.map((x: any) => ({ name: x.name, price: x.price, quantity: x.quantity })),
        product: { name: item.productName, taxRate: 0.16, objetoImp: '02' },
      },
      0,
    )
    expect(r).not.toHaveProperty('motivos')
    expect(r).not.toHaveProperty('omitido')
  })

  it('la admisión corre bajo el candado de la llave y luego el del negocio, y ahí repite repetición, topes y folio (R4, Codex r2)', async () => {
    await createOnlineOrder(input(), PUEDE_CREAR)
    const calls = (prismaMock.$executeRaw as jest.Mock).mock.calls
    expect(calls.map(([strings]) => (strings as string[]).join('?'))).toEqual([
      expect.stringContaining('pg_advisory_xact_lock(hashtext(?))'),
      expect.stringContaining('pg_advisory_xact_lock(hashtext(?))'),
    ])
    expect(calls.map(([, key]) => key)).toEqual([KEY_LOCK, ADMISSION_LOCK]) // siempre la llave antes que el negocio
    expect(prismaMock.order.findUnique).toHaveBeenCalledTimes(2) // tras el candado de la llave y tras el del negocio
    expect(prismaMock.onlineOrder.count).toHaveBeenCalledTimes(2) // tope por teléfono y por negocio
    expect(prismaMock.order.findFirst).toHaveBeenCalled() // folio sin chocar con una cuenta abierta
  })

  it('la repetición del MISMO cliente devuelve el MISMO token sin crear otro pedido', async () => {
    prismaMock.order.findUnique.mockResolvedValue(existing() as any)
    const res = await createOnlineOrder(input(), PUEDE_CREAR)
    expect(res).toMatchObject({ replay: true, trackingToken: 'T'.repeat(32), status: 'ACCEPTED', orderId: 'ord1' })
    // Sólo el candado de la llave: al del negocio no se llega.
    expect((prismaMock.$executeRaw as jest.Mock).mock.calls.map(([, key]) => key)).toEqual([KEY_LOCK])
    expect(prismaMock.order.create).not.toHaveBeenCalled()
  })

  it('una repetición que aparece ya dentro del candado del negocio tampoco crea otro pedido', async () => {
    prismaMock.order.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(existing({ onlineOrder: oo({ status: 'PENDING_ACCEPTANCE' }) }) as any)
    const res = await createOnlineOrder(input(), PUEDE_CREAR)
    expect(res).toMatchObject({ replay: true, orderId: 'ord1', status: 'PENDING_ACCEPTANCE' })
    expect(prismaMock.order.create).not.toHaveBeenCalled()
    expect(socketManager.broadcastToVenue).not.toHaveBeenCalled()
  })

  it('la misma llave de OTRO cliente es 409 IDEMPOTENCY_KEY_CONFLICT y no entrega el token (R8: su huella guarda otro cliente)', async () => {
    const deOtro = existing({ customerId: 'otro-cliente', onlineOrder: oo({ requestHash: huella({ customerId: 'otro-cliente' }) }) })
    prismaMock.order.findUnique.mockResolvedValue(deOtro as any)
    const err = await createOnlineOrder(input(), PUEDE_CREAR).catch((e: unknown) => e)
    expect(err).toMatchObject({ statusCode: 409, code: 'IDEMPOTENCY_KEY_CONFLICT' })
    expect(JSON.stringify(err) + (err as Error).message).not.toContain('T'.repeat(32))
  })

  it('Codex r2 #5: una llave que ya tiene borrador de TARJETA es 409 IDEMPOTENCY_KEY_CONFLICT (final) y no crea nada', async () => {
    prismaMock.onlineOrderCharge.findUnique.mockResolvedValueOnce({ id: 'ch1' } as any)
    await expect(createOnlineOrder(input(), PUEDE_CREAR)).rejects.toMatchObject({
      statusCode: 409,
      code: 'IDEMPOTENCY_KEY_CONFLICT',
      final: true,
    })
    expect(prismaMock.onlineOrderCharge.findUnique).toHaveBeenCalledWith({
      where: { venueId_idempotencyKey: { venueId: 'v1', idempotencyKey: KEY } },
      select: { id: true },
    })
    expect(prismaMock.order.create).not.toHaveBeenCalled()
  })

  const PEDIDO_DISTINTO = {
    statusCode: 409,
    code: 'IDEMPOTENCY_KEY_CONFLICT',
    message: 'Ya hiciste un pedido distinto con esta misma solicitud. Recarga la página para empezar uno nuevo.',
  }

  it('M-3: la misma llave del MISMO cliente con OTRO total es 409: nunca devuelve el pedido viejo como si fuera el nuevo', async () => {
    prismaMock.order.findUnique.mockResolvedValue(existing() as any) // se creó por $206.00
    const err = await createOnlineOrder(input({ expectedTotal: '150.00' }), PUEDE_CREAR).catch((e: unknown) => e)
    expect(err).toMatchObject(PEDIDO_DISTINTO)
    expect(JSON.stringify(err) + (err as Error).message).not.toContain('T'.repeat(32))
    expect(prismaMock.order.create).not.toHaveBeenCalled()
  })

  it('M-3: también cuando la repetición aparece dentro del candado o en la carrera (P2002)', async () => {
    // `quoteCart` (simulado) cotiza 206.00: el comensal confirma 206.00 y otra petición con la MISMA llave ya creó un pedido de
    // 180.00 (otro carrito). Fuera del candado aún no existía.
    const otroCarrito = {
      total: D('180.00'),
      onlineOrder: oo({ status: 'PENDING_ACCEPTANCE', requestHash: huella({ expectedTotal: '180.00' }) }),
    }
    prismaMock.order.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(existing(otroCarrito) as any)
    await expect(createOnlineOrder(input(), PUEDE_CREAR)).rejects.toMatchObject(PEDIDO_DISTINTO)
    expect(prismaMock.order.create).not.toHaveBeenCalled()

    prismaMock.order.findUnique.mockResolvedValueOnce(
      existing({ total: D('180.00'), onlineOrder: oo({ requestHash: huella({ expectedTotal: '180.00' }) }) }) as any,
    )
    ;(prismaMock.$transaction as jest.Mock).mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' }),
    )
    await expect(createOnlineOrder(input(), PUEDE_CREAR)).rejects.toMatchObject(PEDIDO_DISTINTO)
  })

  it('una carrera por la misma llave (P2002) se resuelve devolviendo al ganador del mismo cliente', async () => {
    prismaMock.order.findUnique.mockResolvedValueOnce(
      existing({
        id: 'ord9',
        orderNumber: 'WZZZZ',
        onlineOrder: oo({ id: 'oo9', status: 'PENDING_ACCEPTANCE', trackingToken: 'W'.repeat(32) }),
      }) as any,
    )
    ;(prismaMock.$transaction as jest.Mock).mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' }),
    )
    const res = await createOnlineOrder(input(), PUEDE_CREAR)
    expect(res).toMatchObject({ replay: true, orderId: 'ord9' })
  })

  it('A1: al crear guarda la huella de la solicitud (sha256 de 64 caracteres)', async () => {
    await createOnlineOrder(input(), PUEDE_CREAR)
    const data = (prismaMock.onlineOrder.create.mock.calls[0][0] as any).data
    expect(data.requestHash).toMatch(/^[0-9a-f]{64}$/)
    expect(data.requestHash).toBe(huella())
  })

  it('A1: la huella cambia con el carrito, la cantidad, las opciones, la nota, el total, el cliente y el negocio; no con el orden de las opciones', () => {
    const base = huella()
    const dos = (mods: any[]) => huella({ items: [{ productId: 'p1', quantity: 2, modifiers: mods }] })
    expect(dos([{ modifierId: 'm2' }])).toBe(base)
    expect(dos([{ modifierId: 'm2', quantity: 1 }])).toBe(base) // sin cantidad = 1
    expect(dos([{ modifierId: 'm2' }, { modifierId: 'm1' }])).toBe(dos([{ modifierId: 'm1' }, { modifierId: 'm2' }]))
    expect(huella({ items: [{ productId: 'p1', quantity: 2, modifiers: [{ modifierId: 'm2' }], note: '  sin crema ' }] })).toBe(
      huella({ items: [{ productId: 'p1', quantity: 2, modifiers: [{ modifierId: 'm2' }], note: 'sin crema' }] }),
    )
    const distintas = [
      huella({ items: [{ productId: 'p2', quantity: 2, modifiers: [{ modifierId: 'm2' }] }] }),
      huella({ items: [{ productId: 'p1', quantity: 3, modifiers: [{ modifierId: 'm2' }] }] }),
      dos([{ modifierId: 'm3' }]),
      dos([{ modifierId: 'm2', quantity: 2 }]),
      huella({ items: [{ productId: 'p1', quantity: 2, modifiers: [{ modifierId: 'm2' }], note: 'sin cebolla' }] }),
      huella({ expectedTotal: '150.00' }),
      huella({ customerId: 'cust2' }),
      huella({ customer: { name: 'Otra persona', phone: '55 4345 3965', email: null } }),
      huella({ venueId: 'v2' }),
    ]
    for (const h of distintas) expect(h).not.toBe(base)
    expect(new Set(distintas).size).toBe(distintas.length)
  })

  it('A1: la misma llave del MISMO cliente con OTRO carrito del MISMO total es 409: compara la solicitud, no el total', async () => {
    const otroPlatillo = huella({ items: [{ productId: 'p2', quantity: 2, modifiers: [{ modifierId: 'm2' }] }] })
    prismaMock.order.findUnique.mockResolvedValue(existing({ onlineOrder: oo({ requestHash: otroPlatillo }) }) as any)
    const err = await createOnlineOrder(input(), PUEDE_CREAR).catch((e: unknown) => e)
    expect(err).toMatchObject(PEDIDO_DISTINTO)
    expect(JSON.stringify(err) + (err as Error).message).not.toContain('T'.repeat(32))
    expect(prismaMock.order.create).not.toHaveBeenCalled()
  })

  it('A1: el reintento IDÉNTICO recibe su pedido aunque la caja ya haya cambiado el total de la cuenta', async () => {
    prismaMock.order.findUnique.mockResolvedValue(existing({ total: D('250.00') }) as any)
    const res = await createOnlineOrder(input(), PUEDE_CREAR)
    expect(res).toMatchObject({ replay: true, orderId: 'ord1', trackingToken: 'T'.repeat(32) })
    expect(prismaMock.order.create).not.toHaveBeenCalled()
  })

  it('A1: un pedido guardado SIN huella se trata como solicitud distinta (409), también dentro del candado y en la carrera', async () => {
    const sinHuella = existing({ onlineOrder: oo({ requestHash: null }) })
    prismaMock.order.findUnique.mockResolvedValueOnce(sinHuella as any)
    await expect(createOnlineOrder(input(), PUEDE_CREAR)).rejects.toMatchObject(PEDIDO_DISTINTO)
    prismaMock.order.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(sinHuella as any)
    await expect(createOnlineOrder(input(), PUEDE_CREAR)).rejects.toMatchObject(PEDIDO_DISTINTO)
    prismaMock.order.findUnique.mockResolvedValueOnce(sinHuella as any)
    ;(prismaMock.$transaction as jest.Mock).mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' }),
    )
    await expect(createOnlineOrder(input(), PUEDE_CREAR)).rejects.toMatchObject(PEDIDO_DISTINTO)
    expect(prismaMock.order.create).not.toHaveBeenCalled()
  })

  it('con la tienda no abierta responde 409 con el estado y el motivo', async () => {
    ;(getAcceptingStatus as jest.Mock).mockResolvedValue({ ...OPEN, status: 'OFFLINE', reason: 'NO_DEVICE' })
    await expect(createOnlineOrder(input(), PUEDE_CREAR)).rejects.toMatchObject({
      statusCode: 409,
      code: 'ORDERING_OFFLINE',
      details: { status: 'OFFLINE', reason: 'NO_DEVICE' },
    })
  })

  it('R47: sin sesión de cliente, en «Mi equipo», es 401 PHONE_VERIFICATION_REQUIRED (R6) leyendo SÓLO el modo de la tienda: ni plan, ni tienda, ni la llave, ni una fila de rechazo', async () => {
    const assertCanCreate = jest.fn(async () => {})
    await expect(createOnlineOrder(input({ customerId: null }), { assertCanCreate })).rejects.toMatchObject({
      statusCode: 401,
      code: 'PHONE_VERIFICATION_REQUIRED',
    })
    expect(prismaMock.onlineOrderingSettings.findUnique).toHaveBeenCalledTimes(1)
    expect(prismaMock.onlineOrderingSettings.findUnique).toHaveBeenCalledWith({ where: { venueId: 'v1' } })
    expect(assertCanCreate).not.toHaveBeenCalled()
    expect(getAcceptingStatus).not.toHaveBeenCalled()
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
    expect(prismaMock.order.findUnique).not.toHaveBeenCalled()
    expect(prismaMock.idempotencyRequest.findUnique).not.toHaveBeenCalled()
    expect(prismaMock.idempotencyRequest.create).not.toHaveBeenCalled()
    expect(prismaMock.order.create).not.toHaveBeenCalled()
  })

  it('R47: con la tienda cerrada o el plan vencido, el anónimo de «Mi equipo» sigue siendo 401 y no guarda un rechazo `anon:`', async () => {
    ;(getAcceptingStatus as jest.Mock).mockResolvedValue({ ...OPEN, status: 'CLOSED', reason: 'OUTSIDE_HOURS' })
    const vencido = { assertCanCreate: async () => Promise.reject(new ForbiddenError('Plan vencido', 'PLAN_REQUIRED')) }
    await expect(createOnlineOrder(input({ customerId: null }), vencido)).rejects.toMatchObject({ code: 'PHONE_VERIFICATION_REQUIRED' })
    await expect(createOnlineOrder(input({ customerId: null }), PUEDE_CREAR)).rejects.toMatchObject({ code: 'PHONE_VERIFICATION_REQUIRED' })
    expect(prismaMock.idempotencyRequest.create).not.toHaveBeenCalled()
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
  })

  it('con sesión probada no se lee el modo aparte: lo trae la lectura de la tienda (una sola vez)', async () => {
    await createOnlineOrder(input(), PUEDE_CREAR)
    expect(prismaMock.onlineOrderingSettings.findUnique).not.toHaveBeenCalled()
    expect(getAcceptingStatus).toHaveBeenCalledTimes(1)
  })

  it('una sesión sin teléfono verificado por WhatsApp (correo, contraseña, token viejo) es 401 (R6)', async () => {
    await expect(createOnlineOrder(input({ verifiedPhone: null }), PUEDE_CREAR)).rejects.toMatchObject({
      statusCode: 401,
      code: 'PHONE_VERIFICATION_REQUIRED',
    })
  })

  it('el teléfono del pedido debe ser el que se verificó (R6)', async () => {
    await expect(createOnlineOrder(input({ verifiedPhone: '+525511112222' }), PUEDE_CREAR)).rejects.toMatchObject({
      statusCode: 401,
      code: 'PHONE_VERIFICATION_REQUIRED',
    })
    expect(prismaMock.order.create).not.toHaveBeenCalled()
  })

  it('un carrito inválido devuelve CART_INVALID con las incidencias', async () => {
    ;(quoteCart as jest.Mock).mockResolvedValue({ ...QUOTE_OK, ok: false, issues: [{ code: 'PRODUCT_UNAVAILABLE', message: 'x' }] })
    await expect(createOnlineOrder(input(), PUEDE_CREAR)).rejects.toMatchObject({
      statusCode: 400,
      code: 'CART_INVALID',
      details: { issues: [{ code: 'PRODUCT_UNAVAILABLE', message: 'x' }] },
    })
  })

  it('si el total del servidor no es el que vio el comensal: 409 PRICE_CHANGED con la cotización nueva y nada se crea (R5)', async () => {
    await expect(createOnlineOrder(input({ expectedTotal: '200.00' }), PUEDE_CREAR)).rejects.toMatchObject({
      statusCode: 409,
      code: 'PRICE_CHANGED',
      details: { quote: { total: 206 } },
    })
    // Codex r2: se rechazó bajo el candado de la llave; al del negocio no se llegó: ni topes, ni folio, ni escrituras.
    expect((prismaMock.$executeRaw as jest.Mock).mock.calls.map(([, key]) => key)).toEqual([KEY_LOCK])
    expect(prismaMock.onlineOrder.count).not.toHaveBeenCalled()
    expect(prismaMock.order.create).not.toHaveBeenCalled()
    expect(prismaMock.onlineOrder.create).not.toHaveBeenCalled()
  })

  it('tope de pedidos por aceptar por teléfono, comparado ya normalizado (R23)', async () => {
    prismaMock.onlineOrder.count.mockResolvedValueOnce(3)
    await expect(
      createOnlineOrder(input({ verifiedPhone: '55 4345 3965', customer: { name: 'M', phone: '+52 55 4345 3965' } }), PUEDE_CREAR),
    ).rejects.toMatchObject({ code: 'TOO_MANY_PENDING_ORDERS' })
    const where = (prismaMock.onlineOrder.count.mock.calls[0][0] as any).where
    expect(where.order.customerPhone).toBe(PHONE)
  })

  it('fase 2: el tope por teléfono suma los borradores de TARJETA vigentes (un vencido no cuenta)', async () => {
    prismaMock.onlineOrderCharge.count.mockResolvedValueOnce(3)
    await expect(createOnlineOrder(input(), PUEDE_CREAR)).rejects.toMatchObject({ code: 'TOO_MANY_PENDING_ORDERS' })
    expect(prismaMock.onlineOrderCharge.count).toHaveBeenCalledWith({
      where: { venueId: 'v1', status: 'PENDING_AUTH', checkoutExpiresAt: { gt: NOW }, customerPhone: PHONE },
    })
  })

  it('fase 2: el tope del negocio suma pedidos por aceptar y borradores de tarjeta vigentes', async () => {
    prismaMock.onlineOrder.count.mockResolvedValueOnce(0).mockResolvedValueOnce(20)
    prismaMock.onlineOrderCharge.count.mockResolvedValueOnce(0).mockResolvedValueOnce(10)
    await expect(createOnlineOrder(input(), PUEDE_CREAR)).rejects.toMatchObject({ code: 'ORDERING_PAUSED' })
    expect(prismaMock.onlineOrderCharge.count).toHaveBeenLastCalledWith({
      where: { venueId: 'v1', status: 'PENDING_AUTH', checkoutExpiresAt: { gt: NOW } },
    })
  })

  it('el tope del negocio se repite dentro del candado: 409 ORDERING_PAUSED por saturación', async () => {
    prismaMock.onlineOrder.count.mockResolvedValueOnce(0).mockResolvedValueOnce(30)
    await expect(createOnlineOrder(input(), PUEDE_CREAR)).rejects.toMatchObject({
      statusCode: 409,
      code: 'ORDERING_PAUSED',
      details: { status: 'PAUSED', reason: 'TOO_BUSY' },
    })
    expect(prismaMock.order.create).not.toHaveBeenCalled()
  })

  it('un teléfono verificado en formato viejo (+521) se guarda y se topa en su forma canónica +52 (R23)', async () => {
    await createOnlineOrder(input({ verifiedPhone: '+5215543453965', customer: { name: 'M', phone: '+525543453965' } }), PUEDE_CREAR)
    const where = (prismaMock.onlineOrder.count.mock.calls[0][0] as any).where
    expect(where.order.customerPhone).toBe(PHONE)
    expect((prismaMock.order.create.mock.calls[0][0] as any).data.customerPhone).toBe(PHONE)
  })

  it('una tienda abierta que no acepta pagar al recoger responde 400 PAYMENT_MODE_NOT_ACCEPTED y no cotiza ni crea', async () => {
    ;(getAcceptingStatus as jest.Mock).mockResolvedValue({ ...OPEN, config: { ...OPEN.config, acceptsPayAtPickup: false } })
    await expect(createOnlineOrder(input(), PUEDE_CREAR)).rejects.toMatchObject({
      statusCode: 400,
      code: 'PAYMENT_MODE_NOT_ACCEPTED',
      message: 'Este negocio no acepta pagar al recoger.',
    })
    expect(quoteCart).not.toHaveBeenCalled()
    expect(prismaMock.order.create).not.toHaveBeenCalled()
  })

  describe('S8: la tienda vieja (abierta en una pestaña) muestra el texto del servidor ante un código que no conoce', () => {
    const SIN_RECOGER_CON_TARJETA = { ...OPEN, config: { ...OPEN.config, acceptsPayAtPickup: false, acceptsCardOnline: true } }
    const STRIPE = { chargesEnabled: true, providerCredentials: { connectAccountId: 'acct_1' }, provider: { code: 'STRIPE_CONNECT' } }

    it('con la tarjeta disponible (switch prendido y comercio que cobra) pide recargar para pagar con tarjeta; el código no cambia', async () => {
      ;(getAcceptingStatus as jest.Mock).mockResolvedValue(SIN_RECOGER_CON_TARJETA)
      prismaMock.ecommerceMerchant.findMany.mockResolvedValueOnce([STRIPE] as any)
      await expect(createOnlineOrder(input(), PUEDE_CREAR)).rejects.toMatchObject({
        statusCode: 400,
        code: 'PAYMENT_MODE_NOT_ACCEPTED',
        message: 'Este negocio ahora cobra con tarjeta en línea. Recarga la página para pagar con tarjeta.',
      })
      expect(prismaMock.order.create).not.toHaveBeenCalled()
    })

    it('con el switch prendido pero sin comercio que cobre, o con el switch apagado, el texto de hoy', async () => {
      ;(getAcceptingStatus as jest.Mock).mockResolvedValue(SIN_RECOGER_CON_TARJETA)
      prismaMock.ecommerceMerchant.findMany.mockResolvedValueOnce([{ ...STRIPE, chargesEnabled: false }] as any)
      await expect(createOnlineOrder(input(), PUEDE_CREAR)).rejects.toMatchObject({
        code: 'PAYMENT_MODE_NOT_ACCEPTED',
        message: 'Este negocio no acepta pagar al recoger.',
      })
      ;(getAcceptingStatus as jest.Mock).mockResolvedValue({
        ...OPEN,
        config: { ...OPEN.config, acceptsPayAtPickup: false, acceptsCardOnline: false },
      })
      prismaMock.ecommerceMerchant.findMany.mockClear()
      await expect(createOnlineOrder(input(), PUEDE_CREAR)).rejects.toMatchObject({
        code: 'PAYMENT_MODE_NOT_ACCEPTED',
        message: 'Este negocio no acepta pagar al recoger.',
      })
      expect(prismaMock.ecommerceMerchant.findMany).not.toHaveBeenCalled()
    })
  })

  it('el candado se toma en la transacción ANTES de los topes, el folio y las escrituras, y todo eso corre en la transacción (R4)', async () => {
    const tx = {
      $executeRaw: jest.fn().mockResolvedValue(0),
      order: {
        findUnique: jest.fn().mockResolvedValue(null),
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'ord1', orderNumber: 'WABCD' }),
      },
      onlineOrder: {
        count: jest.fn().mockResolvedValue(0),
        create: jest.fn().mockImplementation(async (a: any) => ({ id: 'oo1', ...a.data })),
      },
      customer: { findFirst: jest.fn().mockResolvedValue(null), update: jest.fn() }, // S3: el nombre se completa en la misma transacción
      idempotencyRequest: { findUnique: jest.fn().mockResolvedValue(null), create: jest.fn() }, // Codex r3
      onlineOrderCharge: { findUnique: jest.fn().mockResolvedValue(null), count: jest.fn().mockResolvedValue(0) }, // Codex r2 #5 y topes
    }
    ;(prismaMock.$transaction as jest.Mock).mockImplementationOnce(async (fn: any) => fn(tx))

    await createOnlineOrder(input(), PUEDE_CREAR)

    expect(tx.$executeRaw.mock.calls.map(([, key]: any[]) => key)).toEqual([KEY_LOCK, ADMISSION_LOCK])
    const [keyAt, lockAt] = tx.$executeRaw.mock.invocationCallOrder
    // Codex r4: plan, tienda y cotización ANTES de abrir la transacción; dentro, la llave antes que todo y el negocio antes de topes,
    // folio y escrituras.
    expect((quoteCart as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(keyAt)
    expect(keyAt).toBeLessThan(tx.order.findUnique.mock.invocationCallOrder[0])
    expect(tx.onlineOrder.count).toHaveBeenCalledTimes(2)
    for (const later of [
      tx.order.findUnique.mock.invocationCallOrder[1],
      ...tx.onlineOrder.count.mock.invocationCallOrder,
      tx.order.findFirst.mock.invocationCallOrder[0],
      tx.order.create.mock.invocationCallOrder[0],
      tx.onlineOrder.create.mock.invocationCallOrder[0],
    ]) {
      expect(lockAt).toBeLessThan(later)
    }
    // Nada de la admisión corre en el cliente raíz (fuera de los candados), tampoco la repetición.
    expect(prismaMock.$executeRaw).not.toHaveBeenCalled()
    expect(prismaMock.onlineOrder.count).not.toHaveBeenCalled()
    expect(prismaMock.order.findFirst).not.toHaveBeenCalled()
    expect(prismaMock.order.create).not.toHaveBeenCalled()
    expect(prismaMock.onlineOrder.create).not.toHaveBeenCalled()
    expect(prismaMock.order.findUnique).not.toHaveBeenCalled()
  })

  it('una carrera (P2002) cuyo ganador es de OTRO cliente es 409 IDEMPOTENCY_KEY_CONFLICT sin su token (R8)', async () => {
    prismaMock.order.findUnique.mockResolvedValueOnce(
      existing({
        id: 'ord9',
        customerId: 'otro-cliente',
        onlineOrder: oo({
          id: 'oo9',
          status: 'PENDING_ACCEPTANCE',
          trackingToken: 'W'.repeat(32),
          requestHash: huella({ customerId: 'otro-cliente' }),
        }),
      }) as any,
    )
    ;(prismaMock.$transaction as jest.Mock).mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' }),
    )
    const err = await createOnlineOrder(input(), PUEDE_CREAR).catch((e: unknown) => e)
    expect(err).toMatchObject({ statusCode: 409, code: 'IDEMPOTENCY_KEY_CONFLICT' })
    expect(JSON.stringify(err) + (err as Error).message).not.toContain('W'.repeat(32))
  })
})

describe('P1-06: plan y negocio operativo se exigen sólo a un pedido NUEVO; su rechazo se decide después de buscar la repetición', () => {
  const SIN_PLAN = new ForbiddenError('Este negocio no recibe pedidos en línea por el momento.', 'PLAN_REQUIRED')

  it('una repetición recibe SU pedido aunque assertCanCreate rechace (plan vencido o negocio que ya no opera), sin guardar el rechazo', async () => {
    prismaMock.order.findUnique.mockResolvedValue(existing() as any)
    const assertCanCreate = jest.fn().mockRejectedValue(SIN_PLAN)
    const res = await createOnlineOrder(input(), { assertCanCreate })
    expect(res).toMatchObject({ replay: true, orderId: 'ord1', trackingToken: 'T'.repeat(32), status: 'ACCEPTED' })
    expect(prismaMock.idempotencyRequest.create).not.toHaveBeenCalled()
    expect(prismaMock.order.create).not.toHaveBeenCalled()
  })

  it('un pedido NUEVO corre assertCanCreate ANTES de mirar la tienda; su rechazo se decide DESPUÉS de buscar la repetición y no crea nada', async () => {
    const assertCanCreate = jest.fn().mockRejectedValue(SIN_PLAN)
    const err = await createOnlineOrder(input(), { assertCanCreate }).catch((e: unknown) => e)
    expect(err).toBe(SIN_PLAN)
    expect(assertCanCreate.mock.invocationCallOrder[0]).toBeLessThan(prismaMock.order.findUnique.mock.invocationCallOrder[0])
    expect(getAcceptingStatus).not.toHaveBeenCalled()
    expect(quoteCart).not.toHaveBeenCalled()
    expect(prismaMock.order.create).not.toHaveBeenCalled()
  })

  it('con assertCanCreate que pasa, se crea el pedido (y corrió antes de mirar la tienda)', async () => {
    const assertCanCreate = jest.fn().mockResolvedValue(undefined)
    await expect(createOnlineOrder(input(), { assertCanCreate })).resolves.toMatchObject({ replay: false, status: 'PENDING_ACCEPTANCE' })
    expect(assertCanCreate).toHaveBeenCalledTimes(1)
    expect(assertCanCreate.mock.invocationCallOrder[0]).toBeLessThan((getAcceptingStatus as jest.Mock).mock.invocationCallOrder[0])
    expect(prismaMock.order.create).toHaveBeenCalledTimes(1)
  })
})

describe('Codex r2 (antes R2-2): ningún rechazo se adelanta a un envío vivo de la misma llave', () => {
  /** Cada rechazo previo al candado del negocio: [nombre, code, preparar → opciones]. */
  const pasa = () => ({ assertCanCreate: jest.fn().mockResolvedValue(undefined) })
  const RECHAZOS: Array<[string, string, () => CreateOnlineOrderOptions]> = [
    [
      'plan (assertCanCreate)',
      'PLAN_REQUIRED',
      () => ({ assertCanCreate: jest.fn().mockRejectedValue(new ForbiddenError('x', 'PLAN_REQUIRED')) }),
    ],
    [
      'tienda cerrada',
      'ORDERING_CLOSED',
      () => {
        ;(getAcceptingStatus as jest.Mock).mockResolvedValue({ ...OPEN, status: 'CLOSED', reason: 'OUTSIDE_HOURS' })
        return pasa()
      },
    ],
    [
      'sin pagar al recoger',
      'PAYMENT_MODE_NOT_ACCEPTED',
      () => {
        ;(getAcceptingStatus as jest.Mock).mockResolvedValue({ ...OPEN, config: { ...OPEN.config, acceptsPayAtPickup: false } })
        return pasa()
      },
    ],
    [
      'carta inválida',
      'CART_INVALID',
      () => {
        ;(quoteCart as jest.Mock).mockResolvedValue({ ...QUOTE_OK, ok: false, issues: [{ code: 'PRODUCT_UNAVAILABLE', message: 'x' }] })
        return pasa()
      },
    ],
    [
      'precio cambiado',
      'PRICE_CHANGED',
      () => {
        ;(quoteCart as jest.Mock).mockResolvedValue({ ...QUOTE_OK, total: D('210.00') })
        return pasa()
      },
    ],
  ]

  it.each(RECHAZOS)(
    '%s: se lee fuera y se decide bajo el candado de la llave, DESPUÉS de buscar la repetición; sin pedido se mantiene y no se crea nada',
    async (_n, code, preparar) => {
      const opts = preparar()
      await expect(createOnlineOrder(input(), opts)).rejects.toMatchObject({ code })
      const raw = prismaMock.$executeRaw as jest.Mock
      expect(raw.mock.calls.map(([, key]) => key)).toEqual([KEY_LOCK]) // al candado del negocio no se llega
      expect((opts.assertCanCreate as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(raw.mock.invocationCallOrder[0])
      expect(raw.mock.invocationCallOrder[0]).toBeLessThan(prismaMock.order.findUnique.mock.invocationCallOrder[0])
      expect(prismaMock.order.findUnique).toHaveBeenCalledTimes(1)
      expect(prismaMock.onlineOrder.count).not.toHaveBeenCalled()
      expect(prismaMock.order.create).not.toHaveBeenCalled()
    },
  )

  it.each(RECHAZOS)(
    '%s: si el envío vivo ya creó SU pedido cuando suelta la llave, responde la repetición y no guarda el rechazo',
    async (_n, _code, preparar) => {
      const opts = preparar()
      prismaMock.order.findUnique.mockResolvedValue(existing({ onlineOrder: oo({ status: 'PENDING_ACCEPTANCE' }) }) as any)
      const res = await createOnlineOrder(input(), opts)
      expect(res).toMatchObject({ replay: true, orderId: 'ord1', trackingToken: 'T'.repeat(32), status: 'PENDING_ACCEPTANCE' })
      expect(prismaMock.idempotencyRequest.create).not.toHaveBeenCalled()
      expect(prismaMock.order.create).not.toHaveBeenCalled()
      expect(socketManager.broadcastToVenue).not.toHaveBeenCalled()
    },
  )

  it('el candado de la llave, la repetición y el rechazo van en la MISMA transacción, y el candado se toma ANTES de buscar', async () => {
    ;(getAcceptingStatus as jest.Mock).mockResolvedValue({ ...OPEN, status: 'CLOSED', reason: 'OUTSIDE_HOURS' })
    const tx = {
      $executeRaw: jest.fn().mockResolvedValue(0),
      order: { findUnique: jest.fn().mockResolvedValue(null) },
      idempotencyRequest: { findUnique: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue({}) },
      onlineOrderCharge: { findUnique: jest.fn().mockResolvedValue(null) }, // Codex r2 #5
    }
    ;(prismaMock.$transaction as jest.Mock).mockImplementationOnce(async (fn: any) => fn(tx))
    await expect(createOnlineOrder(input(), PUEDE_CREAR)).rejects.toMatchObject({ code: 'ORDERING_CLOSED' })
    const [strings, key] = tx.$executeRaw.mock.calls[0]
    expect((strings as string[]).join('?')).toContain('pg_advisory_xact_lock(hashtext(?))')
    expect(key).toBe(KEY_LOCK)
    expect((getAcceptingStatus as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(tx.$executeRaw.mock.invocationCallOrder[0])
    expect(tx.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(tx.order.findUnique.mock.invocationCallOrder[0])
    expect(prismaMock.order.findUnique).not.toHaveBeenCalled() // nada se busca fuera del candado
    // Codex r3: el rechazo se busca y se guarda en ESA transacción, después de la repetición.
    expect(tx.order.findUnique.mock.invocationCallOrder[0]).toBeLessThan(tx.idempotencyRequest.findUnique.mock.invocationCallOrder[0])
    expect(tx.idempotencyRequest.create).toHaveBeenCalledTimes(1)
    expect(prismaMock.idempotencyRequest.create).not.toHaveBeenCalled()
  })

  it('🔴 si la transacción no arranca o vence esperando la llave (P2028), sale ESE error (5xx reintentable), nunca ORDERING_CLOSED', async () => {
    // Sin el candado no se sabe si el envío vivo quedó: un 409 definitivo haría que la tienda olvide un pedido que sí existe.
    ;(getAcceptingStatus as jest.Mock).mockResolvedValue({ ...OPEN, status: 'CLOSED', reason: 'OUTSIDE_HOURS' })
    const caida = new Prisma.PrismaClientKnownRequestError('Transaction API error: Unable to start a transaction in the given time.', {
      code: 'P2028',
      clientVersion: 'x',
    })
    ;(prismaMock.$transaction as jest.Mock).mockRejectedValueOnce(caida)
    const err = await createOnlineOrder(input(), PUEDE_CREAR).catch((e: unknown) => e)
    expect(err).toBe(caida)
    expect(err).not.toHaveProperty('statusCode') // el controlador lo responde como 5xx genérico, no como rechazo
    expect(getAcceptingStatus).toHaveBeenCalledTimes(1) // Codex r4: se leyó fuera, pero sin la llave no se decide nada
    expect(prismaMock.order.create).not.toHaveBeenCalled()
  })

  it('si bajo la llave aparece OTRA solicitud con esa llave, es 409 IDEMPOTENCY_KEY_CONFLICT, no el rechazo', async () => {
    ;(getAcceptingStatus as jest.Mock).mockResolvedValue({ ...OPEN, status: 'CLOSED', reason: 'OUTSIDE_HOURS' })
    prismaMock.order.findUnique.mockResolvedValueOnce(
      existing({ onlineOrder: oo({ requestHash: huella({ expectedTotal: '180.00' }) }) }) as any,
    )
    await expect(createOnlineOrder(input(), PUEDE_CREAR)).rejects.toMatchObject({ statusCode: 409, code: 'IDEMPOTENCY_KEY_CONFLICT' })
  })

  it('R47: un 401 PHONE_VERIFICATION_REQUIRED no abre transacción ni toma la llave, y no se guarda', async () => {
    await expect(createOnlineOrder(input({ verifiedPhone: null }), PUEDE_CREAR)).rejects.toMatchObject({
      code: 'PHONE_VERIFICATION_REQUIRED',
    })
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
    expect(prismaMock.$executeRaw).not.toHaveBeenCalled()
    expect(prismaMock.idempotencyRequest.create).not.toHaveBeenCalled() // la tienda pide el código y reintenta con la MISMA llave
    expect(prismaMock.order.create).not.toHaveBeenCalled()
  })

  it('R47 (T7 a): el reintento SIN sesión de un pedido que nació CON sesión es 401, no 409 IDEMPOTENCY_KEY_CONFLICT', async () => {
    prismaMock.order.findUnique.mockResolvedValue(existing() as any) // su pedido, con la huella de la sesión
    await expect(createOnlineOrder(input({ customerId: null, verifiedPhone: null }), PUEDE_CREAR)).rejects.toMatchObject({
      statusCode: 401,
      code: 'PHONE_VERIFICATION_REQUIRED',
    })
  })

  describe('Codex r3: la primera decisión sobre una llave es durable (un envío tardío recibe el mismo rechazo)', () => {
    const LLAVE_GUARDADA = {
      organizationId_actorStaffId_endpoint_idempotencyKey: {
        organizationId: 'venue:v1',
        actorStaffId: 'customer:cust1',
        endpoint: 'POST /public/ordering/orders',
        idempotencyKey: KEY,
      },
    }
    const ADMISION: Array<[string, string, () => CreateOnlineOrderOptions]> = [
      [
        'tope por teléfono',
        'TOO_MANY_PENDING_ORDERS',
        () => {
          prismaMock.onlineOrder.count.mockResolvedValueOnce(3)
          return pasa()
        },
      ],
      [
        'saturación del negocio',
        'ORDERING_PAUSED',
        () => {
          prismaMock.onlineOrder.count.mockResolvedValueOnce(0).mockResolvedValueOnce(30)
          return pasa()
        },
      ],
    ]

    it.each([...RECHAZOS, ...ADMISION])(
      '%s: el rechazo se GUARDA en la misma transacción, que confirma, y sale el MISMO error después',
      async (_n, code, preparar) => {
        const err = (await createOnlineOrder(input(), preparar()).catch((e: unknown) => e)) as AppError
        expect(err).toMatchObject({ code })
        const create = prismaMock.idempotencyRequest.create as jest.Mock
        expect(create).toHaveBeenCalledTimes(1)
        const { data } = create.mock.calls[0][0]
        expect(data).toEqual({
          ...LLAVE_GUARDADA.organizationId_actorStaffId_endpoint_idempotencyKey,
          requestHash: huella(),
          responseStatus: err.statusCode,
          responseBody: JSON.parse(JSON.stringify({ code, message: err.message, details: err.details })),
          expiresAt: new Date(NOW.getTime() + 24 * 3600_000),
        })
        // La transacción CONFIRMÓ (devolvió la decisión, no la lanzó): el rechazo queda.
        await expect((prismaMock.$transaction as jest.Mock).mock.results[0].value).resolves.toBe(err)
        expect(prismaMock.order.create).not.toHaveBeenCalled()
        expect(socketManager.broadcastToVenue).not.toHaveBeenCalled()
      },
    )

    it('una llave con un rechazo guardado responde ESE rechazo (status, code, mensaje y details) aunque plan, tienda y cotización ya pasen', async () => {
      const details = { status: 'PAUSED', reason: 'MANUAL_PAUSE' }
      ;(prismaMock.idempotencyRequest.findUnique as jest.Mock).mockResolvedValue({
        requestHash: huella(),
        responseStatus: 409,
        responseBody: { code: 'ORDERING_PAUSED', message: 'La tienda no está recibiendo pedidos en este momento.', details },
      })
      const assertCanCreate = jest.fn()
      const err = await createOnlineOrder(input(), { assertCanCreate }).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(AppError)
      expect(err).toMatchObject({
        statusCode: 409,
        code: 'ORDERING_PAUSED',
        message: 'La tienda no está recibiendo pedidos en este momento.',
        details,
      })
      expect(prismaMock.idempotencyRequest.findUnique).toHaveBeenCalledWith({ where: LLAVE_GUARDADA })
      // Bajo la llave y DESPUÉS de buscar la repetición (un pedido ya creado siempre gana).
      expect((prismaMock.$executeRaw as jest.Mock).mock.calls.map(([, k]) => k)).toEqual([KEY_LOCK])
      expect(prismaMock.order.findUnique.mock.invocationCallOrder[0]).toBeLessThan(
        (prismaMock.idempotencyRequest.findUnique as jest.Mock).mock.invocationCallOrder[0],
      )
      expect(prismaMock.order.create).not.toHaveBeenCalled()
      expect(prismaMock.idempotencyRequest.create).not.toHaveBeenCalled()
    })

    it('un rechazo guardado con OTRA solicitud (otra huella) es 409 IDEMPOTENCY_KEY_CONFLICT y tampoco crea', async () => {
      ;(prismaMock.idempotencyRequest.findUnique as jest.Mock).mockResolvedValue({
        requestHash: huella({ expectedTotal: '180.00' }),
        responseStatus: 409,
        responseBody: { code: 'ORDERING_PAUSED', message: 'x' },
      })
      await expect(createOnlineOrder(input(), PUEDE_CREAR)).rejects.toMatchObject({ statusCode: 409, code: 'IDEMPOTENCY_KEY_CONFLICT' })
      expect(prismaMock.order.create).not.toHaveBeenCalled()
    })

    const NO_DEFINITIVOS: Array<[string, Error]> = [
      ['503 (no se pudo verificar el plan)', new ServiceUnavailableError('x', 'FEATURE_CHECK_UNAVAILABLE')],
      ['500 de la casa', new AppError('x', 500)],
      ['401', new UnauthorizedError('x', 'X')],
      ['408', new AppError('x', 408, true, 'X')],
      ['429', new AppError('x', 429, true, 'RATE_LIMIT_EXCEEDED')],
      ['un error sin status', new Error('x')],
      ['un error de Prisma', new Prisma.PrismaClientKnownRequestError('x', { code: 'P1001', clientVersion: 'x' })],
    ]
    it.each(NO_DEFINITIVOS)(
      '%s: NO se guarda ni abre transacción y sale ese error, sin final (la tienda conserva la llave)',
      async (_n, caida) => {
        const err = await createOnlineOrder(input(), { assertCanCreate: jest.fn().mockRejectedValue(caida) }).catch((e: unknown) => e)
        expect(err).toBe(caida)
        expect(err).not.toHaveProperty('final')
        expect(prismaMock.$transaction).not.toHaveBeenCalled()
      },
    )

    it('un error no definitivo DENTRO de la transacción de crear (al contar los topes) la deshace sin guardar nada', async () => {
      const caida = new Prisma.PrismaClientKnownRequestError('x', { code: 'P1001', clientVersion: 'x' })
      prismaMock.onlineOrder.count.mockRejectedValueOnce(caida)
      await expect(createOnlineOrder(input(), PUEDE_CREAR).catch((e: unknown) => e)).resolves.toBe(caida)
      expect(prismaMock.idempotencyRequest.create).not.toHaveBeenCalled()
      await expect((prismaMock.$transaction as jest.Mock).mock.results[0].value).rejects.toBe(caida)
    })

    it('si guardar el rechazo falla, sale ESE error (5xx), nunca el 4xx: sin decisión durable la tienda no suelta la llave', async () => {
      ;(getAcceptingStatus as jest.Mock).mockResolvedValue({ ...OPEN, status: 'PAUSED', reason: 'MANUAL_PAUSE' })
      const caida = new Prisma.PrismaClientKnownRequestError('x', { code: 'P1001', clientVersion: 'x' })
      ;(prismaMock.idempotencyRequest.create as jest.Mock).mockRejectedValue(caida)
      await expect(createOnlineOrder(input(), PUEDE_CREAR).catch((e: unknown) => e)).resolves.toBe(caida)
    })
  })
})

describe('Codex r4: una sola conexión por envío, y la decisión durable sale marcada (final)', () => {
  /**
   * La transacción de crear retiene SU conexión: si dentro se leyera con el cliente raíz (otra conexión del pool), una ráfaga del
   * tamaño del pool se atascaría esperando conexiones que nadie suelta. `lectura` anota si se llamó con la transacción abierta.
   */
  const vigilarTransaccion = () => {
    let abierta = false
    const leidasDentro: string[] = []
    ;(prismaMock.$transaction as jest.Mock).mockImplementation(async (fn: any) => {
      abierta = true
      try {
        return await fn(prismaMock)
      } finally {
        abierta = false
      }
    })
    const lectura = (nombre: string, valor: unknown) =>
      jest.fn(async () => {
        if (abierta) leidasDentro.push(nombre)
        return valor
      }) as any
    return { leidasDentro, lectura }
  }

  it('al crear: plan, tienda y cotización se leen con la transacción CERRADA (una conexión a la vez)', async () => {
    const { leidasDentro, lectura } = vigilarTransaccion()
    ;(getAcceptingStatus as jest.Mock).mockImplementation(lectura('tienda', OPEN))
    ;(quoteCart as jest.Mock).mockImplementation(lectura('cotización', QUOTE_OK))
    await expect(createOnlineOrder(input(), { assertCanCreate: lectura('plan', undefined) })).resolves.toMatchObject({ replay: false })
    expect(leidasDentro).toEqual([])
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1)
    expect(prismaMock.order.create).toHaveBeenCalledTimes(1)
  })

  it('al rechazar: las lecturas van ANTES y la transacción corta sólo toma la llave, busca la repetición y guarda', async () => {
    const { leidasDentro, lectura } = vigilarTransaccion()
    ;(getAcceptingStatus as jest.Mock).mockImplementation(lectura('tienda', { ...OPEN, status: 'PAUSED', reason: 'MANUAL_PAUSE' }))
    const err = await createOnlineOrder(input(), { assertCanCreate: lectura('plan', undefined) }).catch((e: unknown) => e)
    expect(err).toMatchObject({ statusCode: 409, code: 'ORDERING_PAUSED', final: true })
    expect(leidasDentro).toEqual([])
    expect((prismaMock.$executeRaw as jest.Mock).mock.calls.map(([, k]) => k)).toEqual([KEY_LOCK])
    expect(prismaMock.order.findUnique).toHaveBeenCalledTimes(1)
    expect(prismaMock.idempotencyRequest.create).toHaveBeenCalledTimes(1)
    expect(prismaMock.order.create).not.toHaveBeenCalled()
  })

  it('S2: el rechazo recién guardado, el repetido desde la tabla y la llave de otro pedido salen con final:true', async () => {
    ;(getAcceptingStatus as jest.Mock).mockResolvedValueOnce({ ...OPEN, status: 'CLOSED', reason: 'OUTSIDE_HOURS' })
    await expect(createOnlineOrder(input(), PUEDE_CREAR)).rejects.toMatchObject({ code: 'ORDERING_CLOSED', final: true })

    prismaMock.onlineOrder.count.mockResolvedValueOnce(3) // tope por teléfono: se decide dentro de la transacción de crear
    await expect(createOnlineOrder(input(), PUEDE_CREAR)).rejects.toMatchObject({ code: 'TOO_MANY_PENDING_ORDERS', final: true })
    ;(prismaMock.idempotencyRequest.findUnique as jest.Mock).mockResolvedValueOnce({
      requestHash: huella(),
      responseStatus: 409,
      responseBody: { code: 'ORDERING_PAUSED', message: 'La tienda no está recibiendo pedidos en este momento.' },
    })
    await expect(createOnlineOrder(input(), PUEDE_CREAR)).rejects.toMatchObject({ code: 'ORDERING_PAUSED', final: true })
    ;(prismaMock.idempotencyRequest.findUnique as jest.Mock).mockResolvedValueOnce({
      requestHash: huella({ expectedTotal: '180.00' }),
      responseStatus: 409,
      responseBody: { code: 'ORDERING_PAUSED', message: 'x' },
    })
    await expect(createOnlineOrder(input(), PUEDE_CREAR)).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_CONFLICT', final: true })

    prismaMock.order.findUnique.mockResolvedValueOnce(
      existing({ customerId: 'otro-cliente', onlineOrder: oo({ requestHash: huella({ customerId: 'otro-cliente' }) }) }) as any,
    )
    await expect(createOnlineOrder(input(), PUEDE_CREAR)).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_CONFLICT', final: true })
  })
})

describe('Tienda híbrida T7: pedir en «Nadie» (nombre, folio, plazo y repetición primero)', () => {
  const NADIE = { ...OPEN, config: { ...OPEN.config, requiresAcceptance: false, hours: null } }
  const MI_EQUIPO = { ...OPEN, config: { ...OPEN.config, requiresAcceptance: true, hours: null } }
  /** La clienta de «Nadie»: sin sesión ni teléfono, sólo su nombre; llegó por el QR. */
  const anon = (o: Record<string, unknown> = {}) =>
    input({ customerId: null, verifiedPhone: null, customer: { name: 'María G.', email: null }, channel: 'QR', ...o })
  /** La huella anónima: cliente '' y teléfono ''. */
  const huellaAnon = (o: Record<string, unknown> = {}) =>
    onlineOrderRequestHash({
      venueId: 'v1',
      customerId: '',
      paymentMode: 'PAY_AT_PICKUP',
      expectedTotal: '206.00',
      items: input().items,
      customerName: 'María G.',
      customerPhone: '',
      ...o,
    })
  const LLAVE_ANON = {
    organizationId: 'venue:v1',
    actorStaffId: `anon:${KEY}`,
    endpoint: 'POST /public/ordering/orders',
    idempotencyKey: KEY,
  }
  const dia = { enabled: true, ranges: [{ open: '09:00', close: '21:00' }] }
  const HORARIO = { monday: dia, tuesday: dia, wednesday: dia, thursday: dia, friday: dia, saturday: dia, sunday: dia }

  beforeEach(() => {
    ;(getAcceptingStatus as jest.Mock).mockResolvedValue(NADIE)
    prismaMock.onlineOrderingSettings.findUnique.mockResolvedValue({ requiresAcceptance: false })
  })
  /** El negocio pasa a «Mi equipo»: lo dicen su fila de ajustes (R47) y la lectura de la tienda. */
  const aMiEquipo = () => {
    ;(getAcceptingStatus as jest.Mock).mockResolvedValue(MI_EQUIPO)
    prismaMock.onlineOrderingSettings.findUnique.mockResolvedValue({ requiresAcceptance: true })
  }

  it('en «Nadie», sin sesión ni teléfono, crea el folio con customerId null, sin teléfono, requiresAcceptance false y channel QR', async () => {
    const res = await createOnlineOrder(anon(), PUEDE_CREAR)

    expect(res).toMatchObject({ replay: false, status: 'PENDING_ACCEPTANCE', orderNumber: expect.any(String), total: '206.00' })
    const order = (prismaMock.order.create.mock.calls[0][0] as any).data
    expect(order).toMatchObject({ customerId: null, customerPhone: null, customerName: 'María G.' })
    const online = (prismaMock.onlineOrder.create.mock.calls[0][0] as any).data
    expect(online).toMatchObject({ requiresAcceptance: false, channel: 'QR', paymentMode: 'PAY_AT_PICKUP' })
    expect(online.requestHash).toBe(huellaAnon()) // la huella anónima usa customerId ''
    // Sin horario no hay cierre (R23): el plazo es sólo +30 min.
    expect(new Date(res.acceptDeadlineAt).getTime()).toBe(NOW.getTime() + 30 * 60_000)
    // Sin teléfono no hay tope por teléfono: sólo la saturación de «Mi equipo» y el tope de folios.
    const wheres = prismaMock.onlineOrder.count.mock.calls.map(([a]: any[]) => a.where)
    expect(wheres.some((w: any) => w.order?.customerPhone !== undefined)).toBe(false)
    expect(wheres).toContainEqual({
      venueId: 'v1',
      status: 'PENDING_ACCEPTANCE',
      requiresAcceptance: false,
      order: { paymentStatus: 'PENDING' },
    })
    expect(prismaMock.onlineOrderCharge.count).not.toHaveBeenCalledWith({
      where: expect.objectContaining({ customerPhone: expect.anything() }),
    })
  })

  it('el plazo es min(ahora + 30 min, cierre) en la zona del NEGOCIO: a las 20:50 con cierre 21:00 ⇒ 21:00; a las 10:00 ⇒ 10:30', async () => {
    ;(getAcceptingStatus as jest.Mock).mockResolvedValue({ ...NADIE, config: { ...NADIE.config, hours: HORARIO } })
    // Cancún es UTC-5 todo el año: si se usara la zona de CDMX (UTC-6), 20:50 de Cancún serían 19:50 y el plazo saldría 21:20.
    prismaMock.venue.findUnique.mockResolvedValueOnce({ timezone: 'America/Cancun' } as any)
    const tarde = await createOnlineOrder(anon({ now: new Date('2026-10-15T01:50:00.000Z') }), PUEDE_CREAR)
    expect(tarde.acceptDeadlineAt).toBe('2026-10-15T02:00:00.000Z') // 21:00 de Cancún
    expect(prismaMock.venue.findUnique).toHaveBeenCalledWith({ where: { id: 'v1' }, select: { timezone: true } })

    prismaMock.venue.findUnique.mockResolvedValueOnce({ timezone: 'America/Cancun' } as any)
    const temprano = await createOnlineOrder(
      anon({ now: new Date('2026-10-14T15:00:00.000Z'), idempotencyKey: 'q'.repeat(32) }),
      PUEDE_CREAR,
    )
    expect(temprano.acceptDeadlineAt).toBe('2026-10-14T15:30:00.000Z') // 10:30 de Cancún
    // Lo que se guarda es ese plazo (no se recalcula después).
    expect((prismaMock.onlineOrder.create.mock.calls[1][0] as any).data.acceptDeadlineAt.toISOString()).toBe('2026-10-14T15:30:00.000Z')
  })

  it('R45: en la hora repetida de Tijuana (01:30 PST, 2.ª vez) el plazo es el cierre de las 01:45 que viene (09:45Z), nunca uno ya pasado', async () => {
    const madrugada = { ...HORARIO, sunday: { enabled: true, ranges: [{ open: '00:00', close: '01:45' }] } }
    ;(getAcceptingStatus as jest.Mock).mockResolvedValue({ ...NADIE, config: { ...NADIE.config, hours: madrugada } })
    prismaMock.venue.findUnique.mockResolvedValueOnce({ timezone: 'America/Tijuana' } as any)
    const r = await createOnlineOrder(anon({ now: new Date('2026-11-01T09:30:00.000Z') }), PUEDE_CREAR)
    expect(r.acceptDeadlineAt).toBe('2026-11-01T09:45:00.000Z')
  })

  it('R45: si el cierre del día no existe (el reloj salta) y no hay uno futuro, el plazo es ahora + 30 min', async () => {
    const marzo = { ...HORARIO, sunday: { enabled: true, ranges: [{ open: '01:00', close: '02:30' }] } }
    ;(getAcceptingStatus as jest.Mock).mockResolvedValue({ ...NADIE, config: { ...NADIE.config, hours: marzo } })
    prismaMock.venue.findUnique.mockResolvedValueOnce({ timezone: 'America/Tijuana' } as any)
    const r = await createOnlineOrder(anon({ now: new Date('2026-03-08T09:50:00.000Z') }), PUEDE_CREAR)
    expect(r.acceptDeadlineAt).toBe('2026-03-08T10:20:00.000Z')
  })

  it('en «Nadie» un pedido de $0.00 responde 400 ZERO_TOTAL «Tu pedido no tiene costo: pídelo directo en caja» (rechazo guardado)', async () => {
    ;(quoteCart as jest.Mock).mockResolvedValue({ ...QUOTE_OK, subtotal: D('0'), total: D('0') })
    const err = await createOnlineOrder(anon({ expectedTotal: '0.00' }), PUEDE_CREAR).catch((e: unknown) => e)
    expect(err).toMatchObject({
      statusCode: 400,
      code: 'ZERO_TOTAL',
      message: 'Tu pedido no tiene costo: pídelo directo en caja.',
      final: true,
    })
    expect((prismaMock.idempotencyRequest.create as jest.Mock).mock.calls[0][0].data).toMatchObject({
      ...LLAVE_ANON,
      requestHash: huellaAnon({ expectedTotal: '0.00' }),
      responseStatus: 400,
    })
    expect(prismaMock.order.create).not.toHaveBeenCalled()
  })

  it('una pestaña vieja con teléfono verificado también se acepta en «Nadie» (folio con su cliente y su teléfono)', async () => {
    const res = await createOnlineOrder(input(), PUEDE_CREAR)
    expect(res).toMatchObject({ replay: false })
    expect((prismaMock.order.create.mock.calls[0][0] as any).data).toMatchObject({ customerId: 'cust1', customerPhone: PHONE })
    const online = (prismaMock.onlineOrder.create.mock.calls[0][0] as any).data
    expect(online).toMatchObject({ requiresAcceptance: false, channel: null })
    expect(online.requestHash).toBe(huella())
  })

  it('R47 (reemplaza la repetición antes del modo de T7): crea en «Nadie», el negocio pasa a «Mi equipo» y la misma llave sin sesión ⇒ 401 sin leer la llave ni guardar nada', async () => {
    const primero = await createOnlineOrder(anon(), PUEDE_CREAR)
    const guardado = (prismaMock.onlineOrder.create.mock.calls[0][0] as any).data

    aMiEquipo()
    prismaMock.order.findUnique.mockClear()
    prismaMock.order.findUnique.mockResolvedValue(
      existing({
        customerId: null,
        orderNumber: primero.orderNumber,
        onlineOrder: oo({
          status: 'PENDING_ACCEPTANCE',
          trackingToken: primero.trackingToken,
          requestHash: guardado.requestHash,
          acceptDeadlineAt: guardado.acceptDeadlineAt,
        }),
      }) as any,
    )
    prismaMock.idempotencyRequest.create.mockClear()
    await expect(createOnlineOrder(anon(), PUEDE_CREAR)).rejects.toMatchObject({ statusCode: 401, code: 'PHONE_VERIFICATION_REQUIRED' })
    expect(prismaMock.order.findUnique).not.toHaveBeenCalled()
    expect(prismaMock.order.create).toHaveBeenCalledTimes(1)
    expect(prismaMock.idempotencyRequest.create).not.toHaveBeenCalled()
  })

  it("la huella anónima usa customerId '' y el rechazo guardado usa anon:<llave>", async () => {
    ;(getAcceptingStatus as jest.Mock).mockResolvedValue({ ...NADIE, status: 'CLOSED', reason: 'OUTSIDE_HOURS' })
    await expect(createOnlineOrder(anon(), PUEDE_CREAR)).rejects.toMatchObject({ code: 'ORDERING_CLOSED', final: true })
    expect(prismaMock.idempotencyRequest.findUnique).toHaveBeenCalledWith({
      where: { organizationId_actorStaffId_endpoint_idempotencyKey: LLAVE_ANON },
    })
    expect((prismaMock.idempotencyRequest.create as jest.Mock).mock.calls[0][0].data).toMatchObject({
      ...LLAVE_ANON,
      requestHash: huellaAnon(),
    })
    // Un teléfono escrito SIN sesión no entra a la huella ni al pedido: sigue siendo anónimo.
    const conTelefono = await createOnlineOrder(anon({ customer: { name: 'María G.', phone: '55 4345 3965' } }), PUEDE_CREAR).catch(e => e)
    expect(conTelefono).toMatchObject({ code: 'ORDERING_CLOSED' })
    expect((prismaMock.idempotencyRequest.create as jest.Mock).mock.calls[1][0].data.requestHash).toBe(huellaAnon())
  })

  it('pedido anónimo, se pierde la respuesta, la caja lo cobra y le liga un cliente: el mismo envío devuelve SU folio y su token, nunca IDEMPOTENCY_KEY_CONFLICT', async () => {
    const ligado = existing({
      customerId: 'cliente-que-ligo-la-caja',
      onlineOrder: oo({ status: 'ACCEPTED', requestHash: huellaAnon() }),
    })
    prismaMock.order.findUnique.mockResolvedValue(ligado as any)
    await expect(createOnlineOrder(anon(), PUEDE_CREAR)).resolves.toMatchObject({
      replay: true,
      orderId: 'ord1',
      trackingToken: 'T'.repeat(32),
      status: 'ACCEPTED',
    })
    // También si aparece ya dentro del candado del negocio, y en la carrera (P2002).
    prismaMock.order.findUnique.mockReset()
    prismaMock.order.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(ligado as any)
    await expect(createOnlineOrder(anon(), PUEDE_CREAR)).resolves.toMatchObject({ replay: true, trackingToken: 'T'.repeat(32) })
    prismaMock.order.findUnique.mockResolvedValueOnce(ligado as any)
    ;(prismaMock.$transaction as jest.Mock).mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' }),
    )
    await expect(createOnlineOrder(anon(), PUEDE_CREAR)).resolves.toMatchObject({ replay: true, trackingToken: 'T'.repeat(32) })
    expect(prismaMock.order.create).not.toHaveBeenCalled()
  })

  it('un anónimo y otro anónimo con la misma llave y otra canasta chocan IDEMPOTENCY_KEY_CONFLICT', async () => {
    const otraCanasta = huellaAnon({ items: [{ productId: 'p2', quantity: 1 }] })
    prismaMock.order.findUnique.mockResolvedValue(existing({ customerId: null, onlineOrder: oo({ requestHash: otraCanasta }) }) as any)
    const err = await createOnlineOrder(anon(), PUEDE_CREAR).catch((e: unknown) => e)
    expect(err).toMatchObject({ statusCode: 409, code: 'IDEMPOTENCY_KEY_CONFLICT', final: true })
    expect(JSON.stringify(err) + (err as Error).message).not.toContain('T'.repeat(32))
    expect(prismaMock.order.create).not.toHaveBeenCalled()
  })

  it('un folio nuevo no emite ORDER_CREATED (las apps viejas no se enteran de un folio sin pagar); «Mi equipo» sí', async () => {
    await createOnlineOrder(anon(), PUEDE_CREAR)
    expect(prismaMock.order.create).toHaveBeenCalledTimes(1)
    expect(socketManager.broadcastToVenue).not.toHaveBeenCalled()
    ;(getAcceptingStatus as jest.Mock).mockResolvedValue(MI_EQUIPO)
    await createOnlineOrder(input({ idempotencyKey: 'm'.repeat(32) }), PUEDE_CREAR)
    expect(socketManager.broadcastToVenue).toHaveBeenCalledTimes(1)
    expect((prismaMock.onlineOrder.create.mock.calls[1][0] as any).data.requiresAcceptance).toBe(true)
  })

  it('«Mi equipo» sigue exigiendo PHONE_VERIFICATION_REQUIRED (sin sesión, o con un teléfono que no es el probado)', async () => {
    aMiEquipo()
    await expect(createOnlineOrder(anon(), PUEDE_CREAR)).rejects.toMatchObject({ statusCode: 401, code: 'PHONE_VERIFICATION_REQUIRED' })
    await expect(createOnlineOrder(input({ verifiedPhone: '+525511112222' }), PUEDE_CREAR)).rejects.toMatchObject({
      statusCode: 401,
      code: 'PHONE_VERIFICATION_REQUIRED',
    })
    expect(prismaMock.idempotencyRequest.create).not.toHaveBeenCalled()
    expect(prismaMock.order.create).not.toHaveBeenCalled()
  })

  describe('R52 (Codex f1 r5): un folio nunca nace vencido', () => {
    afterEach(() => {
      // Lo que estas pruebas simulan no se queda para las siguientes del archivo.
      prismaMock.venue.findUnique.mockReset()
      ;(prismaMock.$executeRaw as jest.Mock).mockReset()
    })
    const SIN_HORA_FIJA = { now: undefined } // la ruta no pasa hora: lee el reloj
    /** Cotizar y esperar el candado de admisión tarda: el reloj avanza a `escritura` al tomar ese candado. */
    const relojQueAvanzaEnLaAdmision = (escritura: Date) =>
      (prismaMock.$executeRaw as jest.Mock).mockImplementation(async (_sql: unknown, llave: string) => {
        if (llave === ADMISSION_LOCK) jest.setSystemTime(escritura)
        return 0
      })
    const conCierreALas21DeCancun = () => {
      ;(getAcceptingStatus as jest.Mock).mockResolvedValue({ ...NADIE, config: { ...NADIE.config, hours: HORARIO } })
      prismaMock.venue.findUnique.mockResolvedValue({ timezone: 'America/Cancun' } as any) // UTC-5 todo el año
    }
    const conRelojFalso = async (peticion: Date, fn: () => Promise<void>) => {
      jest.useFakeTimers({ now: peticion, doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'setInterval', 'queueMicrotask'] })
      try {
        await fn()
      } finally {
        jest.useRealTimers()
      }
    }

    it('pide a las 20:59:59 y se escribe a las 21:00:05 (cierre 21:00): responde como fuera de horario, guarda ese rechazo y no crea nada', async () => {
      conCierreALas21DeCancun()
      await conRelojFalso(new Date('2026-10-15T01:59:59.000Z'), async () => {
        relojQueAvanzaEnLaAdmision(new Date('2026-10-15T02:00:05.000Z'))

        const err = await createOnlineOrder(anon(SIN_HORA_FIJA), PUEDE_CREAR).catch((e: unknown) => e)

        // Lo mismo que hoy responde la tienda fuera de horario (paso 3), sin código ni enum nuevos.
        expect(err).toMatchObject({
          statusCode: 409,
          code: 'ORDERING_CLOSED',
          message: 'La tienda no está recibiendo pedidos en este momento.',
          details: { status: 'CLOSED', reason: 'OUTSIDE_HOURS' },
          final: true,
        })
        expect(prismaMock.order.create).not.toHaveBeenCalled()
        expect(prismaMock.onlineOrder.create).not.toHaveBeenCalled()
        expect((prismaMock.idempotencyRequest.create as jest.Mock).mock.calls[0][0].data).toMatchObject({
          ...LLAVE_ANON,
          responseStatus: 409,
          responseBody: { code: 'ORDERING_CLOSED', details: { status: 'CLOSED', reason: 'OUTSIDE_HOURS' } },
        })
      })
    })

    it('vecina: a las 20:50, aunque la escritura tarde 6 s, crea el folio con plazo 21:00 (R23: el plazo no se recalcula)', async () => {
      conCierreALas21DeCancun()
      await conRelojFalso(new Date('2026-10-15T01:50:00.000Z'), async () => {
        relojQueAvanzaEnLaAdmision(new Date('2026-10-15T01:50:06.000Z'))
        const r = await createOnlineOrder(anon(SIN_HORA_FIJA), PUEDE_CREAR)
        expect(r).toMatchObject({ replay: false, status: 'PENDING_ACCEPTANCE', acceptDeadlineAt: '2026-10-15T02:00:00.000Z' })
        expect(prismaMock.onlineOrder.create).toHaveBeenCalledTimes(1)
      })
    })

    it('la repetición con la misma llave de un folio que SÍ se creó devuelve su folio aunque ya sea tarde', async () => {
      conCierreALas21DeCancun()
      await conRelojFalso(new Date('2026-10-15T01:59:59.000Z'), async () => {
        relojQueAvanzaEnLaAdmision(new Date('2026-10-15T02:00:05.000Z'))
        // El envío vivo de la misma llave lo creó mientras éste esperaba: aparece ya dentro del candado de admisión (después de la hora).
        prismaMock.order.findUnique
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(existing({ customerId: null, onlineOrder: oo({ requestHash: huellaAnon() }) }) as any)
        await expect(createOnlineOrder(anon(SIN_HORA_FIJA), PUEDE_CREAR)).resolves.toMatchObject({ replay: true })
        expect(prismaMock.onlineOrder.create).not.toHaveBeenCalled()
      })
    })
  })

  describe('R56: «último pedido para pagar en caja» al crear (con la regla de apertura REAL)', () => {
    afterEach(() => prismaMock.venue.findUnique.mockReset())
    /** Hora de pared de Cancún (UTC-5 todo el año) del 14-oct. */
    const a = (hhmmss: string) => new Date(`2026-10-14T${hhmmss}-05:00`)
    /** La tienda real: ajustes, latido de hace 30 s y la zona del negocio; `getAcceptingStatus` sin simular. */
    const tiendaReal = (ahora: Date, o: Record<string, unknown> = {}) => {
      const real = jest.requireActual(
        '@/services/online-ordering/presence.service',
      ) as typeof import('@/services/online-ordering/presence.service')
      ;(getAcceptingStatus as jest.Mock).mockImplementation(real.getAcceptingStatus)
      prismaMock.venue.findUnique.mockResolvedValue({ timezone: 'America/Cancun' } as any)
      prismaMock.onlineOrderingSettings.findUnique.mockResolvedValue({
        venueId: 'v1',
        enabled: true,
        requiresAcceptance: false,
        acceptsPayAtPickup: true,
        acceptsCardOnline: false,
        manualPause: false,
        pausedUntil: null,
        minOrderAmount: 0,
        defaultPrepMinutes: 15,
        hours: HORARIO,
        lastToPayPollAt: new Date(ahora.getTime() - 30_000),
        lastInboxPollAt: new Date(ahora.getTime() - 30_000),
        ...o,
      } as any)
    }
    const fueraDeHorario = {
      statusCode: 409,
      code: 'ORDERING_CLOSED',
      message: 'La tienda no está recibiendo pedidos en este momento.',
      details: { status: 'CLOSED', reason: 'OUTSIDE_HOURS' },
    }

    it('a las 20:50:01 con cierre a las 21:00 el folio ya no se recibe: lo mismo que fuera de horario y nada se crea', async () => {
      tiendaReal(a('20:50:01'))
      await expect(createOnlineOrder(anon({ now: a('20:50:01') }), PUEDE_CREAR)).rejects.toMatchObject(fueraDeHorario)
      expect(prismaMock.order.create).not.toHaveBeenCalled()
      expect(prismaMock.onlineOrder.create).not.toHaveBeenCalled()
    })

    it('a las 20:49:59 se crea con plazo 21:00 (al menos 10 min para pagar)', async () => {
      tiendaReal(a('20:49:59'))
      const r = await createOnlineOrder(anon({ now: a('20:49:59') }), PUEDE_CREAR)
      expect(r).toMatchObject({ replay: false, acceptDeadlineAt: a('21:00:00').toISOString() })
    })

    it('franjas contiguas (09–21 + 21–23): a las 20:55 el cierre real es 23:00, así que se crea con su plazo de 30 min', async () => {
      const d = {
        enabled: true,
        ranges: [
          { open: '09:00', close: '21:00' },
          { open: '21:00', close: '23:00' },
        ],
      }
      const contiguas = { monday: d, tuesday: d, wednesday: d, thursday: d, friday: d, saturday: d, sunday: d }
      tiendaReal(a('20:55:00'), { hours: contiguas })
      const r = await createOnlineOrder(anon({ now: a('20:55:00') }), PUEDE_CREAR)
      expect(r.acceptDeadlineAt).toBe(a('21:25:00').toISOString())
    })

    it('«Mi equipo» a las 20:55 sigue creando como hoy', async () => {
      tiendaReal(a('20:55:00'), { requiresAcceptance: true })
      await expect(createOnlineOrder(input({ now: a('20:55:00') }), PUEDE_CREAR)).resolves.toMatchObject({ replay: false })
      expect((prismaMock.onlineOrder.create.mock.calls[0][0] as any).data.requiresAcceptance).toBe(true)
    })

    it('Codex r6: a las 20:59:59 ni siquiera se admite, aunque crear la cuenta tarde 6 s DESPUÉS de comprobar (antes: folio vencido)', async () => {
      tiendaReal(a('20:59:59'))
      jest.useFakeTimers({ now: a('20:59:59'), doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'setInterval', 'queueMicrotask'] })
      try {
        // Crear la cuenta y sus artículos espera el FOR UPDATE de recetas: la escritura del folio cae a las 21:00:05.
        prismaMock.order.create.mockImplementation((async () => {
          jest.setSystemTime(a('21:00:05'))
          return { id: 'ord1', orderNumber: 'WABCD' }
        }) as any)
        await expect(createOnlineOrder(anon({ now: undefined }), PUEDE_CREAR)).rejects.toMatchObject(fueraDeHorario)
        expect(prismaMock.onlineOrder.create).not.toHaveBeenCalled()
      } finally {
        jest.useRealTimers()
      }
    })
  })

  describe('T3b: tope propio de 60 folios sin pagar y el aviso una vez por hora', () => {
    const LLENO = 60
    /** Cuenta folios sin pagar como `unpaidFoliosWhere` (R18) y nada de «Mi equipo». */
    beforeEach(() => prismaMock.staffVenue.findMany.mockResolvedValue([]))
    afterEach(() => {
      prismaMock.activityLog.create.mockReset()
      prismaMock.activityLog.findFirst.mockReset()
      prismaMock.staffVenue.findMany.mockReset()
    })
    const foliosSinPagar = (n: number) =>
      prismaMock.onlineOrder.count.mockImplementation(async ({ where }: any) =>
        where.requiresAcceptance === false && where.order?.paymentStatus === 'PENDING' ? n : 0,
      )

    it('el folio 61 responde 409 TOO_MANY_UNPAID_FOLIOS con «Hay muchos pedidos esperando pago. Pide directo en caja» y la tienda sigue OPEN', async () => {
      foliosSinPagar(LLENO)
      const err = await createOnlineOrder(anon(), PUEDE_CREAR).catch((e: unknown) => e)
      expect(err).toMatchObject({
        statusCode: 409,
        code: 'TOO_MANY_UNPAID_FOLIOS',
        message: 'Hay muchos pedidos esperando pago. Pide directo en caja.',
        final: true,
      })
      expect(prismaMock.order.create).not.toHaveBeenCalled()
      expect((prismaMock.idempotencyRequest.create as jest.Mock).mock.calls[0][0].data).toMatchObject({
        ...LLAVE_ANON,
        responseStatus: 409,
      })
      // La tienda NO se pausa: nada toca sus ajustes (sigue abierta para ver el menú).
      for (const m of ['update', 'updateMany', 'upsert'] as const) expect(prismaMock.onlineOrderingSettings[m]).not.toHaveBeenCalled()

      // Con 59 sí entra el 60.
      foliosSinPagar(LLENO - 1)
      await expect(createOnlineOrder(anon({ idempotencyKey: 'n'.repeat(32) }), PUEDE_CREAR)).resolves.toMatchObject({ replay: false })
    })

    it('el tope se cuenta bajo el candado del negocio y sólo para folios: «Mi equipo» con 60 folios vivos no lo ve', async () => {
      foliosSinPagar(LLENO)
      ;(getAcceptingStatus as jest.Mock).mockResolvedValue(MI_EQUIPO)
      await expect(createOnlineOrder(input(), PUEDE_CREAR)).resolves.toMatchObject({ replay: false })
      expect(prismaMock.onlineOrder.count).not.toHaveBeenCalledWith({ where: expect.objectContaining({ requiresAcceptance: false }) })
    })

    it('el aviso «se llenaron los folios por pagar» sale una vez por hora (dos rechazos en 10 min ⇒ una sola fila en la bitácora)', async () => {
      foliosSinPagar(LLENO)
      const filas: any[] = []
      prismaMock.activityLog.create.mockImplementation(async ({ data }: any) => {
        filas.push(data)
        return data
      })
      prismaMock.activityLog.findFirst.mockImplementation(
        async ({ where }: any) =>
          filas.find(f => f.action === where.action && f.venueId === where.venueId && f.createdAt >= where.createdAt.gte) ?? null,
      )
      prismaMock.staffVenue.findMany.mockResolvedValue([{ staffId: 'gerente1' }, { staffId: 'duena1' }] as any)

      const intento = (minutos: number, llave: string) =>
        createOnlineOrder(anon({ now: new Date(NOW.getTime() + minutos * 60_000), idempotencyKey: llave.repeat(32) }), PUEDE_CREAR).catch(
          (e: unknown) => e,
        )
      await expect(intento(0, 'a')).resolves.toMatchObject({ code: 'TOO_MANY_UNPAID_FOLIOS' })
      await expect(intento(10, 'b')).resolves.toMatchObject({ code: 'TOO_MANY_UNPAID_FOLIOS' })

      expect(filas).toHaveLength(1)
      expect(filas[0]).toMatchObject({ action: 'ONLINE_ORDERING_UNPAID_FOLIOS_FULL', venueId: 'v1', createdAt: NOW })
      expect(prismaMock.staffVenue.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { venueId: 'v1', active: true, role: { in: ['MANAGER', 'ADMIN', 'OWNER'] } } }),
      )
      expect(prismaMock.notification.createMany).toHaveBeenCalledTimes(1)
      const avisos = (prismaMock.notification.createMany.mock.calls[0][0] as any).data
      expect(avisos.map((a: any) => a.recipientId)).toEqual(['gerente1', 'duena1'])
      expect(avisos[0]).toMatchObject({ venueId: 'v1', type: 'ALERT', title: 'Se llenaron los pedidos por pagar' })

      // Dentro del mismo candado: la bitácora se escribe después de tomar el del negocio.
      const raw = prismaMock.$executeRaw as jest.Mock
      const admision = raw.mock.calls.findIndex(([, k]) => k === ADMISSION_LOCK)
      expect(raw.mock.invocationCallOrder[admision]).toBeLessThan(prismaMock.activityLog.create.mock.invocationCallOrder[0])

      // Pasada la hora, otro aviso.
      await expect(intento(61, 'c')).resolves.toMatchObject({ code: 'TOO_MANY_UNPAID_FOLIOS' })
      expect(filas).toHaveLength(2)
      expect(prismaMock.notification.createMany).toHaveBeenCalledTimes(2)
    })
  })
})

describe('getTrackingByToken', () => {
  it('no expone el teléfono ni datos internos y calcula canCancel', async () => {
    prismaMock.onlineOrder.findUnique.mockResolvedValue({
      status: 'PENDING_ACCEPTANCE',
      paymentMode: 'PAY_AT_PICKUP',
      acceptDeadlineAt: NOW,
      estimatedReadyAt: null,
      rejectReason: null,
      createdAt: NOW,
      venueId: 'v1',
      order: {
        orderNumber: 'WABCD',
        total: D('206.00'),
        paymentStatus: 'PENDING',
        items: [
          { productName: 'Flautas', quantity: 2, notes: null, unitPrice: D('103.00'), total: D('206.00'), modifiers: [{ name: 'Salsa verde', quantity: 1 }] },
        ],
        customerName: 'Ana',
        payments: [],
        venue: {
          name: 'Flautas Coyoacán',
          slug: 'flautas-coyoacan',
          timezone: 'America/Tijuana',
          address: 'Av. Coyoacán 123',
          city: 'CDMX',
          state: 'CDMX',
          zipCode: '04000',
          phone: ' 5512345678 ',
        },
      },
    } as any)

    const t = await getTrackingByToken('T'.repeat(32))
    expect(t).toMatchObject({ orderNumber: 'WABCD', total: 206, canCancel: true, paid: false, venueSlug: 'flautas-coyoacan' })
    expect(JSON.stringify(t)).not.toMatch(/customerPhone|customerEmail/)
    // 1b: la zona del negocio (para mostrar las horas) y su contacto (para llamar), nunca los datos del comensal.
    expect(t).toMatchObject({
      venueTimezone: 'America/Tijuana',
      venueContact: { address: 'Av. Coyoacán 123, CDMX, CDMX, 04000', phone: '5512345678' },
    })
    const cuenta = (prismaMock.onlineOrder.findUnique.mock.calls[0][0] as any).select.order.select
    // T18b: el nombre SÍ sale (lo dio la misma clienta); teléfono y correo nunca.
    for (const campo of ['customerPhone', 'customerEmail']) expect(cuenta).not.toHaveProperty(campo)
  })

  const folioNadie = (over: Record<string, any> = {}, paymentStatus = 'PENDING') =>
    ({
      status: 'PENDING_ACCEPTANCE',
      paymentMode: 'PAY_AT_PICKUP',
      requiresAcceptance: false,
      channel: 'QR',
      acceptDeadlineAt: NOW,
      estimatedReadyAt: null,
      rejectReason: null,
      createdAt: NOW,
      venueId: 'v1',
      order: {
        orderNumber: 'W-0042',
        total: D('93.00'),
        paymentStatus,
        customerName: 'María G.',
        payments: [],
        items: [{ productName: 'Flautas', quantity: 1, notes: null, unitPrice: D('93.00'), total: D('93.00'), modifiers: [] }],
        venue: { name: 'X', slug: 'x', timezone: '', address: null, city: null, state: null, zipCode: null, phone: null },
      },
      ...over,
    }) as any

  it('T18b: folio por pagar ⇒ customerName, paidAt null y renglones con unitPrice/total en pesos; nunca teléfono ni correo', async () => {
    const base = folioNadie()
    prismaMock.onlineOrder.findUnique.mockResolvedValue({
      ...base,
      order: {
        ...base.order,
        customerName: 'María G.',
        payments: [],
        items: [{ productName: 'Flautas', quantity: 2, notes: null, unitPrice: D('46.50'), total: D('93.00'), modifiers: [] }],
      },
    })
    const t = await getTrackingByToken('T'.repeat(32))
    expect(t).toMatchObject({ customerName: 'María G.', paidAt: null })
    expect(t!.items[0]).toMatchObject({ unitPrice: 46.5, total: 93 })
    expect(JSON.stringify(t)).not.toMatch(/customerPhone|customerEmail/)
    const cuenta = (prismaMock.onlineOrder.findUnique.mock.calls[0][0] as any).select.order.select
    expect(cuenta).toMatchObject({ customerName: true })
    expect(cuenta).not.toHaveProperty('customerPhone')
    expect(cuenta.items.select).toMatchObject({ unitPrice: true, total: true })
  })

  it('T18b: folio pagado ⇒ paidAt es la hora del último cobro COMPLETED; pagado sin cobro legible ⇒ null', async () => {
    const base = folioNadie({}, 'PAID')
    const at = new Date('2026-11-06T17:05:00.000Z')
    prismaMock.onlineOrder.findUnique.mockResolvedValue({
      ...base,
      order: { ...base.order, customerName: 'María G.', payments: [{ createdAt: at }] },
    })
    await expect(getTrackingByToken('T'.repeat(32))).resolves.toMatchObject({ paid: true, paidAt: at.toISOString() })
    const pagos = (prismaMock.onlineOrder.findUnique.mock.calls[0][0] as any).select.order.select.payments
    expect(pagos).toMatchObject({ // un reembolso posterior NO es la hora de pago: sólo cobros (no REFUND)
      where: { status: 'COMPLETED', type: { not: 'REFUND' } }, orderBy: { createdAt: 'desc' }, take: 1 })
    prismaMock.onlineOrder.findUnique.mockResolvedValue({ ...base, order: { ...base.order, customerName: null, payments: [] } })
    await expect(getTrackingByToken('T'.repeat(32))).resolves.toMatchObject({ customerName: null, paidAt: null })
  })

  it('T18b: «Mi equipo» y tarjeta traen los mismos campos (aditivos)', async () => {
    const base = folioNadie({ requiresAcceptance: true, paymentMode: 'CARD_ONLINE' }, 'PAID')
    const at = new Date('2026-11-06T17:05:00.000Z')
    prismaMock.onlineOrder.findUnique.mockResolvedValue({
      ...base,
      order: { ...base.order, customerName: 'Luis', payments: [{ createdAt: at }] },
    })
    await expect(getTrackingByToken('T'.repeat(32))).resolves.toMatchObject({ customerName: 'Luis', paidAt: at.toISOString() })
  })

  it('T15: el seguimiento trae requiresAcceptance y channel', async () => {
    prismaMock.onlineOrder.findUnique.mockResolvedValue(folioNadie())
    await expect(getTrackingByToken('T'.repeat(32))).resolves.toMatchObject({ requiresAcceptance: false, channel: 'QR' })
    expect((prismaMock.onlineOrder.findUnique.mock.calls[0][0] as any).select).toMatchObject({ requiresAcceptance: true, channel: true })
    prismaMock.onlineOrder.findUnique.mockResolvedValue(folioNadie({ requiresAcceptance: true, channel: null }))
    await expect(getTrackingByToken('T'.repeat(32))).resolves.toMatchObject({ requiresAcceptance: true, channel: null })
  })

  it('T15 (fija lo de hoy): en «Nadie» canCancel es true mientras no se paga y false con un abono', async () => {
    prismaMock.onlineOrder.findUnique.mockResolvedValue(folioNadie())
    await expect(getTrackingByToken('T'.repeat(32))).resolves.toMatchObject({ canCancel: true })
    prismaMock.onlineOrder.findUnique.mockResolvedValue(folioNadie({}, 'PARTIAL'))
    await expect(getTrackingByToken('T'.repeat(32))).resolves.toMatchObject({ canCancel: false })
    prismaMock.onlineOrder.findUnique.mockResolvedValue(folioNadie({}, 'PAID'))
    await expect(getTrackingByToken('T'.repeat(32))).resolves.toMatchObject({ canCancel: false })
  })

  it('T15 (fija lo de hoy): un folio pagado trae paid true, su folio y sus renglones', async () => {
    prismaMock.onlineOrder.findUnique.mockResolvedValue(folioNadie({}, 'PAID'))
    await expect(getTrackingByToken('T'.repeat(32))).resolves.toMatchObject({
      paid: true,
      orderNumber: 'W-0042',
      items: [{ name: 'Flautas', quantity: 1 }],
    })
  })

  it('1b: sin zona en el negocio, el seguimiento usa America/Mexico_City; sin contacto, nulos', async () => {
    prismaMock.onlineOrder.findUnique.mockResolvedValue({
      status: 'ACCEPTED',
      paymentMode: 'PAY_AT_PICKUP',
      acceptDeadlineAt: NOW,
      estimatedReadyAt: NOW,
      rejectReason: null,
      createdAt: NOW,
      venueId: 'v1',
      order: {
        orderNumber: 'WABCE',
        total: D('93.00'),
        paymentStatus: 'PENDING',
        items: [],
        venue: { name: 'X', slug: 'x', timezone: '', address: null, city: null, state: null, zipCode: null, phone: null },
      },
    } as any)
    await expect(getTrackingByToken('T'.repeat(32))).resolves.toMatchObject({
      venueTimezone: 'America/Mexico_City',
      venueContact: { address: null, phone: null },
    })
  })

  it('un token desconocido devuelve null', async () => {
    prismaMock.onlineOrder.findUnique.mockResolvedValue(null)
    await expect(getTrackingByToken('x'.repeat(32))).resolves.toBeNull()
  })

  describe('S4 (Codex plan r1 #3 y r2 #3): con el dinero en duda no se afirma «no se cobró»', () => {
    const VENUE = {
      name: 'X',
      slug: 'x',
      timezone: 'America/Mexico_City',
      address: null,
      city: null,
      state: null,
      zipCode: null,
      phone: null,
    }
    const draftRow = (o: Record<string, unknown>) => ({
      id: 'ch1',
      status: 'PENDING_AUTH',
      lastError: null,
      updatedAt: new Date(), // recién tocado: el seguimiento no le pregunta a Stripe
      request: { quote: { lines: [] } },
      amount: D('250.00'),
      checkoutExpiresAt: NOW,
      createdAt: NOW,
      venueId: 'v1',
      venue: VENUE,
      ...o,
    })
    // El borrador simulado no se queda para las pruebas de crear pedido (buscan ahí la llave de tarjeta).
    afterEach(() => prismaMock.onlineOrderCharge.findUnique.mockReset())
    const tracking = async (o: Record<string, unknown>) => {
      prismaMock.onlineOrder.findUnique.mockResolvedValue(null)
      prismaMock.onlineOrderCharge.findUnique.mockResolvedValue(draftRow(o) as any)
      return getTrackingByToken('T'.repeat(32))
    }

    it('pedido rechazado con la liberación en curso (RELEASING) ⇒ cardStatus RELEASING, no RELEASED', async () => {
      prismaMock.onlineOrder.findUnique.mockResolvedValue({
        status: 'REJECTED',
        paymentMode: 'CARD_ONLINE',
        acceptDeadlineAt: NOW,
        estimatedReadyAt: null,
        rejectReason: 'OTHER',
        createdAt: NOW,
        venueId: 'v1',
        charge: { status: 'RELEASING' },
        order: { orderNumber: 'WABCD', total: D('250.00'), paymentStatus: 'PENDING', items: [], venue: VENUE },
      } as any)
      await expect(getTrackingByToken('T'.repeat(32))).resolves.toMatchObject({ status: 'REJECTED', cardStatus: 'RELEASING' })
    })

    it('borrador normal ⇒ AWAITING_PAYMENT sin cardStatus', async () => {
      await expect(tracking({})).resolves.toMatchObject({ status: 'AWAITING_PAYMENT', cardStatus: null })
    })

    it('borrador que terminó CAPTURED sin pedido ⇒ PAYMENT_NOT_COMPLETED con cardStatus CAPTURED', async () => {
      await expect(tracking({ status: 'CAPTURED', lastError: 'CAPTURED_OUTSIDE' })).resolves.toMatchObject({
        status: 'PAYMENT_NOT_COMPLETED',
        cardStatus: 'CAPTURED',
      })
    })

    it('borrador PENDING_AUTH cobrado fuera (CAPTURED_OUTSIDE) ⇒ PAYMENT_NOT_COMPLETED con cardStatus CAPTURED', async () => {
      await expect(tracking({ lastError: 'CAPTURED_OUTSIDE' })).resolves.toMatchObject({
        status: 'PAYMENT_NOT_COMPLETED',
        cardStatus: 'CAPTURED',
      })
    })

    it('borrador con la liberación en curso ⇒ PAYMENT_NOT_COMPLETED con cardStatus RELEASING; vencido ⇒ sin cardStatus', async () => {
      await expect(tracking({ status: 'RELEASING' })).resolves.toMatchObject({ status: 'PAYMENT_NOT_COMPLETED', cardStatus: 'RELEASING' })
      await expect(tracking({ status: 'ABANDONED' })).resolves.toMatchObject({ status: 'PAYMENT_NOT_COMPLETED', cardStatus: null })
    })
  })
})

/**
 * S3 (ronda final, N1 de la QA): `verify` con `purpose:'ORDERING'` no pone el nombre (R7: no activa la cuenta de reservas) y la tienda
 * no lo manda al verificar; el Customer nacía sin nombre y «Clientes» lo mostraba vacío. Al crear el pedido, dentro de la MISMA
 * transacción, se completa el nombre si estaba vacío: nunca se pisa lo que el negocio escribió, y una repetición no escribe nada.
 */
describe('S3: el cliente que nace de un pedido conserva su nombre', () => {
  const cliente = (o: Record<string, unknown> = {}) => ({ id: 'cust1', venueId: 'v1', firstName: null, lastName: null, ...o })

  it('un cliente sin nombre queda con el del pedido (primera palabra y resto), en la transacción del pedido', async () => {
    prismaMock.customer.findFirst.mockResolvedValue(cliente() as any)
    await createOnlineOrder(input({ customer: { name: 'María Gómez Ruiz', phone: '55 4345 3965', email: null } }), PUEDE_CREAR)
    expect(prismaMock.customer.findFirst).toHaveBeenCalledWith({ where: { id: 'cust1', venueId: 'v1' } }) // del negocio, no de otro
    expect(prismaMock.customer.update).toHaveBeenCalledTimes(1)
    expect(prismaMock.customer.update).toHaveBeenCalledWith({
      where: { id: 'cust1' },
      data: { firstName: 'María', lastName: 'Gómez Ruiz' },
    })
    // Es parte de la admisión: se escribe después de crear el pedido, nunca antes del candado.
    const lockAt = (prismaMock.$executeRaw as jest.Mock).mock.invocationCallOrder[0]
    expect(lockAt).toBeLessThan(prismaMock.customer.update.mock.invocationCallOrder[0])
  })

  it('un cliente al que el negocio ya le escribió nombre queda intacto', async () => {
    prismaMock.customer.findFirst.mockResolvedValue(cliente({ firstName: 'Daniela', lastName: 'Ruiz' }) as any)
    await createOnlineOrder(input({ customer: { name: 'Dany', phone: '55 4345 3965', email: null } }), PUEDE_CREAR)
    expect(prismaMock.customer.update).not.toHaveBeenCalled()
  })

  it('sin nombre que poner (sólo espacios) no escribe nada', async () => {
    prismaMock.customer.findFirst.mockResolvedValue(cliente() as any)
    await createOnlineOrder(input({ customer: { name: '   ', phone: '55 4345 3965', email: null } }), PUEDE_CREAR)
    expect(prismaMock.customer.update).not.toHaveBeenCalled()
  })

  it('una repetición (tras el candado de la llave o el del negocio) no escribe nada en el cliente', async () => {
    prismaMock.customer.findFirst.mockResolvedValue(cliente() as any)
    prismaMock.order.findUnique.mockResolvedValue(existing() as any)
    await createOnlineOrder(input(), PUEDE_CREAR)
    prismaMock.order.findUnique.mockReset()
    prismaMock.order.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(existing() as any)
    await createOnlineOrder(input(), PUEDE_CREAR)
    expect(prismaMock.customer.update).not.toHaveBeenCalled()
  })

  it('un rechazo de la admisión (tope por teléfono) deja el cliente como estaba', async () => {
    prismaMock.customer.findFirst.mockResolvedValue(cliente() as any)
    prismaMock.onlineOrder.count.mockResolvedValueOnce(3)
    await expect(createOnlineOrder(input(), PUEDE_CREAR)).rejects.toMatchObject({ code: 'TOO_MANY_PENDING_ORDERS' })
    expect(prismaMock.customer.update).not.toHaveBeenCalled()
  })
})

describe('el armado de la cuenta se comparte (fase 2: la tarjeta crea la cuenta al autorizarse)', () => {
  it('writeOnlineOrderInTx arma la misma cuenta que createOnlineOrder', async () => {
    await createOnlineOrder(input(), PUEDE_CREAR)
    const order = (prismaMock.order.create.mock.calls[0][0] as any).data
    const online = (prismaMock.onlineOrder.create.mock.calls[0][0] as any).data
    prismaMock.order.create.mockClear()
    prismaMock.onlineOrder.create.mockClear()

    const r = await writeOnlineOrderInTx(prismaMock, {
      venueId: 'v1',
      externalId: `web:${KEY}`,
      orderNumber: order.orderNumber,
      quote: toQuoteSnapshot(QUOTE_OK as any),
      customer: { name: 'María G.', phone: PHONE, email: null },
      customerId: 'cust1',
      note: null,
      paymentMode: 'CARD_ONLINE',
      trackingToken: online.trackingToken,
      requestHash: online.requestHash,
      acceptDeadlineAt: online.acceptDeadlineAt,
      whatsappConsent: true,
      requiresAcceptance: true,
      channel: null,
    })

    expect(r).toEqual({ orderId: 'ord1', onlineOrderId: 'oo1' })
    // Codex r1 C1: la de tarjeta, además, nace cobro del momento (nunca fiado).
    expect((prismaMock.order.create.mock.calls[0][0] as any).data).toEqual({ ...order, payLater: false })
    expect((prismaMock.onlineOrder.create.mock.calls[0][0] as any).data).toEqual({ ...online, paymentMode: 'CARD_ONLINE' })
  })

  it('QuoteSnapshot es JSON y va y vuelve con los mismos valores (los Decimal como texto)', () => {
    const q = { ...QUOTE_OK, subtotal: D('206.005'), lines: [{ ...QUOTE_OK.lines[0], unitPrice: D('93.0000001') }] }
    const snap = toQuoteSnapshot(q as any)
    expect(JSON.parse(JSON.stringify(snap))).toEqual(snap)
    expect(snap.subtotal).toBe('206.005')
    expect(snap.lines[0].unitPrice).toBe('93.0000001')
    expect(fromQuoteSnapshot(snap)).toEqual({ subtotal: q.subtotal, total: q.total, lines: q.lines })
  })
})

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
  getTrackingByToken,
  onlineOrderRequestHash,
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
  ;(prismaMock.$transaction as jest.Mock).mockImplementation(async (fn: any) => fn(prismaMock))
  prismaMock.order.create.mockResolvedValue({ id: 'ord1', orderNumber: 'WABCD' } as any)
  prismaMock.onlineOrder.create.mockImplementation(async (a: any) => ({ id: 'oo1', ...a.data }) as any)
  // Codex r3: los rechazos guardados de la llave (tabla genérica `IdempotencyRequest`). Por omisión, ninguno.
  prismaMock.idempotencyRequest = { findUnique: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue({}) }
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

  it('la misma llave de OTRO cliente es 409 IDEMPOTENCY_KEY_CONFLICT y no entrega el token (R8)', async () => {
    prismaMock.order.findUnique.mockResolvedValue(existing({ customerId: 'otro-cliente' }) as any)
    await expect(createOnlineOrder(input(), PUEDE_CREAR)).rejects.toMatchObject({ statusCode: 409, code: 'IDEMPOTENCY_KEY_CONFLICT' })
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

  it('sin sesión de cliente es 401 PHONE_VERIFICATION_REQUIRED (R6)', async () => {
    await expect(createOnlineOrder(input({ customerId: null }), PUEDE_CREAR)).rejects.toMatchObject({
      statusCode: 401,
      code: 'PHONE_VERIFICATION_REQUIRED',
    })
    expect(prismaMock.order.findUnique).not.toHaveBeenCalled()
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
    await expect(createOnlineOrder(input(), PUEDE_CREAR)).rejects.toMatchObject({ statusCode: 400, code: 'PAYMENT_MODE_NOT_ACCEPTED' })
    expect(quoteCart).not.toHaveBeenCalled()
    expect(prismaMock.order.create).not.toHaveBeenCalled()
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
        onlineOrder: oo({ id: 'oo9', status: 'PENDING_ACCEPTANCE', trackingToken: 'W'.repeat(32) }),
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

  it('un 401 PHONE_VERIFICATION_REQUIRED no abre la transacción (sin cliente probado no hay repetición posible)', async () => {
    await expect(createOnlineOrder(input({ verifiedPhone: null }), PUEDE_CREAR)).rejects.toMatchObject({
      code: 'PHONE_VERIFICATION_REQUIRED',
    })
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
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

    prismaMock.order.findUnique.mockResolvedValueOnce(existing({ customerId: 'otro-cliente' }) as any)
    await expect(createOnlineOrder(input(), PUEDE_CREAR)).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_CONFLICT', final: true })
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
        items: [{ productName: 'Flautas', quantity: 2, notes: null, modifiers: [{ name: 'Salsa verde', quantity: 1 }] }],
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
    for (const campo of ['customerPhone', 'customerEmail', 'customerName']) expect(cuenta).not.toHaveProperty(campo)
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

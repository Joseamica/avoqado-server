// tests/unit/services/online-ordering/order.service.test.ts
import { Prisma } from '@prisma/client'
import { prismaMock } from '@tests/__helpers__/setup'

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
import { createOnlineOrder, getTrackingByToken, onlineOrderRequestHash } from '@/services/online-ordering/order.service'

const D = (v: string) => new Prisma.Decimal(v)
const NOW = new Date('2026-10-14T18:30:00.000Z')
const KEY = 'k'.repeat(32)
const PHONE = '+525543453965'

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
})

describe('createOnlineOrder', () => {
  it('crea Order PICKUP/WEB con renglones, categoría y extras POR UNIDAD como la terminal (F2, R3)', async () => {
    const res = await createOnlineOrder(input())

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
    await createOnlineOrder(input())
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

  it('la admisión corre bajo el candado consultivo del negocio y ahí repite repetición, topes y folio (R4)', async () => {
    await createOnlineOrder(input())
    const [strings, key] = (prismaMock.$executeRaw as jest.Mock).mock.calls[0]
    expect((strings as string[]).join('?')).toContain('pg_advisory_xact_lock(hashtext(?))')
    expect(key).toBe('online-order-admission:v1')
    expect(prismaMock.order.findUnique).toHaveBeenCalledTimes(2) // fuera y dentro del candado
    expect(prismaMock.onlineOrder.count).toHaveBeenCalledTimes(2) // tope por teléfono y por negocio
    expect(prismaMock.order.findFirst).toHaveBeenCalled() // folio sin chocar con una cuenta abierta
  })

  it('la repetición del MISMO cliente devuelve el MISMO token sin abrir la tienda ni crear otro pedido', async () => {
    prismaMock.order.findUnique.mockResolvedValue(existing() as any)
    const res = await createOnlineOrder(input())
    expect(res).toMatchObject({ replay: true, trackingToken: 'T'.repeat(32), status: 'ACCEPTED', orderId: 'ord1' })
    expect(getAcceptingStatus).not.toHaveBeenCalled()
    expect(prismaMock.$executeRaw).not.toHaveBeenCalled()
    expect(prismaMock.order.create).not.toHaveBeenCalled()
  })

  it('una repetición que aparece ya dentro del candado tampoco crea otro pedido', async () => {
    prismaMock.order.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(existing({ onlineOrder: oo({ status: 'PENDING_ACCEPTANCE' }) }) as any)
    const res = await createOnlineOrder(input())
    expect(res).toMatchObject({ replay: true, orderId: 'ord1', status: 'PENDING_ACCEPTANCE' })
    expect(prismaMock.order.create).not.toHaveBeenCalled()
    expect(socketManager.broadcastToVenue).not.toHaveBeenCalled()
  })

  it('la misma llave de OTRO cliente es 409 IDEMPOTENCY_KEY_CONFLICT y no entrega el token (R8)', async () => {
    prismaMock.order.findUnique.mockResolvedValue(existing({ customerId: 'otro-cliente' }) as any)
    await expect(createOnlineOrder(input())).rejects.toMatchObject({ statusCode: 409, code: 'IDEMPOTENCY_KEY_CONFLICT' })
  })

  const PEDIDO_DISTINTO = {
    statusCode: 409,
    code: 'IDEMPOTENCY_KEY_CONFLICT',
    message: 'Ya hiciste un pedido distinto con esta misma solicitud. Recarga la página para empezar uno nuevo.',
  }

  it('M-3: la misma llave del MISMO cliente con OTRO total es 409: nunca devuelve el pedido viejo como si fuera el nuevo', async () => {
    prismaMock.order.findUnique.mockResolvedValue(existing() as any) // se creó por $206.00
    const err = await createOnlineOrder(input({ expectedTotal: '150.00' })).catch((e: unknown) => e)
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
    await expect(createOnlineOrder(input())).rejects.toMatchObject(PEDIDO_DISTINTO)
    expect(prismaMock.order.create).not.toHaveBeenCalled()

    prismaMock.order.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(existing({ total: D('180.00'), onlineOrder: oo({ requestHash: huella({ expectedTotal: '180.00' }) }) }) as any)
    ;(prismaMock.$transaction as jest.Mock).mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' }),
    )
    await expect(createOnlineOrder(input())).rejects.toMatchObject(PEDIDO_DISTINTO)
  })

  it('una carrera por la misma llave (P2002) se resuelve devolviendo al ganador del mismo cliente', async () => {
    prismaMock.order.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(
      existing({
        id: 'ord9',
        orderNumber: 'WZZZZ',
        onlineOrder: oo({ id: 'oo9', status: 'PENDING_ACCEPTANCE', trackingToken: 'W'.repeat(32) }),
      }) as any,
    )
    ;(prismaMock.$transaction as jest.Mock).mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' }),
    )
    const res = await createOnlineOrder(input())
    expect(res).toMatchObject({ replay: true, orderId: 'ord9' })
  })

  it('A1: al crear guarda la huella de la solicitud (sha256 de 64 caracteres)', async () => {
    await createOnlineOrder(input())
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
    const err = await createOnlineOrder(input()).catch((e: unknown) => e)
    expect(err).toMatchObject(PEDIDO_DISTINTO)
    expect(JSON.stringify(err) + (err as Error).message).not.toContain('T'.repeat(32))
    expect(prismaMock.order.create).not.toHaveBeenCalled()
  })

  it('A1: el reintento IDÉNTICO recibe su pedido aunque la caja ya haya cambiado el total de la cuenta', async () => {
    prismaMock.order.findUnique.mockResolvedValue(existing({ total: D('250.00') }) as any)
    const res = await createOnlineOrder(input())
    expect(res).toMatchObject({ replay: true, orderId: 'ord1', trackingToken: 'T'.repeat(32) })
    expect(prismaMock.order.create).not.toHaveBeenCalled()
  })

  it('A1: un pedido guardado SIN huella se trata como solicitud distinta (409), también dentro del candado y en la carrera', async () => {
    const sinHuella = existing({ onlineOrder: oo({ requestHash: null }) })
    prismaMock.order.findUnique.mockResolvedValueOnce(sinHuella as any)
    await expect(createOnlineOrder(input())).rejects.toMatchObject(PEDIDO_DISTINTO)
    prismaMock.order.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(sinHuella as any)
    await expect(createOnlineOrder(input())).rejects.toMatchObject(PEDIDO_DISTINTO)
    prismaMock.order.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(sinHuella as any)
    ;(prismaMock.$transaction as jest.Mock).mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' }),
    )
    await expect(createOnlineOrder(input())).rejects.toMatchObject(PEDIDO_DISTINTO)
    expect(prismaMock.order.create).not.toHaveBeenCalled()
  })

  it('con la tienda no abierta responde 409 con el estado y el motivo', async () => {
    ;(getAcceptingStatus as jest.Mock).mockResolvedValue({ ...OPEN, status: 'OFFLINE', reason: 'NO_DEVICE' })
    await expect(createOnlineOrder(input())).rejects.toMatchObject({
      statusCode: 409,
      code: 'ORDERING_OFFLINE',
      details: { status: 'OFFLINE', reason: 'NO_DEVICE' },
    })
  })

  it('sin sesión de cliente es 401 PHONE_VERIFICATION_REQUIRED (R6)', async () => {
    await expect(createOnlineOrder(input({ customerId: null }))).rejects.toMatchObject({
      statusCode: 401,
      code: 'PHONE_VERIFICATION_REQUIRED',
    })
    expect(prismaMock.order.findUnique).not.toHaveBeenCalled()
  })

  it('una sesión sin teléfono verificado por WhatsApp (correo, contraseña, token viejo) es 401 (R6)', async () => {
    await expect(createOnlineOrder(input({ verifiedPhone: null }))).rejects.toMatchObject({
      statusCode: 401,
      code: 'PHONE_VERIFICATION_REQUIRED',
    })
  })

  it('el teléfono del pedido debe ser el que se verificó (R6)', async () => {
    await expect(createOnlineOrder(input({ verifiedPhone: '+525511112222' }))).rejects.toMatchObject({
      statusCode: 401,
      code: 'PHONE_VERIFICATION_REQUIRED',
    })
    expect(prismaMock.order.create).not.toHaveBeenCalled()
  })

  it('un carrito inválido devuelve CART_INVALID con las incidencias', async () => {
    ;(quoteCart as jest.Mock).mockResolvedValue({ ...QUOTE_OK, ok: false, issues: [{ code: 'PRODUCT_UNAVAILABLE', message: 'x' }] })
    await expect(createOnlineOrder(input())).rejects.toMatchObject({
      statusCode: 400,
      code: 'CART_INVALID',
      details: { issues: [{ code: 'PRODUCT_UNAVAILABLE', message: 'x' }] },
    })
  })

  it('si el total del servidor no es el que vio el comensal: 409 PRICE_CHANGED con la cotización nueva y nada se crea (R5)', async () => {
    await expect(createOnlineOrder(input({ expectedTotal: '200.00' }))).rejects.toMatchObject({
      statusCode: 409,
      code: 'PRICE_CHANGED',
      details: { quote: { total: 206 } },
    })
    expect(prismaMock.$executeRaw).not.toHaveBeenCalled()
    expect(prismaMock.order.create).not.toHaveBeenCalled()
  })

  it('tope de pedidos por aceptar por teléfono, comparado ya normalizado (R23)', async () => {
    prismaMock.onlineOrder.count.mockResolvedValueOnce(3)
    await expect(
      createOnlineOrder(input({ verifiedPhone: '55 4345 3965', customer: { name: 'M', phone: '+52 55 4345 3965' } })),
    ).rejects.toMatchObject({ code: 'TOO_MANY_PENDING_ORDERS' })
    const where = (prismaMock.onlineOrder.count.mock.calls[0][0] as any).where
    expect(where.order.customerPhone).toBe(PHONE)
  })

  it('el tope del negocio se repite dentro del candado: 409 ORDERING_PAUSED por saturación', async () => {
    prismaMock.onlineOrder.count.mockResolvedValueOnce(0).mockResolvedValueOnce(30)
    await expect(createOnlineOrder(input())).rejects.toMatchObject({
      statusCode: 409,
      code: 'ORDERING_PAUSED',
      details: { status: 'PAUSED', reason: 'TOO_BUSY' },
    })
    expect(prismaMock.order.create).not.toHaveBeenCalled()
  })

  it('un teléfono verificado en formato viejo (+521) se guarda y se topa en su forma canónica +52 (R23)', async () => {
    await createOnlineOrder(input({ verifiedPhone: '+5215543453965', customer: { name: 'M', phone: '+525543453965' } }))
    const where = (prismaMock.onlineOrder.count.mock.calls[0][0] as any).where
    expect(where.order.customerPhone).toBe(PHONE)
    expect((prismaMock.order.create.mock.calls[0][0] as any).data.customerPhone).toBe(PHONE)
  })

  it('una tienda abierta que no acepta pagar al recoger responde 400 PAYMENT_MODE_NOT_ACCEPTED y no cotiza ni crea', async () => {
    ;(getAcceptingStatus as jest.Mock).mockResolvedValue({ ...OPEN, config: { ...OPEN.config, acceptsPayAtPickup: false } })
    await expect(createOnlineOrder(input())).rejects.toMatchObject({ statusCode: 400, code: 'PAYMENT_MODE_NOT_ACCEPTED' })
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
    }
    ;(prismaMock.$transaction as jest.Mock).mockImplementationOnce(async (fn: any) => fn(tx))

    await createOnlineOrder(input())

    expect(tx.$executeRaw).toHaveBeenCalledTimes(1)
    expect(tx.$executeRaw.mock.calls[0][1]).toBe('online-order-admission:v1')
    const lockAt = tx.$executeRaw.mock.invocationCallOrder[0]
    expect(tx.onlineOrder.count).toHaveBeenCalledTimes(2)
    for (const later of [
      tx.order.findUnique.mock.invocationCallOrder[0],
      ...tx.onlineOrder.count.mock.invocationCallOrder,
      tx.order.findFirst.mock.invocationCallOrder[0],
      tx.order.create.mock.invocationCallOrder[0],
      tx.onlineOrder.create.mock.invocationCallOrder[0],
    ]) {
      expect(lockAt).toBeLessThan(later)
    }
    // Nada de la admisión corre en el cliente raíz (fuera del candado): sólo la repetición previa.
    expect(prismaMock.$executeRaw).not.toHaveBeenCalled()
    expect(prismaMock.onlineOrder.count).not.toHaveBeenCalled()
    expect(prismaMock.order.findFirst).not.toHaveBeenCalled()
    expect(prismaMock.order.create).not.toHaveBeenCalled()
    expect(prismaMock.onlineOrder.create).not.toHaveBeenCalled()
    expect(prismaMock.order.findUnique).toHaveBeenCalledTimes(1)
  })

  it('una carrera (P2002) cuyo ganador es de OTRO cliente es 409 IDEMPOTENCY_KEY_CONFLICT sin su token (R8)', async () => {
    prismaMock.order.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(
      existing({
        id: 'ord9',
        customerId: 'otro-cliente',
        onlineOrder: oo({ id: 'oo9', status: 'PENDING_ACCEPTANCE', trackingToken: 'W'.repeat(32) }),
      }) as any,
    )
    ;(prismaMock.$transaction as jest.Mock).mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' }),
    )
    const err = await createOnlineOrder(input()).catch((e: unknown) => e)
    expect(err).toMatchObject({ statusCode: 409, code: 'IDEMPOTENCY_KEY_CONFLICT' })
    expect(JSON.stringify(err) + (err as Error).message).not.toContain('W'.repeat(32))
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

jest.mock('@/services/giftCards/giftCardSettings.service', () => ({
  assertGiftCardsSellable: jest.fn().mockResolvedValue(undefined),
  getGiftCardSettings: jest.fn().mockResolvedValue({
    enabled: true,
    suggestedAmounts: [500, 1000, 2000],
    minAmount: 100,
    maxAmount: 10000,
    validityMonths: 24,
    termsVersion: '2026-10-14',
    topePorOperacion: 70000,
    llavesConfiguradas: true,
    updatedAt: null,
  }),
}))
jest.mock('@/services/venueSalesGuard', () => ({ __esModule: true, assertVenueSalesEnabled: jest.fn() }))
jest.mock('@/utils/staff-venue.util', () => ({ validateStaffVenue: jest.fn(async (staffId: string) => staffId) }))

import { Prisma } from '@prisma/client'
import { assertGiftCardsSellable } from '@/services/giftCards/giftCardSettings.service'
import { createGiftCardOrder } from '@/services/giftCards/giftCardOrder.service'
import { encryptGiftCardCode, generateGiftCardCode, normalizeGiftCardCode } from '@/services/giftCards/giftCardCode'
import { cierreDelCobroSaldaLaCuenta } from '@/services/shared/orderBalance'
import { prismaMock } from '../../../__helpers__/setup'

const VENUE = 'venue-1'
const D = (v: number) => new Prisma.Decimal(v)
const creados = new Map<string, any>()

function armar() {
  creados.clear()
  prismaMock.$transaction.mockImplementation(async (cb: any) => cb(prismaMock))
  prismaMock.order.findUnique.mockReset().mockResolvedValue(null)
  prismaMock.venue.findUnique.mockResolvedValue({ organizationId: 'org-1' })
  prismaMock.shift.findFirst.mockResolvedValue({ id: 'turno-1' })
  prismaMock.giftCard.create.mockReset().mockImplementation(async ({ data }: any) => {
    const id = `gc-${creados.size + 1}`
    creados.set(id, { id, ...data })
    return { id }
  })
  prismaMock.order.create.mockReset().mockImplementation(async ({ data }: any) => ({
    id: 'order-1',
    orderNumber: data.orderNumber,
    total: data.total,
    status: data.status,
    items: data.items.create.map((it: any) => ({ giftCard: creados.get(it.giftCardId) })),
  }))
}

const pedido = (over: Record<string, unknown> = {}) => ({
  idempotencyKey: 'venta-tarjeta-0001',
  purchaserName: 'Ana',
  sobres: [
    { amount: 500, deliveryChannel: 'PRINTED' as const },
    {
      amount: 1000,
      deliveryChannel: 'WHATSAPP' as const,
      recipientName: 'Luis',
      recipientPhone: '55 1234 5678',
      message: '¡Feliz cumpleaños!',
    },
  ],
  ...over,
})

/** La cuenta como la devuelve la base para un reintento del pedido de arriba. */
function cuentaGuardada(montos: number[], estado: { cuenta: string; sobres: string } = { cuenta: 'CONFIRMED', sobres: 'PENDING' }) {
  const codigos = montos.map(() => generateGiftCardCode())
  return {
    id: 'order-1',
    orderNumber: 'ORD-1',
    total: D(montos.reduce((a, b) => a + b, 0)),
    status: estado.cuenta,
    items: montos.map((m, i) => ({
      giftCard: {
        id: `gc-${i + 1}`,
        status: estado.sobres,
        codeEnc: encryptGiftCardCode(codigos[i].normalized),
        codeLast4: codigos[i].last4,
        initialAmount: D(m),
        pageToken: `pt-${i}`,
        deliveryChannel: i === 0 ? 'PRINTED' : 'WHATSAPP',
        validityMonths: 24,
        termsVersion: '2026-10-14',
        recipientName: i === 0 ? null : 'Luis',
        recipientPhone: i === 0 ? null : '5512345678',
        recipientEmail: null,
        message: i === 0 ? null : '¡Feliz cumpleaños!',
        purchaserName: 'Ana',
        purchaserContact: null,
      },
    })),
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  armar()
})

describe('createGiftCardOrder', () => {
  it('un sobre PENDING por tarjeta, en $0, con la política CONGELADA y el código cifrado (nunca en claro)', async () => {
    const r = await createGiftCardOrder(VENUE, 'staff-1', pedido())

    expect(r.replay).toBe(false)
    expect(r.sobres).toHaveLength(2)
    // A5 r1: la primera respuesta también trae los estados (la cuenta abierta, los sobres por activarse).
    expect(r.status).toBe('CONFIRMED')
    expect(r.sobres.map(s => s.status)).toEqual(['PENDING', 'PENDING'])
    const [uno, dos] = [creados.get('gc-1'), creados.get('gc-2')]
    for (const [s, sobre] of [
      [uno, r.sobres[0]],
      [dos, r.sobres[1]],
    ] as const) {
      expect(normalizeGiftCardCode(sobre.codigo)).not.toBeNull()
      expect(s.codeEnc).not.toContain(normalizeGiftCardCode(sobre.codigo))
      expect(s.codeHash).toMatch(/^[0-9a-f]{64}$/)
      expect(s.codeLast4).toBe(sobre.ultimos4)
      expect(s).toMatchObject({
        status: 'PENDING',
        balance: D(0),
        validityMonths: 24,
        termsVersion: '2026-10-14',
        organizationId: 'org-1',
        source: 'POS',
      })
    }
    expect(uno).toMatchObject({ initialAmount: D(500), deliveryChannel: 'PRINTED', purchaserName: 'Ana' })
    expect(dos).toMatchObject({
      initialAmount: D(1000),
      deliveryChannel: 'WHATSAPP',
      recipientPhone: '5512345678',
      message: '¡Feliz cumpleaños!',
    })
  })

  it('🔴 C1 (cierre): la cuenta NUNCA nace POS — sin source (o con POS de una app vieja) es AVOQADO_ANDROID, autónoma', async () => {
    await createGiftCardOrder(VENUE, 'staff-1', pedido())
    await createGiftCardOrder(VENUE, 'staff-1', pedido({ source: 'POS' }))
    await createGiftCardOrder(VENUE, 'staff-1', pedido({ source: 'AVOQADO_IOS' }))
    const fuentes = prismaMock.order.create.mock.calls.map(([a]: any) => a.data.source)
    expect(fuentes).toEqual(['AVOQADO_ANDROID', 'AVOQADO_ANDROID', 'AVOQADO_IOS'])
    // `externalId` se queda (deduplica), y con una fuente autónoma el cierre del cobro sigue siendo SU dueño (activa los sobres).
    for (const [{ data }] of prismaMock.order.create.mock.calls as any[]) {
      expect(cierreDelCobroSaldaLaCuenta({ source: data.source, externalId: data.externalId, items: [] })).toBe(true)
    }
  })

  it('la cuenta: externalId giftcard:<llave>, sin IVA, una línea NO_OBJETO sin producto por sobre, total = suma', async () => {
    await createGiftCardOrder(VENUE, 'staff-1', pedido())
    const data = prismaMock.order.create.mock.calls[0][0].data
    expect(data).toMatchObject({
      venueId: VENUE,
      shiftId: 'turno-1',
      externalId: 'giftcard:venta-tarjeta-0001',
      type: 'TAKEOUT',
      status: 'CONFIRMED',
      paymentStatus: 'PENDING',
      contratoDePrecio: 'IVA_INCLUIDO',
      subtotal: D(1500),
      taxAmount: D(0),
      total: D(1500),
      remainingBalance: D(1500),
      customerName: 'Ana',
      createdById: 'staff-1',
    })
    expect(data.items.create).toEqual([
      expect.objectContaining({
        productId: null,
        productName: 'Tarjeta de regalo',
        quantity: 1,
        unitPrice: D(500),
        taxAmount: D(0),
        total: D(500),
        ivaTratamiento: 'NO_OBJETO',
        giftCardId: 'gc-1',
        sequence: 0,
      }),
      expect.objectContaining({
        productId: null,
        productName: 'Tarjeta de regalo',
        quantity: 1,
        unitPrice: D(1000),
        taxAmount: D(0),
        total: D(1000),
        ivaTratamiento: 'NO_OBJETO',
        giftCardId: 'gc-2',
        sequence: 1,
      }),
    ])
  })

  it('🔴 el MISMO pedido con la MISMA llave devuelve la cuenta y sus códigos sin crear nada (aunque el plan haya vencido)', async () => {
    prismaMock.order.findUnique.mockResolvedValue(cuentaGuardada([500, 1000]))

    const r = await createGiftCardOrder(VENUE, 'staff-1', pedido())

    expect(assertGiftCardsSellable).not.toHaveBeenCalled()
    expect(r.replay).toBe(true)
    expect(r.orderId).toBe('order-1')
    expect(r.sobres.map(s => s.monto)).toEqual([500, 1000])
    expect(normalizeGiftCardCode(r.sobres[0].codigo)).not.toBeNull()
    expect(prismaMock.giftCard.create).not.toHaveBeenCalled()
    expect(prismaMock.order.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { venueId_externalId: { venueId: VENUE, externalId: 'giftcard:venta-tarjeta-0001' } } }),
    )
  })

  it('🔴 A5 r1: el reintento DESPUÉS de cancelar la cuenta dice CANCELLED y cada sobre DEACTIVATED (el POS no entrega esos códigos)', async () => {
    prismaMock.order.findUnique.mockResolvedValue(cuentaGuardada([500, 1000], { cuenta: 'CANCELLED', sobres: 'DEACTIVATED' }))

    const r = await createGiftCardOrder(VENUE, 'staff-1', pedido())

    expect(r).toMatchObject({ replay: true, status: 'CANCELLED' })
    expect(r.sobres.map(s => s.status)).toEqual(['DEACTIVATED', 'DEACTIVATED'])
    expect(prismaMock.giftCard.create).not.toHaveBeenCalled()
  })

  it('🔴 la misma llave con OTRO contenido: IDEMPOTENCY_KEY_REUSED (409)', async () => {
    prismaMock.order.findUnique.mockResolvedValue(cuentaGuardada([500, 1000]))
    const otro = pedido({ sobres: [{ amount: 700, deliveryChannel: 'PRINTED' }] })
    await expect(createGiftCardOrder(VENUE, 'staff-1', otro)).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED', statusCode: 409 })
  })

  it('dos reintentos a la vez: el perdedor (P2002 en externalId) recibe la cuenta del ganador', async () => {
    prismaMock.order.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test' }),
    )
    prismaMock.order.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(cuentaGuardada([500, 1000]))

    await expect(createGiftCardOrder(VENUE, 'staff-1', pedido())).resolves.toMatchObject({ replay: true, orderId: 'order-1' })
  })

  it('función apagada o sin plan: ese error y nada se crea', async () => {
    ;(assertGiftCardsSellable as jest.Mock).mockRejectedValueOnce(Object.assign(new Error('apagada'), { code: 'GIFT_CARDS_DISABLED' }))
    await expect(createGiftCardOrder(VENUE, 'staff-1', pedido())).rejects.toMatchObject({ code: 'GIFT_CARDS_DISABLED' })
    expect(prismaMock.giftCard.create).not.toHaveBeenCalled()
  })

  it.each([
    [{ idempotencyKey: 'corta' }, 'idempotencyKey'],
    [{ sobres: [] }, 'al menos una tarjeta'],
    [{ sobres: [{ amount: 500, deliveryChannel: 'WHATSAPP' }] }, 'teléfono de 10 dígitos'],
    [{ sobres: [{ amount: 500, deliveryChannel: 'EMAIL', recipientEmail: 'no-es-correo' }] }, 'correo válido'],
    [{ sobres: [{ amount: 500, deliveryChannel: 'CUSTOMER_CARD' }] }, 'siguiente versión'],
    [{ sobres: [{ amount: 500, deliveryChannel: 'PRINTED', message: 'x'.repeat(201) }] }, '200 caracteres'],
    [{ sobres: Array.from({ length: 21 }, () => ({ amount: 100, deliveryChannel: 'PRINTED' })) }, 'como máximo 20'],
  ])('rechaza %o con 400 claro y sin crear nada', async (over, mensaje) => {
    await expect(createGiftCardOrder(VENUE, 'staff-1', pedido(over) as any)).rejects.toThrow(mensaje)
    expect(prismaMock.giftCard.create).not.toHaveBeenCalled()
  })

  it('topes del servidor: monto por sobre y suma de la operación (sin sugerir partirla)', async () => {
    await expect(
      createGiftCardOrder(VENUE, 'staff-1', pedido({ sobres: [{ amount: 99, deliveryChannel: 'PRINTED' }] })),
    ).rejects.toMatchObject({
      code: 'GIFT_CARD_AMOUNT_OUT_OF_RANGE',
    })
    const ocho = Array.from({ length: 8 }, () => ({ amount: 9000, deliveryChannel: 'PRINTED' as const }))
    await expect(createGiftCardOrder(VENUE, 'staff-1', pedido({ sobres: ocho }))).rejects.toMatchObject({
      code: 'GIFT_CARD_OPERATION_LIMIT',
    })
    expect(prismaMock.giftCard.create).not.toHaveBeenCalled()
  })
})

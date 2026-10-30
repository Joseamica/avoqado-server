/**
 * Reportes de tarjetas de regalo (C4): paginación del servidor con tope duro, orden estable, búsqueda, totales que no
 * dependen de las filas devueltas, días del negocio, libreta por cursor, antigüedad en SQL y CSV por páginas acotadas.
 */
import { EventEmitter } from 'events'
import { Prisma } from '@prisma/client'
import { prismaMock } from '@tests/__helpers__/setup'

jest.mock('@/services/dashboard/commission/commission-utils', () => ({
  ...jest.requireActual('@/services/dashboard/commission/commission-utils'),
  getVenueTimezone: jest.fn().mockResolvedValue('America/Mexico_City'),
}))
jest.mock('@/services/giftCards/giftCardCancel.service', () => ({
  ...jest.requireActual('@/services/giftCards/giftCardCancel.service'),
  estadoDeCancelacionDeVenta: jest.fn().mockResolvedValue({ allowed: true, reason: null, message: null }),
  bloqueosVigentes: jest.fn().mockResolvedValue(new Map()),
}))

import { bloqueosVigentes, estadoDeCancelacionDeVenta } from '@/services/giftCards/giftCardCancel.service'
import {
  WHERE_COBRO_ES_SALDO_DE_REGALO,
  WHERE_COBRO_NO_ES_SALDO_DE_REGALO,
  WHERE_ORDEN_DE_TARJETAS,
  WHERE_PAGO_PENDIENTE_DE_REVISION_CONTABLE,
} from '@/services/giftCards/giftCardMarks'
import { WHERE_PAGO_CONTABILIZABLE_SIN_ESTADO_DE_ORDEN } from '@/services/fiscal/autoPosting.service'
import { TEXTO_DE_FALLO_DE_ENTREGA } from '@/services/giftCards/giftCardEntrega'
import {
  LOTE_CSV,
  PAGINA_MAXIMA,
  celdaCsv,
  clampTamanoDePagina,
  getGiftCardDetail,
  getGiftCardLiabilityAging,
  getGiftCardSummary,
  listGiftCards,
  listPendingAccountingReview,
  streamGiftCardBalancesCsv,
} from '@/services/giftCards/giftCardReports.service'

const D = (v: string | number) => new Prisma.Decimal(v)
const m = (f: unknown) => f as jest.Mock
const tarjeta = (extra: Record<string, unknown> = {}) => ({
  id: 'gc1',
  codeLast4: 'K7QZ',
  status: 'ACTIVE',
  initialAmount: D('1000'),
  balance: D('400.50'),
  createdAt: new Date('2026-10-10T18:00:00.000Z'),
  activatedAt: new Date('2026-10-10T18:05:00.000Z'),
  expiresAt: null,
  deliveryChannel: 'WHATSAPP',
  deliveryStatus: 'PENDING',
  deliveredAt: null,
  deliveryErrorCode: null,
  recipientName: 'Ana',
  purchaserName: 'Luis',
  source: 'POS',
  customerId: null,
  orderItem: { orderId: 'o1', order: { orderNumber: 'ORD-1' } },
  ...extra,
})
const detalle = (extra: Record<string, unknown> = {}) => ({
  ...tarjeta(extra),
  validityMonths: null,
  termsVersion: '2026-10-14',
  message: null,
  recipientPhone: null,
  recipientEmail: null,
  purchaserContact: null,
  deliveredAt: null,
  deactivatedAt: null,
  deliveryAttempts: 0,
})
const renglon = (id: string, iso: string, type = 'REDEEM') => ({
  id,
  type,
  amount: D('100'),
  balanceAfter: D('400.5'),
  reason: null,
  note: null,
  createdAt: new Date(iso),
  staffId: 's1',
  paymentId: 'p1',
  refundPaymentId: null,
  orderId: 'o2',
})

beforeEach(() => {
  jest.clearAllMocks()
  prismaMock.customer.findMany.mockResolvedValue([])
  prismaMock.staff.findMany.mockResolvedValue([])
})

describe('tope de página (lo impone el servidor)', () => {
  it.each([
    [undefined, 50],
    [25, 25],
    [10000, 100],
    [-3, 50],
    ['abc', 50],
    [0, 50],
  ])('%p → %p', (raw, esperado) => {
    expect(clampTamanoDePagina(raw)).toBe(esperado)
  })
})

describe('lista', () => {
  it('🔴 un tamaño hostil se topa en 100; orden estable; el total sale del conteo, no de las filas', async () => {
    prismaMock.giftCard.aggregate.mockResolvedValue({ _count: { _all: 1234 }, _sum: { balance: D('98765.43') } })
    prismaMock.giftCard.findMany.mockResolvedValue([tarjeta()])
    const r = await listGiftCards('v1', { page: 3, pageSize: 10000 })
    expect(r).toMatchObject({ page: 3, pageSize: PAGINA_MAXIMA, total: 1234, totalBalance: 98765.43 })
    expect(prismaMock.giftCard.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { venueId: 'v1' }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: 200, take: 100 }),
    )
    // Total y saldo del filtro: UN agregado con el MISMO where que la página (decisión 1).
    expect(prismaMock.giftCard.aggregate).toHaveBeenCalledTimes(1)
    expect(prismaMock.giftCard.aggregate).toHaveBeenCalledWith({
      where: { venueId: 'v1' },
      _count: { _all: true },
      _sum: { balance: true },
    })
    expect(r.items[0]).toEqual({
      id: 'gc1',
      last4: 'K7QZ',
      status: 'ACTIVE',
      initialAmount: 1000,
      balance: 400.5,
      createdAt: '2026-10-10T18:00:00.000Z',
      activatedAt: '2026-10-10T18:05:00.000Z',
      expiresAt: null,
      deliveryChannel: 'WHATSAPP',
      deliveryStatus: 'PENDING',
      deliveredAt: null,
      deliveryErrorCode: null,
      deliveryError: null,
      recipientName: 'Ana',
      purchaserName: 'Luis',
      source: 'POS',
      customer: null,
      order: { id: 'o1', orderNumber: 'ORD-1' },
    })
  })

  it('S-10: cada fila dice cuándo se envió y, si falló, el código del fallo y su texto', async () => {
    prismaMock.giftCard.aggregate.mockResolvedValue({ _count: { _all: 3 }, _sum: { balance: D('1500') } })
    prismaMock.giftCard.findMany.mockResolvedValue([
      tarjeta({ id: 'gc1', deliveryStatus: 'SENT', deliveredAt: new Date('2026-10-20T17:00:00.000Z') }),
      tarjeta({ id: 'gc2', deliveryStatus: 'FAILED', deliveryErrorCode: 'WHATSAPP_SEND_FAILED' }),
      // Un código que escribió una versión más nueva: texto genérico, nunca `undefined`.
      tarjeta({ id: 'gc3', deliveryStatus: 'FAILED', deliveryErrorCode: 'ALGO_NUEVO' }),
    ])
    const r = await listGiftCards('v1', {})
    expect(prismaMock.giftCard.findMany.mock.calls[0][0].select).toMatchObject({ deliveredAt: true, deliveryErrorCode: true })
    expect(r.items.map(i => [i.id, i.deliveredAt, i.deliveryErrorCode, i.deliveryError])).toEqual([
      ['gc1', '2026-10-20T17:00:00.000Z', null, null],
      ['gc2', null, 'WHATSAPP_SEND_FAILED', TEXTO_DE_FALLO_DE_ENTREGA.WHATSAPP_SEND_FAILED],
      ['gc3', null, 'ALGO_NUEVO', 'No se pudo entregar la tarjeta. Reenvíala, cambia el destino o imprímela.'],
    ])
  })

  it('sin página ni tamaño: 50 desde la primera', async () => {
    prismaMock.giftCard.aggregate.mockResolvedValue({ _count: { _all: 0 }, _sum: { balance: null } })
    prismaMock.giftCard.findMany.mockResolvedValue([])
    await expect(listGiftCards('v1', {})).resolves.toEqual({ items: [], page: 1, pageSize: 50, total: 0, totalBalance: 0 })
    expect(prismaMock.giftCard.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 0, take: 50 }))
  })

  it('buscar «k7qz»: últimos 4 en mayúsculas, destinatario, comprador y el cliente guardado, TODO en el WHERE de GiftCard', async () => {
    prismaMock.giftCard.aggregate.mockResolvedValue({ _count: { _all: 1 }, _sum: { balance: D('400.50') } })
    prismaMock.giftCard.findMany.mockResolvedValue([tarjeta({ customerId: 'c1' })])
    prismaMock.customer.findMany.mockResolvedValueOnce([{ id: 'c1', firstName: 'Karla', lastName: 'Q' }])
    const r = await listGiftCards('v1', { search: 'k7qz' })
    const where = prismaMock.giftCard.findMany.mock.calls[0][0].where
    expect(where.venueId).toBe('v1')
    expect(where.OR).toEqual(
      expect.arrayContaining([
        { codeLast4: 'K7QZ' },
        { recipientName: { contains: 'k7qz', mode: 'insensitive' } },
        { purchaserName: { contains: 'k7qz', mode: 'insensitive' } },
        {
          customer: {
            is: {
              OR: [
                {
                  AND: [
                    {
                      OR: [
                        { firstName: { contains: 'k7qz', mode: 'insensitive' } },
                        { lastName: { contains: 'k7qz', mode: 'insensitive' } },
                      ],
                    },
                  ],
                },
                { email: { contains: 'k7qz', mode: 'insensitive' } },
                { phone: { contains: 'k7qz' } },
              ],
            },
          },
        },
      ]),
    )
    // 🔴 Auditoría r1 C-3: ninguna lista intermedia de clientes (topada en 50) ANTES de paginar; la única lectura de
    // clientes es la de los nombres de la página ya elegida. El total usa el MISMO where.
    expect(prismaMock.customer.findMany).toHaveBeenCalledTimes(1)
    expect(prismaMock.customer.findMany.mock.calls[0][0]).toMatchObject({ where: { venueId: 'v1', id: { in: ['c1'] } } })
    expect(prismaMock.giftCard.aggregate.mock.calls[0][0].where).toEqual(where)
    expect(r.items[0].customer).toEqual({ id: 'c1', name: 'Karla Q' })
  })

  it('un texto que no son 4 letras o números no busca por últimos 4', async () => {
    prismaMock.giftCard.aggregate.mockResolvedValue({ _count: { _all: 0 }, _sum: { balance: null } })
    prismaMock.giftCard.findMany.mockResolvedValue([])
    await listGiftCards('v1', { search: 'Ana María' })
    const or = prismaMock.giftCard.findMany.mock.calls[0][0].where.OR as Array<Record<string, unknown>>
    expect(or.some(c => 'codeLast4' in c)).toBe(false)
  })

  it('filtra por estado y por últimos 4 exactos (lo usa el MCP)', async () => {
    prismaMock.giftCard.aggregate.mockResolvedValue({ _count: { _all: 0 }, _sum: { balance: null } })
    prismaMock.giftCard.findMany.mockResolvedValue([])
    await listGiftCards('v1', { status: ['BLOCKED', 'DEACTIVATED'], last4: 'gh78', pageSize: 10 })
    expect(prismaMock.giftCard.findMany.mock.calls[0][0].where).toEqual({
      venueId: 'v1',
      status: { in: ['BLOCKED', 'DEACTIVATED'] },
      codeLast4: 'GH78',
    })
  })

  it('filtra por el folio de la venta sin importar mayúsculas, en la base y en el total (lo usa el asistente para escoger la tarjeta)', async () => {
    prismaMock.giftCard.aggregate.mockResolvedValue({ _count: { _all: 0 }, _sum: { balance: null } })
    prismaMock.giftCard.findMany.mockResolvedValue([])
    await listGiftCards('v1', { last4: '4821', folio: ' ord-7 ', pageSize: 10 })
    const where = {
      venueId: 'v1',
      codeLast4: '4821',
      orderItem: { is: { order: { orderNumber: { equals: 'ord-7', mode: 'insensitive' } } } },
    }
    expect(prismaMock.giftCard.findMany.mock.calls[0][0].where).toEqual(where)
    expect(prismaMock.giftCard.aggregate.mock.calls[0][0].where).toEqual(where)
  })

  it('⭐ (D3 menor 6) ACTIVE = se puede usar hoy: ACTIVE sin vencer (la misma frontera que EXPIRED), dentro de un AND que no choca con la búsqueda', async () => {
    const ahora = new Date('2026-10-14T18:00:00.000Z')
    const vigente = { status: 'ACTIVE', OR: [{ expiresAt: null }, { expiresAt: { gt: ahora } }] }
    prismaMock.giftCard.aggregate.mockResolvedValue({ _count: { _all: 0 }, _sum: { balance: null } })
    prismaMock.giftCard.findMany.mockResolvedValue([])
    await listGiftCards('v1', { status: ['ACTIVE'], search: 'Ana María' }, ahora)
    const where = prismaMock.giftCard.findMany.mock.calls[0][0].where
    expect(where.AND).toEqual([{ OR: [vigente] }])
    expect(where).not.toHaveProperty('status')
    expect(Array.isArray(where.OR)).toBe(true) // la búsqueda sigue en su propio OR
    expect(prismaMock.giftCard.aggregate.mock.calls[0][0].where).toEqual(where) // total y saldo con el MISMO filtro
    await listGiftCards('v1', { status: ['ACTIVE', 'BLOCKED', 'EXPIRED'] }, ahora)
    expect(prismaMock.giftCard.findMany.mock.calls[1][0].where.AND).toEqual([
      { OR: [{ status: { in: ['BLOCKED'] } }, vigente, { status: 'ACTIVE', expiresAt: { lte: ahora } }] },
    ])
  })

  it('🔴 EXPIRED (decisión 1; r1 #3: una sola frontera, vencida ⇔ expiresAt <= ahora): ACTIVE ya vencida en UTC; mezclado con otro estado, dentro de un AND que no choca con la búsqueda', async () => {
    const ahora = new Date('2026-10-14T18:00:00.000Z')
    prismaMock.giftCard.aggregate.mockResolvedValue({ _count: { _all: 0 }, _sum: { balance: null } })
    prismaMock.giftCard.findMany.mockResolvedValue([])
    await listGiftCards('v1', { status: ['EXPIRED'] }, ahora)
    expect(prismaMock.giftCard.findMany.mock.calls[0][0].where).toEqual({ venueId: 'v1', status: 'ACTIVE', expiresAt: { lte: ahora } })
    await listGiftCards('v1', { status: ['BLOCKED', 'EXPIRED'], search: 'Ana María' }, ahora)
    const where = prismaMock.giftCard.findMany.mock.calls[1][0].where
    expect(where.AND).toEqual([{ OR: [{ status: { in: ['BLOCKED'] } }, { status: 'ACTIVE', expiresAt: { lte: ahora } }] }])
    expect(Array.isArray(where.OR)).toBe(true) // la búsqueda sigue en su propio OR
    expect(prismaMock.giftCard.aggregate.mock.calls[1][0].where).toEqual(where)
  })
})

describe('detalle con su libreta', () => {
  it('una tarjeta de otro negocio o inexistente → 404 GIFT_CARD_NOT_FOUND', async () => {
    prismaMock.giftCard.findFirst.mockResolvedValue(null)
    await expect(getGiftCardDetail('v1', 'gcX', {})).rejects.toMatchObject({ code: 'GIFT_CARD_NOT_FOUND', statusCode: 404 })
    expect(prismaMock.giftCard.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'gcX', venueId: 'v1' } }))
  })

  it('la libreta pagina por cursor estable (createdAt, id) y trae su total', async () => {
    prismaMock.giftCard.findFirst.mockResolvedValue(detalle())
    prismaMock.giftCardActivity.count.mockResolvedValueOnce(3).mockResolvedValueOnce(1)
    prismaMock.giftCardActivity.findMany.mockResolvedValueOnce([
      renglon('a3', '2026-10-12T18:00:00.000Z'),
      renglon('a2', '2026-10-11T18:00:00.000Z'),
      renglon('a1', '2026-10-10T18:05:00.000Z', 'ACTIVATE'),
    ])
    prismaMock.staff.findMany.mockResolvedValue([{ id: 's1', firstName: 'Caja', lastName: 'Uno' }])
    const r = await getGiftCardDetail('v1', 'gc1', { limit: 2 })
    expect(prismaMock.giftCardActivity.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { giftCardId: 'gc1', venueId: 'v1' }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 3 }),
    )
    expect(r.activities.items.map(x => x.id)).toEqual(['a3', 'a2'])
    expect(r.activities.total).toBe(3)
    expect(r.activities.items[0]).toMatchObject({ amount: 100, balanceAfter: 400.5, staff: { id: 's1', name: 'Caja Uno' } })
    expect(r.hasRedeem).toBe(true)
    expect(r.canReplaceCode).toBe(false)
    // Decisión 1: el estado de cancelar SU venta sale de la regla de B2, con la cuenta de la venta del sobre.
    expect(estadoDeCancelacionDeVenta).toHaveBeenCalledWith('v1', 'o1')
    expect(r.cancel).toEqual({ allowed: true, reason: null, message: null })
    expect(r.activities.nextCursor).not.toBeNull()

    prismaMock.giftCardActivity.count.mockResolvedValueOnce(3).mockResolvedValueOnce(1)
    prismaMock.giftCardActivity.findMany.mockResolvedValueOnce([renglon('a1', '2026-10-10T18:05:00.000Z', 'ACTIVATE')])
    const r2 = await getGiftCardDetail('v1', 'gc1', { limit: 2, cursor: r.activities.nextCursor! })
    expect(prismaMock.giftCardActivity.findMany.mock.calls[1][0].where).toEqual({
      giftCardId: 'gc1',
      venueId: 'v1',
      OR: [
        { createdAt: { lt: new Date('2026-10-11T18:00:00.000Z') } },
        { createdAt: new Date('2026-10-11T18:00:00.000Z'), id: { lt: 'a2' } },
      ],
    })
    expect(r2.activities.items.map(x => x.id)).toEqual(['a1'])
    expect(r2.activities.nextCursor).toBeNull()
  })

  it('nota 2: el texto del rechazo de B2 pasa tal cual (el panel distingue los tres NOT_PAID); sin venta, ni se pregunta', async () => {
    const rechazo = {
      allowed: false,
      reason: 'NOT_PAID',
      message: 'Para devolver el dinero, reembolsa el cobro; al quedar en $0 la venta se cancela sola.',
    }
    m(estadoDeCancelacionDeVenta).mockResolvedValueOnce(rechazo)
    prismaMock.giftCard.findFirst.mockResolvedValue(detalle())
    prismaMock.giftCardActivity.count.mockResolvedValue(0)
    prismaMock.giftCardActivity.findMany.mockResolvedValue([])
    expect((await getGiftCardDetail('v1', 'gc1', {})).cancel).toEqual(rechazo)
    prismaMock.giftCard.findFirst.mockResolvedValue(detalle({ orderItem: null }))
    expect((await getGiftCardDetail('v1', 'gc1', {})).cancel).toEqual({ allowed: false, reason: null, message: null })
    expect(estadoDeCancelacionDeVenta).toHaveBeenCalledTimes(1)
  })

  it('un cursor alterado → 400 GIFT_CARD_CURSOR_INVALID', async () => {
    prismaMock.giftCard.findFirst.mockResolvedValue(detalle())
    await expect(getGiftCardDetail('v1', 'gc1', { cursor: 'no-es-un-cursor' })).rejects.toMatchObject({
      statusCode: 400,
      code: 'GIFT_CARD_CURSOR_INVALID',
    })
  })

  it('se puede reponer el código sólo si nadie la guardó, nunca se usó y sigue viva', async () => {
    prismaMock.giftCard.findFirst.mockResolvedValue(detalle({ customerId: null, status: 'ACTIVE' }))
    prismaMock.giftCardActivity.count.mockResolvedValueOnce(1).mockResolvedValueOnce(0)
    prismaMock.giftCardActivity.findMany.mockResolvedValueOnce([renglon('a1', '2026-10-10T18:05:00.000Z', 'ACTIVATE')])
    const r = await getGiftCardDetail('v1', 'gc1', {})
    expect(r).toMatchObject({ hasRedeem: false, canReplaceCode: true })
  })

  it('🔴 r1 D-2: bloqueada y con una página llena de ajustes posteriores, el motivo VIGENTE sale de su propia lectura', async () => {
    prismaMock.giftCard.findFirst.mockResolvedValue(detalle({ status: 'BLOCKED' }))
    prismaMock.giftCardActivity.count.mockResolvedValueOnce(60).mockResolvedValueOnce(0)
    // La primera página (límite 2) son puros ajustes: el BLOCK quedó en una página posterior.
    prismaMock.giftCardActivity.findMany.mockResolvedValueOnce([
      renglon('a60', '2026-10-13T18:00:00.000Z', 'ADJUST_DECREMENT'),
      renglon('a59', '2026-10-13T17:00:00.000Z', 'ADJUST_INCREMENT'),
      renglon('a58', '2026-10-13T16:00:00.000Z', 'ADJUST_DECREMENT'),
    ])
    m(bloqueosVigentes).mockResolvedValueOnce(
      new Map([['gc1', { reason: 'CANCEL_IN_PROGRESS', note: 'Cancelación de la venta ORD-1', at: new Date('2026-10-11T18:00:00.000Z') }]]),
    )
    const r = await getGiftCardDetail('v1', 'gc1', { limit: 2 })
    expect(r.activities.items.some(a => a.type === 'BLOCK')).toBe(false)
    expect(r.currentBlock).toEqual({ reason: 'CANCEL_IN_PROGRESS', note: 'Cancelación de la venta ORD-1', at: '2026-10-11T18:00:00.000Z' })
    expect(bloqueosVigentes).toHaveBeenCalledTimes(1)
    expect(m(bloqueosVigentes).mock.calls[0][1]).toEqual(['gc1'])
  })

  it('r1 D-2: una tarjeta que no está BLOCKED no tiene bloqueo vigente y no se consulta', async () => {
    prismaMock.giftCard.findFirst.mockResolvedValue(detalle({ status: 'ACTIVE' }))
    prismaMock.giftCardActivity.count.mockResolvedValue(0)
    prismaMock.giftCardActivity.findMany.mockResolvedValueOnce([])
    const r = await getGiftCardDetail('v1', 'gc1', {})
    expect(r.currentBlock).toBeNull()
    expect(bloqueosVigentes).not.toHaveBeenCalled()
  })

  it('el detalle trae la entrega con el destino enmascarado', async () => {
    prismaMock.giftCard.findFirst.mockResolvedValue({
      ...detalle({ deliveryStatus: 'FAILED', deliveryErrorCode: 'WHATSAPP_SEND_FAILED' }),
      recipientPhone: '+525512345678',
      deliveryAttempts: 4,
    })
    prismaMock.giftCardActivity.count.mockResolvedValue(0)
    prismaMock.giftCardActivity.findMany.mockResolvedValueOnce([])
    const r = await getGiftCardDetail('v1', 'gc1', {})
    expect(r.entrega).toEqual({
      channel: 'WHATSAPP',
      status: 'FAILED',
      deliveredAt: null,
      errorCode: 'WHATSAPP_SEND_FAILED',
      error: TEXTO_DE_FALLO_DE_ENTREGA.WHATSAPP_SEND_FAILED,
      destino: '55•••••678',
      intentos: 4,
    })
    expect(prismaMock.giftCard.findFirst.mock.calls[0][0].select).toMatchObject({
      deliveredAt: true,
      deliveryErrorCode: true,
      deliveryAttempts: true,
    })
    // El destino completo de la entrega nunca sale en `entrega`.
    expect(JSON.stringify(r.entrega)).not.toContain('5512345678')
  })

  it.each([
    [
      'correo enviado',
      {
        deliveryChannel: 'EMAIL',
        deliveryStatus: 'SENT',
        deliveredAt: new Date('2026-10-20T17:00:00.000Z'),
        recipientEmail: 'ana@gmail.com',
        deliveryAttempts: 1,
      },
      {
        channel: 'EMAIL',
        status: 'SENT',
        deliveredAt: '2026-10-20T17:00:00.000Z',
        errorCode: null,
        error: null,
        destino: 'a•••@gmail.com',
        intentos: 1,
      },
    ],
    [
      'impresa (S-8: sigue PENDING y no tiene destino)',
      { deliveryChannel: 'PRINTED', deliveryStatus: 'PENDING' },
      { channel: 'PRINTED', status: 'PENDING', deliveredAt: null, errorCode: null, error: null, destino: null, intentos: 0 },
    ],
  ])('la entrega del detalle: %s', async (_caso, fila, entrega) => {
    prismaMock.giftCard.findFirst.mockResolvedValue({ ...detalle(), ...fila })
    prismaMock.giftCardActivity.count.mockResolvedValue(0)
    prismaMock.giftCardActivity.findMany.mockResolvedValueOnce([])
    expect((await getGiftCardDetail('v1', 'gc1', {})).entrega).toEqual(entrega)
  })

  it('🔴 nunca pide ni expone el código, su huella ni sus llaves de página', async () => {
    prismaMock.giftCard.findFirst.mockResolvedValue(detalle())
    prismaMock.giftCardActivity.count.mockResolvedValue(0)
    prismaMock.giftCardActivity.findMany.mockResolvedValueOnce([])
    const r = await getGiftCardDetail('v1', 'gc1', {})
    const select = prismaMock.giftCard.findFirst.mock.calls[0][0].select
    for (const campo of ['codeEnc', 'codeHash', 'pageToken', 'cancelToken']) expect(select).not.toHaveProperty(campo)
    expect(JSON.stringify(r)).not.toMatch(/codeEnc|codeHash|pageToken|cancelToken/)
  })
})

describe('resumen del periodo', () => {
  it('cifras de la libreta en pesos exactos, con los días del negocio', async () => {
    prismaMock.giftCardActivity.groupBy.mockResolvedValue([
      { type: 'ACTIVATE', _sum: { amount: D('3000') }, _count: { _all: 3 } },
      { type: 'REDEEM', _sum: { amount: D('300.10') }, _count: { _all: 2 } },
      { type: 'REDEEM_REVERSAL', _sum: { amount: D('100.20') }, _count: { _all: 1 } },
      { type: 'DEACTIVATE', _sum: { amount: D('500') }, _count: { _all: 1 } },
      { type: 'ADJUST_INCREMENT', _sum: { amount: D('50') }, _count: { _all: 1 } },
      { type: 'ADJUST_DECREMENT', _sum: { amount: D('20.5') }, _count: { _all: 1 } },
    ])
    prismaMock.giftCard.aggregate
      .mockResolvedValueOnce({ _sum: { balance: D('2100.30') }, _count: { _all: 4 } })
      .mockResolvedValueOnce({ _sum: { balance: D('250') } })
    const r = await getGiftCardSummary('v1', { from: '2026-10-01', to: '2026-10-14' })
    expect(prismaMock.giftCardActivity.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        by: ['type'],
        where: {
          venueId: 'v1',
          createdAt: { gte: new Date('2026-10-01T06:00:00.000Z'), lte: new Date('2026-10-15T05:59:59.999Z') },
          // M4 (cierre): sin la desactivación de $0 de un sobre que nunca se activó.
          NOT: { type: 'DEACTIVATE', amount: { lte: 0 }, giftCard: { activities: { none: { type: 'ACTIVATE' } } } },
        },
      }),
    )
    expect(r).toMatchObject({
      from: '2026-10-01',
      to: '2026-10-14',
      timezone: 'America/Mexico_City',
      sold: { cards: 3, amount: 3000 },
      redeemed: { movements: 2, amount: 300.1, reversed: 100.2, net: 199.9 },
      cancelled: { cards: 1, amount: 500 },
      adjustments: { increments: 50, decrements: 20.5, net: 29.5 },
      liveBalance: { cards: 4, amount: 2100.3, expiredAmount: 250 },
    })
    expect(prismaMock.giftCard.aggregate.mock.calls[0][0].where).toEqual({
      venueId: 'v1',
      status: { in: ['ACTIVE', 'BLOCKED'] },
      balance: { gt: 0 },
    })
  })

  it('fecha inicial después de la final → 400 GIFT_CARD_RANGE_INVALID', async () => {
    await expect(getGiftCardSummary('v1', { from: '2026-10-14', to: '2026-10-01' })).rejects.toMatchObject({
      statusCode: 400,
      code: 'GIFT_CARD_RANGE_INVALID',
    })
  })

  it('sin movimientos: todo en cero, nunca undefined', async () => {
    prismaMock.giftCardActivity.groupBy.mockResolvedValue([])
    prismaMock.giftCard.aggregate
      .mockResolvedValueOnce({ _sum: { balance: null }, _count: { _all: 0 } })
      .mockResolvedValueOnce({ _sum: { balance: null } })
    const r = await getGiftCardSummary('v1', { from: '2026-10-01', to: '2026-10-01' })
    expect(r.sold).toEqual({ cards: 0, amount: 0 })
    expect(r.redeemed).toEqual({ movements: 0, amount: 0, reversed: 0, net: 0 })
    expect(r.liveBalance).toMatchObject({ cards: 0, amount: 0, expiredAmount: 0 })
  })
})

describe('saldo vivo a una fecha, por antigüedad', () => {
  it('cubos en orden fijo, montos exactos y SQL con LATERAL y binds UTC', async () => {
    prismaMock.$queryRaw.mockResolvedValue([
      { bucket: '91-180', cards: 1, amount: '500.00' },
      { bucket: '0-30', cards: 2, amount: '650.50' },
      { bucket: '366+', cards: 1, amount: '250.00' },
    ])
    const r = await getGiftCardLiabilityAging('v1', '2026-10-14')
    expect(r.buckets).toEqual([
      { bucket: '0-30', cards: 2, amount: 650.5 },
      { bucket: '31-90', cards: 0, amount: 0 },
      { bucket: '91-180', cards: 1, amount: 500 },
      { bucket: '181-365', cards: 0, amount: 0 },
      { bucket: '366+', cards: 1, amount: 250 },
    ])
    expect(r.total).toEqual({ cards: 4, amount: 1400.5 })
    expect(r).toMatchObject({ at: '2026-10-14', timezone: 'America/Mexico_City' })
    const sql = prismaMock.$queryRaw.mock.calls[0][0] as Prisma.Sql
    // Auditoría r1 C-4: sin «vencido al corte» (la vigencia de HOY no reconstruye la de un corte pasado).
    expect(sql.sql).not.toMatch(/expiresAt/)
    expect(sql.sql).toMatch(/CROSS JOIN LATERAL/)
    expect(sql.sql).toMatch(/LIMIT 1/)
    expect(sql.sql).toMatch(/AT TIME ZONE 'UTC'/)
    expect(sql.values).toContain('v1')
    expect(sql.values).toContainEqual(new Date('2026-10-15T05:59:59.999Z'))
  })

  it('una fecha imposible → 400', async () => {
    await expect(getGiftCardLiabilityAging('v1', '2026-13-40')).rejects.toMatchObject({ statusCode: 400 })
  })
})

describe('pendientes de revisión contable', () => {
  it('pagos que el autoposteo no postea: su clase, página topada, orden estable y totales por clase', async () => {
    prismaMock.payment.count.mockResolvedValue(3)
    prismaMock.payment.findMany.mockResolvedValue([
      {
        id: 'p3',
        createdAt: new Date('2026-10-12T18:00:00.000Z'),
        amount: D('-100'),
        tipAmount: D('0'),
        method: 'OTHER',
        type: 'REFUND',
        tenderLabel: 'Tarjeta de regalo',
        tenderType: { systemKind: 'GIFT_CARD' },
        order: { id: 'o2', orderNumber: 'ORD-2' },
      },
      {
        id: 'p2',
        createdAt: new Date('2026-10-11T18:00:00.000Z'),
        amount: D('300'),
        tipAmount: D('20'),
        method: 'OTHER',
        type: 'REGULAR',
        tenderLabel: 'Tarjeta de regalo',
        tenderType: { systemKind: 'GIFT_CARD' },
        order: { id: 'o2', orderNumber: 'ORD-2' },
      },
      {
        id: 'p1',
        createdAt: new Date('2026-10-10T18:00:00.000Z'),
        amount: D('1000'),
        tipAmount: D('0'),
        method: 'CASH',
        type: 'REGULAR',
        tenderLabel: null,
        tenderType: null,
        order: { id: 'o1', orderNumber: 'ORD-1' },
      },
    ])
    prismaMock.payment.groupBy
      .mockResolvedValueOnce([
        { type: 'REGULAR', _sum: { amount: D('300'), tipAmount: D('20') }, _count: { _all: 1 } },
        { type: 'REFUND', _sum: { amount: D('-100'), tipAmount: D('0') }, _count: { _all: 1 } },
      ])
      .mockResolvedValueOnce([{ type: 'REGULAR', _sum: { amount: D('1000'), tipAmount: D('0') }, _count: { _all: 1 } }])
    const r = await listPendingAccountingReview('v1', { from: '2026-10-01', to: '2026-10-14', pageSize: 999 })
    expect(r.items.map(x => [x.paymentId, x.kind])).toEqual([
      ['p3', 'REVERSO_DE_SALDO'],
      ['p2', 'COBRO_CON_SALDO'],
      ['p1', 'VENTA_DE_TARJETAS'],
    ])
    expect(r.items[1]).toMatchObject({
      amount: 300,
      tipAmount: 20,
      method: 'OTHER',
      tenderLabel: 'Tarjeta de regalo',
      order: { id: 'o2', orderNumber: 'ORD-2' },
    })
    expect(r).toMatchObject({ page: 1, pageSize: 100, total: 3, from: '2026-10-01', to: '2026-10-14' })
    expect(r.totals).toEqual({
      VENTA_DE_TARJETAS: { count: 1, amount: 1000, tipAmount: 0 },
      CANCELACION_DE_VENTA: { count: 0, amount: 0, tipAmount: 0 },
      COBRO_CON_SALDO: { count: 1, amount: 300, tipAmount: 20 },
      REVERSO_DE_SALDO: { count: 1, amount: -100, tipAmount: 0 },
    })
    // Nota 1 del coordinador: lo que el motor saltó, SIN «orden no cancelada» (una venta devuelta entera deja la orden CANCELLED
    // y no debe desaparecer del listado). Lista, conteo y los dos totales: el mismo día del negocio y el mismo fragmento.
    const dias = { venueId: 'v1', createdAt: { gte: new Date('2026-10-01T06:00:00.000Z'), lte: new Date('2026-10-15T05:59:59.999Z') } }
    const args = prismaMock.payment.findMany.mock.calls[0][0]
    expect(args.where).toEqual({ ...dias, AND: [WHERE_PAGO_CONTABILIZABLE_SIN_ESTADO_DE_ORDEN, WHERE_PAGO_PENDIENTE_DE_REVISION_CONTABLE] })
    expect(prismaMock.payment.count.mock.calls[0][0].where).toEqual(args.where)
    expect(prismaMock.payment.groupBy.mock.calls[0][0].where).toEqual({
      ...dias,
      AND: [WHERE_PAGO_CONTABILIZABLE_SIN_ESTADO_DE_ORDEN, WHERE_COBRO_ES_SALDO_DE_REGALO],
    })
    expect(prismaMock.payment.groupBy.mock.calls[1][0].where).toEqual({
      ...dias,
      AND: [WHERE_PAGO_CONTABILIZABLE_SIN_ESTADO_DE_ORDEN, { order: WHERE_ORDEN_DE_TARJETAS }, WHERE_COBRO_NO_ES_SALDO_DE_REGALO],
    })
    expect(JSON.stringify(args.where)).not.toMatch(/CANCELLED/)
    expect(args.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }])
    expect(args.take).toBe(100)
    // El costo de la mercancía del canje ya está en libros (póliza de costo de ventas, B4): el listado lo avisa.
    expect(r.notice).toMatch(/costo de ventas/)
  })

  it('🔴 la venta de tarjetas excluye el tender del saldo con las marcas de B1, sin NOT (con NULL se perderían los pagos sin tender)', async () => {
    prismaMock.payment.count.mockResolvedValue(0)
    prismaMock.payment.findMany.mockResolvedValue([])
    prismaMock.payment.groupBy.mockResolvedValue([])
    await listPendingAccountingReview('v1', { from: '2026-10-01', to: '2026-10-14' })
    const venta = prismaMock.payment.groupBy.mock.calls[1][0].where
    expect(venta.AND).toEqual(expect.arrayContaining([{ order: WHERE_ORDEN_DE_TARJETAS }, WHERE_COBRO_NO_ES_SALDO_DE_REGALO]))
    // El único NOT es el de «monto y propina en cero» del fragmento contable (columnas NOT NULL); la parte del tender no lleva NOT.
    const sinElFragmento = venta.AND.filter((c: unknown) => c !== WHERE_PAGO_CONTABILIZABLE_SIN_ESTADO_DE_ORDEN)
    expect(JSON.stringify(sinElFragmento)).not.toMatch(/"NOT"/)
  })
})

describe('exportar saldos vivos (CSV)', () => {
  // `clearAllMocks` no tira los `mockResolvedValueOnce` que una prueba dejó sin consumir (la del «close» deja un lote): sin esto,
  // la siguiente recibe el lote de otra.
  beforeEach(() => {
    prismaMock.giftCard.findMany.mockReset().mockResolvedValue([])
  })
  const loteLleno = () =>
    Array.from({ length: LOTE_CSV }, (_, i) => ({
      id: `gc${String(i).padStart(4, '0')}`,
      codeLast4: 'AAAA',
      status: 'ACTIVE',
      initialAmount: D('500'),
      balance: D('500'),
      activatedAt: new Date('2026-10-10T18:00:00.000Z'),
      expiresAt: null,
      customerId: null,
      recipientName: null,
      purchaserName: null,
      orderItem: null,
    }))
  /** Una respuesta HTTP de mentiras que SÍ emite eventos ('drain', 'close'), como la de Express. */
  const respuestaFalsa = (write: (s: string) => boolean) =>
    Object.assign(new EventEmitter(), { destroyed: false, setHeader: jest.fn(), write: jest.fn(write), end: jest.fn() }) as any
  const vueltas = async () => {
    for (let i = 0; i < 10; i++) await new Promise(r => setImmediate(r))
  }

  it('recorre páginas por id hasta la corta, con BOM, encabezado, montos en pesos y fechas del negocio', async () => {
    const lleno = loteLleno()
    prismaMock.giftCard.findMany.mockResolvedValueOnce(lleno).mockResolvedValueOnce([
      {
        ...lleno[0],
        id: 'gz9999',
        codeLast4: 'ZZZZ',
        status: 'BLOCKED',
        balance: D('80.5'),
        recipientName: '=HYPERLINK("http://x")',
        orderItem: { order: { orderNumber: 'ORD-9' } },
      },
    ])
    const escrito: string[] = []
    const res = respuestaFalsa(linea => {
      escrito.push(linea)
      return true
    })
    await streamGiftCardBalancesCsv('v1', res)
    expect(prismaMock.giftCard.findMany).toHaveBeenCalledTimes(2)
    expect(prismaMock.giftCard.findMany.mock.calls[0][0]).toMatchObject({
      where: { venueId: 'v1', status: { in: ['ACTIVE', 'BLOCKED'] }, balance: { gt: 0 } },
      orderBy: { id: 'asc' },
      take: LOTE_CSV,
    })
    expect(prismaMock.giftCard.findMany.mock.calls[1][0].where.id).toEqual({ gt: lleno[LOTE_CSV - 1].id })
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/csv; charset=utf-8')
    expect(res.setHeader).toHaveBeenCalledWith(
      'Content-Disposition',
      expect.stringMatching(/^attachment; filename="saldos-tarjetas-de-regalo-\d{4}-\d{2}-\d{2}\.csv"$/),
    )
    expect(escrito[0]).toBe('\uFEFFÚltimos 4,Estado,Monto inicial,Saldo,Activada,Vence,Cliente,Destinatario,Comprador,Cuenta\r\n')
    expect(escrito).toHaveLength(LOTE_CSV + 2)
    expect(escrito[escrito.length - 1]).toBe(`ZZZZ,Bloqueada,500.00,80.50,2026-10-10,,,"'=HYPERLINK(""http://x"")",,ORD-9\r\n`)
    expect(res.end).toHaveBeenCalledTimes(1)
  })

  it('🔴 r1 C-5: si el receptor va lento (`write` → false) espera «drain» y NO pide la siguiente página antes', async () => {
    prismaMock.giftCard.findMany.mockResolvedValueOnce(loteLleno()).mockResolvedValueOnce([])
    let n = 0
    let atorado = true
    // El encabezado entra; la primera fila llena el búfer.
    const res = respuestaFalsa(() => {
      n += 1
      return n === 1 || !atorado
    })
    const corrida = streamGiftCardBalancesCsv('v1', res)
    await vueltas()
    expect(res.write).toHaveBeenCalledTimes(2)
    expect(prismaMock.giftCard.findMany).toHaveBeenCalledTimes(1)
    atorado = false
    res.emit('drain')
    await corrida
    expect(res.write).toHaveBeenCalledTimes(LOTE_CSV + 1)
    expect(prismaMock.giftCard.findMany).toHaveBeenCalledTimes(2)
    expect(res.end).toHaveBeenCalledTimes(1)
  })

  it('🔴 r1 C-5: si el cliente se desconecta («close») deja de consultar y no se queda esperando', async () => {
    prismaMock.giftCard.findMany.mockResolvedValueOnce(loteLleno()).mockResolvedValueOnce(loteLleno())
    let n = 0
    const res: any = respuestaFalsa(() => {
      n += 1
      if (n === 3) {
        res.emit('close')
        return false
      }
      return true
    })
    await streamGiftCardBalancesCsv('v1', res)
    expect(res.write).toHaveBeenCalledTimes(3)
    expect(prismaMock.giftCard.findMany).toHaveBeenCalledTimes(1)
    expect(res.end).not.toHaveBeenCalled()
    expect(res.listenerCount('close')).toBe(0)
  })

  it('🔴 C4 r1 #1: el cliente ya se fue ANTES de que se escuchara su «close» (destroyed, `write` → false, sin eventos): termina sin leer la base', async () => {
    const res: any = respuestaFalsa(() => false)
    res.destroyed = true
    await streamGiftCardBalancesCsv('v1', res) // con el defecto, esta promesa nunca terminaba
    expect(prismaMock.giftCard.findMany).not.toHaveBeenCalled()
    expect(res.write).not.toHaveBeenCalled()
    expect(res.end).not.toHaveBeenCalled()
    expect(res.listenerCount('close') + res.listenerCount('drain')).toBe(0)
  })

  it('🔴 C4 r1 #1: el socket muere ENTRE lotes (sin «close»): no escribe más, no pide otro lote ni deja un «drain» pendiente', async () => {
    let res: any = null
    prismaMock.giftCard.findMany.mockResolvedValueOnce(loteLleno()).mockImplementationOnce(async () => {
      res.destroyed = true // se fue mientras se leía el segundo lote
      return loteLleno()
    })
    res = respuestaFalsa(() => !res.destroyed)
    await streamGiftCardBalancesCsv('v1', res)
    expect(res.write).toHaveBeenCalledTimes(LOTE_CSV + 1) // encabezado + el primer lote; nada del segundo
    expect(prismaMock.giftCard.findMany).toHaveBeenCalledTimes(2)
    expect(res.end).not.toHaveBeenCalled()
    expect(res.listenerCount('close') + res.listenerCount('drain')).toBe(0)
  })

  it('🔴 C4 r1 #1: el socket muere EN un `write` (devuelve false y ya no emitirá nada): no espera un «drain» que nunca llega', async () => {
    prismaMock.giftCard.findMany.mockResolvedValueOnce(loteLleno()).mockResolvedValueOnce(loteLleno())
    let n = 0
    const res: any = respuestaFalsa(() => {
      n += 1
      if (n === 3) res.destroyed = true
      return n < 3
    })
    await streamGiftCardBalancesCsv('v1', res)
    expect(res.write).toHaveBeenCalledTimes(3)
    expect(prismaMock.giftCard.findMany).toHaveBeenCalledTimes(1)
    expect(res.end).not.toHaveBeenCalled()
    expect(res.listenerCount('close') + res.listenerCount('drain')).toBe(0)
  })

  it('celdas a prueba de fórmulas y de comas', () => {
    expect(celdaCsv('=1+1')).toBe("'=1+1")
    expect(celdaCsv('+52 55 1234 5678')).toBe("'+52 55 1234 5678")
    expect(celdaCsv('Ana, la de ventas')).toBe('"Ana, la de ventas"')
    expect(celdaCsv(80.5)).toBe('80.50')
    expect(celdaCsv(null)).toBe('')
  })
})

/**
 * El gancho ÚNICO de reembolsos (índice 1a, R2): lo llaman `issueRefund` (panel, POS, MCP) y `recordRefund` (terminal) dentro de su
 * transacción. Un cobro con saldo regresa al saldo; la venta de tarjetas sólo se devuelve con la cancelación iniciada (B2), salvo que la
 * terminal YA haya devuelto el dinero: entonces se desactivan los sobres y queda una anomalía.
 */
jest.mock('@/services/giftCards/giftCardLedger', () => ({
  revertirCanjeEnTx: jest.fn().mockResolvedValue([]),
  desactivarSobresDeCuentaEnTx: jest.fn().mockResolvedValue(undefined),
  lockGiftCardsForUpdate: jest.fn().mockResolvedValue([]),
  operarSobreDeGerenteEnTx: jest.fn().mockResolvedValue({ activityIds: [], replay: false }),
  // Nota 1 de B1 (ruling 7 de A8): el rechazo de un sobre DEACTIVATED es el REAL; lee las terminaciones con el `tx` falso.
  rechazarSiRegresaASobreDesactivado: jest.requireActual('@/services/giftCards/giftCardLedger').rechazarSiRegresaASobreDesactivado,
}))
jest.mock('@/services/giftCards/giftCardAnomaly', () => ({ recordGiftCardAnomaly: jest.fn().mockResolvedValue(undefined) }))

import { Prisma } from '@prisma/client'
import { alRegistrarReembolsoEnTx, bloquearSobresDelReembolsoEnTx } from '@/services/giftCards/giftCardCancel.service'
import { desactivarSobresDeCuentaEnTx, lockGiftCardsForUpdate, revertirCanjeEnTx } from '@/services/giftCards/giftCardLedger'
import { recordGiftCardAnomaly } from '@/services/giftCards/giftCardAnomaly'

type Sobre = { id: string; status: 'PENDING' | 'ACTIVE' | 'BLOCKED' | 'DEACTIVATED'; codeLast4?: string }
interface Escenario {
  esDeTarjetas?: boolean
  sobres?: Sobre[]
  canjes?: number
  /** Último BLOCK/UNBLOCK de cada sobre (lo usa B2). */
  bloqueos?: Array<{ giftCardId: string; type: 'BLOCK' | 'UNBLOCK'; reason: string | null }>
  sobresDelCanje?: string[]
  cobroLeido?: { orderId: string; tenderType: { systemKind: string | null } | null } | null
  /** La venta de tarjetas está PAGADA (default). `false` = todavía no (E4: sin pagar no se toca ningún sobre). */
  pagada?: boolean
}

function txFalso(e: Escenario = {}) {
  const sobres = e.sobres ?? []
  return {
    payment: { findFirst: jest.fn().mockResolvedValue(e.cobroLeido ?? null) },
    order: { findFirst: jest.fn().mockResolvedValue({ paymentStatus: e.pagada === false ? 'PARTIAL' : 'PAID' }) },
    orderItem: {
      findFirst: jest.fn().mockImplementation(({ where }: { where: { giftCardId: unknown } }) => {
        if (where.giftCardId === null) return Promise.resolve(e.esDeTarjetas ? null : { id: 'oi-merc' })
        return Promise.resolve(e.esDeTarjetas ? { id: 'oi-gc' } : null)
      }),
      findMany: jest.fn().mockResolvedValue(sobres.map(s => ({ giftCardId: s.id }))),
    },
    giftCard: { findMany: jest.fn().mockResolvedValue(sobres) },
    giftCardActivity: {
      count: jest.fn().mockResolvedValue(e.canjes ?? 0),
      findMany: jest.fn().mockResolvedValue((e.sobresDelCanje ?? []).map(giftCardId => ({ giftCardId }))),
    },
    $queryRaw: jest.fn().mockResolvedValue(e.bloqueos ?? []),
  } as unknown as Prisma.TransactionClient
}

const base = {
  venueId: 'v1',
  originalPaymentId: 'pay-1',
  refundPaymentId: 'ref-1',
  amount: new Prisma.Decimal('200'),
  staffId: 's1',
}

beforeEach(() => jest.clearAllMocks())

describe('alRegistrarReembolsoEnTx', () => {
  it('🔴 cobro con saldo: revierte el canje con el importe y el reembolso exactos, sin mirar la cuenta', async () => {
    const tx = txFalso()
    await alRegistrarReembolsoEnTx(tx, { ...base, original: { orderId: 'o-merc', tenderSystemKind: 'GIFT_CARD' } })
    expect(revertirCanjeEnTx).toHaveBeenCalledWith(tx, {
      venueId: 'v1',
      originalPaymentId: 'pay-1',
      refundPaymentId: 'ref-1',
      amount: new Prisma.Decimal('200'),
      staffId: 's1',
    })
    expect(desactivarSobresDeCuentaEnTx).not.toHaveBeenCalled()
  })

  it('regresión: un cobro normal de una cuenta de mercancía no toca nada', async () => {
    const tx = txFalso({ esDeTarjetas: false })
    await alRegistrarReembolsoEnTx(tx, { ...base, original: { orderId: 'o-merc', tenderSystemKind: null } })
    expect(revertirCanjeEnTx).not.toHaveBeenCalled()
    expect(desactivarSobresDeCuentaEnTx).not.toHaveBeenCalled()
    expect(lockGiftCardsForUpdate).not.toHaveBeenCalled()
  })

  it('🔴 R2: la venta de tarjetas sin cancelación iniciada, desde el panel ⇒ GIFT_CARD_CANCEL_NOT_STARTED y nada se desactiva', async () => {
    const tx = txFalso({ esDeTarjetas: true, sobres: [{ id: 'gc1', status: 'ACTIVE' }] })
    await expect(alRegistrarReembolsoEnTx(tx, { ...base, original: { orderId: 'o-gc', tenderSystemKind: null } })).rejects.toMatchObject({
      code: 'GIFT_CARD_CANCEL_NOT_STARTED',
    })
    expect(desactivarSobresDeCuentaEnTx).not.toHaveBeenCalled()
  })

  it('🔴 R2: con un sobre ya usado ⇒ GIFT_CARD_ALREADY_USED', async () => {
    const tx = txFalso({ esDeTarjetas: true, sobres: [{ id: 'gc1', status: 'ACTIVE' }], canjes: 1 })
    await expect(alRegistrarReembolsoEnTx(tx, { ...base, original: { orderId: 'o-gc', tenderSystemKind: null } })).rejects.toMatchObject({
      code: 'GIFT_CARD_ALREADY_USED',
    })
  })

  it('una venta ya desactivada (segundo cobro de la misma cuenta) se acepta sin tocar nada', async () => {
    const tx = txFalso({ esDeTarjetas: true, sobres: [{ id: 'gc1', status: 'DEACTIVATED' }] })
    await alRegistrarReembolsoEnTx(tx, { ...base, original: { orderId: 'o-gc', tenderSystemKind: null } })
    expect(desactivarSobresDeCuentaEnTx).not.toHaveBeenCalled()
    expect(recordGiftCardAnomaly).not.toHaveBeenCalled()
  })

  it('🔴 terminal (el dinero YA salió): desactiva los sobres y deja la anomalía REFUND_WITHOUT_CANCEL en vez de rechazar', async () => {
    const tx = txFalso({ esDeTarjetas: true, sobres: [{ id: 'gc1', status: 'ACTIVE' }] })
    await alRegistrarReembolsoEnTx(tx, { ...base, dineroYaDevuelto: true, original: { orderId: 'o-gc', tenderSystemKind: null } })
    expect(lockGiftCardsForUpdate).toHaveBeenCalledWith(tx, ['gc1'])
    // E4 (excepción escrita): la venta PAGADA se leyó ANTES de cualquier candado de sobre.
    expect((tx.order.findFirst as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(
      (lockGiftCardsForUpdate as jest.Mock).mock.invocationCallOrder[0],
    )
    expect(desactivarSobresDeCuentaEnTx).toHaveBeenCalledWith(tx, {
      venueId: 'v1',
      orderId: 'o-gc',
      refundPaymentId: 'ref-1',
      reason: 'SALE_CANCELLED',
      staffId: 's1',
      dineroYaDevuelto: true,
    })
    expect(recordGiftCardAnomaly).toHaveBeenCalledWith(tx, {
      check: 'REFUND_WITHOUT_CANCEL',
      id: 'ref-1',
      venueId: 'v1',
      detail: { orderId: 'o-gc', originalPaymentId: 'pay-1', canjes: 0, monto: '200' },
    })
  })

  it('🔴 E4: una venta de tarjetas SIN pagar, desde el panel ⇒ GIFT_CARD_CANCEL_NOT_STARTED sin leer ni bloquear un solo sobre', async () => {
    const tx = txFalso({ esDeTarjetas: true, pagada: false, sobres: [{ id: 'gc1', status: 'PENDING' }] })
    await expect(alRegistrarReembolsoEnTx(tx, { ...base, original: { orderId: 'o-gc', tenderSystemKind: null } })).rejects.toMatchObject({
      code: 'GIFT_CARD_CANCEL_NOT_STARTED',
    })
    expect(tx.order.findFirst).toHaveBeenCalledWith({ where: { id: 'o-gc', venueId: 'v1' }, select: { paymentStatus: true } })
    expect(tx.orderItem.findMany).not.toHaveBeenCalled()
    expect(lockGiftCardsForUpdate).not.toHaveBeenCalled()
  })

  it('🔴 E4 + E1: la terminal devolvió dinero de una venta SIN pagar ⇒ se registra con anomalía, sin candados ni desactivar', async () => {
    const tx = txFalso({ esDeTarjetas: true, pagada: false, sobres: [{ id: 'gc1', status: 'PENDING' }] })
    await alRegistrarReembolsoEnTx(tx, { ...base, dineroYaDevuelto: true, original: { orderId: 'o-gc', tenderSystemKind: null } })
    expect(lockGiftCardsForUpdate).not.toHaveBeenCalled()
    expect(desactivarSobresDeCuentaEnTx).not.toHaveBeenCalled()
    expect(recordGiftCardAnomaly).toHaveBeenCalledWith(tx, {
      check: 'REFUND_WITHOUT_CANCEL',
      id: 'ref-1',
      venueId: 'v1',
      detail: { orderId: 'o-gc', originalPaymentId: 'pay-1', ventaPagada: false, monto: '200' },
    })
  })

  it('sin `original`, lee el cobro bajo la transacción del reembolso', async () => {
    const tx = txFalso({ cobroLeido: { orderId: 'o-merc', tenderType: { systemKind: 'GIFT_CARD' } } })
    await alRegistrarReembolsoEnTx(tx, base)
    expect(tx.payment.findFirst).toHaveBeenCalledWith({
      where: { id: 'pay-1', venueId: 'v1' },
      select: { orderId: true, tenderType: { select: { systemKind: true } } },
    })
    expect(revertirCanjeEnTx).toHaveBeenCalled()
  })
})

describe('bloquearSobresDelReembolsoEnTx (orden de candados: Order → Payment → sobres → Shift)', () => {
  it('cobro con saldo: bloquea los sobres de sus canjes', async () => {
    const tx = txFalso({ sobresDelCanje: ['gc2', 'gc1', 'gc2'] })
    await bloquearSobresDelReembolsoEnTx(tx, {
      venueId: 'v1',
      originalPaymentId: 'pay-1',
      original: { orderId: 'o', tenderSystemKind: 'GIFT_CARD' },
    })
    expect(lockGiftCardsForUpdate).toHaveBeenCalledWith(tx, ['gc2', 'gc1'])
  })

  it('venta de tarjetas: bloquea los sobres de la cuenta', async () => {
    const tx = txFalso({
      esDeTarjetas: true,
      sobres: [
        { id: 'gc1', status: 'ACTIVE' },
        { id: 'gc2', status: 'ACTIVE' },
      ],
    })
    await bloquearSobresDelReembolsoEnTx(tx, {
      venueId: 'v1',
      originalPaymentId: 'pay-1',
      original: { orderId: 'o', tenderSystemKind: null },
    })
    expect(lockGiftCardsForUpdate).toHaveBeenCalledWith(tx, ['gc1', 'gc2'])
  })

  it('regresión: un cobro normal no bloquea nada', async () => {
    const tx = txFalso({ esDeTarjetas: false })
    await bloquearSobresDelReembolsoEnTx(tx, {
      venueId: 'v1',
      originalPaymentId: 'pay-1',
      original: { orderId: 'o', tenderSystemKind: null },
    })
    expect(lockGiftCardsForUpdate).not.toHaveBeenCalled()
  })

  it('🔴 E4 (excepción escrita): la venta PAGADA se comprueba ANTES de cualquier consulta de candado de sobre', async () => {
    const tx = txFalso({ esDeTarjetas: true, sobres: [{ id: 'gc1', status: 'ACTIVE' }] })
    await bloquearSobresDelReembolsoEnTx(tx, {
      venueId: 'v1',
      originalPaymentId: 'pay-1',
      original: { orderId: 'o', tenderSystemKind: null },
    })
    expect(tx.order.findFirst).toHaveBeenCalledWith({ where: { id: 'o', venueId: 'v1' }, select: { paymentStatus: true } })
    const leyoPagada = (tx.order.findFirst as jest.Mock).mock.invocationCallOrder[0]
    expect(leyoPagada).toBeLessThan((tx.orderItem.findMany as jest.Mock).mock.invocationCallOrder[0])
    expect(leyoPagada).toBeLessThan((lockGiftCardsForUpdate as jest.Mock).mock.invocationCallOrder[0])
  })

  it('🔴 E4: una venta de tarjetas que NO está pagada no bloquea ningún sobre (su activación puede estar en curso)', async () => {
    const tx = txFalso({ esDeTarjetas: true, pagada: false, sobres: [{ id: 'gc1', status: 'PENDING' }] })
    await bloquearSobresDelReembolsoEnTx(tx, {
      venueId: 'v1',
      originalPaymentId: 'pay-1',
      original: { orderId: 'o', tenderSystemKind: null },
    })
    expect(tx.orderItem.findMany).not.toHaveBeenCalled()
    expect(lockGiftCardsForUpdate).not.toHaveBeenCalled()
  })
})

describe('B1 · nota 1: nunca regresar saldo a un sobre DEACTIVATED (ruling 7 de A8)', () => {
  const sobreBloqueado = (status: 'ACTIVE' | 'DEACTIVATED') => ({
    id: 'gc1',
    venueId: 'v1',
    codeHash: 'h',
    status,
    balance: new Prisma.Decimal(0),
    initialAmount: new Prisma.Decimal(500),
    expiresAt: null,
    activatedAt: null,
    validityMonths: null,
    customerId: null,
  })

  it('🔴 cobro con saldo cuyo sobre ya se canceló ⇒ 409 GIFT_CARD_TENDER_NOT_ALLOWED con la terminación, ANTES de que el núcleo escriba', async () => {
    const tx = txFalso({ sobresDelCanje: ['gc1'], sobres: [{ id: 'gc1', status: 'DEACTIVATED', codeLast4: '7788' }] })
    ;(lockGiftCardsForUpdate as jest.Mock).mockResolvedValueOnce([sobreBloqueado('DEACTIVATED')])
    const intento = bloquearSobresDelReembolsoEnTx(tx, {
      venueId: 'v1',
      originalPaymentId: 'pay-1',
      original: { orderId: 'o-merc', tenderSystemKind: 'GIFT_CARD' },
    })
    await expect(intento).rejects.toMatchObject({
      code: 'GIFT_CARD_TENDER_NOT_ALLOWED',
      statusCode: 409,
      details: { motivo: 'SOBRE_DESACTIVADO', giftCardIds: ['gc1'] },
    })
    await expect(intento).rejects.toThrow(/terminación 7788/)
    // Las terminaciones se leen con tope y en el negocio del reembolso.
    expect(tx.giftCard.findMany).toHaveBeenCalledWith({
      where: { venueId: 'v1', id: { in: ['gc1'] } },
      select: { id: true, codeLast4: true },
      orderBy: { id: 'asc' },
      take: 1,
    })
  })

  it('regresión: con el sobre vivo el pre-candado no rechaza ni lee terminaciones', async () => {
    const tx = txFalso({ sobresDelCanje: ['gc1'] })
    ;(lockGiftCardsForUpdate as jest.Mock).mockResolvedValueOnce([sobreBloqueado('ACTIVE')])
    await bloquearSobresDelReembolsoEnTx(tx, {
      venueId: 'v1',
      originalPaymentId: 'pay-1',
      original: { orderId: 'o', tenderSystemKind: 'GIFT_CARD' },
    })
    expect(tx.giftCard.findMany).not.toHaveBeenCalled()
  })
})

describe('B1 · nota 2: una devolución nunca deja dinero atrapado (A6)', () => {
  it('🔴 venta PAGADA con TODOS sus sobres ya desactivados (dinero que llegó después) se devuelve desde el panel sin GIFT_CARD_CANCEL_NOT_STARTED', async () => {
    const tx = txFalso({
      esDeTarjetas: true,
      sobres: [
        { id: 'gc1', status: 'DEACTIVATED' },
        { id: 'gc2', status: 'DEACTIVATED' },
      ],
      canjes: 1,
    })
    await expect(alRegistrarReembolsoEnTx(tx, { ...base, original: { orderId: 'o-gc', tenderSystemKind: null } })).resolves.toBeUndefined()
    // Ni siquiera un sobre ya usado lo frena: ya no hay saldo vivo que proteger.
    expect(desactivarSobresDeCuentaEnTx).not.toHaveBeenCalled()
    expect(recordGiftCardAnomaly).not.toHaveBeenCalled()
  })
})

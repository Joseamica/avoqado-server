/**
 * El gancho ÚNICO de reembolsos (índice 1a, R2): lo llaman `issueRefund` (panel, POS, MCP) y `recordRefund` (terminal) dentro de su
 * transacción. Un cobro con saldo regresa al saldo; la venta de tarjetas PAGADA sólo se devuelve con la cancelación iniciada (B2), salvo
 * que la terminal YA haya devuelto el dinero: entonces se desactivan los sobres y queda una anomalía. La venta SIN pagar (r1, fix 1) se
 * devuelve sin tocar sobres mientras quede dinero, y la devolución que deja lo conservado en $0 cancela la cuenta.
 */
jest.mock('@/services/giftCards/giftCardLedger', () => ({
  revertirCanjeEnTx: jest.fn().mockResolvedValue([]),
  desactivarSobresDeCuentaEnTx: jest.fn().mockResolvedValue(undefined),
  lockGiftCardsForUpdate: jest.fn().mockResolvedValue([]),
  operarSobreDeGerenteEnTx: jest.fn().mockResolvedValue({ activityIds: [], replay: false }),
  desactivarSobresPendientesDeCuentaEnTx: jest.fn().mockResolvedValue({ desactivados: [] }),
}))
jest.mock('@/services/giftCards/giftCardAnomaly', () => ({ recordGiftCardAnomaly: jest.fn().mockResolvedValue(undefined) }))
jest.mock('@/services/shared/orderCancelGuard', () => ({ findLiveTerminalCharge: jest.fn().mockResolvedValue(null) }))

import { Prisma } from '@prisma/client'
import { alRegistrarReembolsoEnTx, bloquearSobresDelReembolsoEnTx } from '@/services/giftCards/giftCardCancel.service'
import {
  desactivarSobresDeCuentaEnTx,
  desactivarSobresPendientesDeCuentaEnTx,
  lockGiftCardsForUpdate,
  revertirCanjeEnTx,
} from '@/services/giftCards/giftCardLedger'
import { recordGiftCardAnomaly } from '@/services/giftCards/giftCardAnomaly'
import { findLiveTerminalCharge } from '@/services/shared/orderCancelGuard'

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
  /** Dinero de la cuenta YA con este reembolso escrito (pesos; venta y propina por separado, las devoluciones en positivo). */
  dinero?: { cobrado: number; cobradoPropina?: number; devuelto: number; devueltoPropina?: number }
  /** Otro camino ya canceló la cuenta: el CAS de la cancelación no encuentra la fila. */
  yaCancelada?: boolean
}

const D = (v: number) => new Prisma.Decimal(v)
/** Un sobre como lo devuelve `lockGiftCardsForUpdate`. */
const bloqueado = (id: string, status: Sobre['status'], balance: number, initialAmount: number) => ({
  id,
  venueId: 'v1',
  codeHash: 'h',
  status,
  balance: D(balance),
  initialAmount: D(initialAmount),
  expiresAt: null,
  activatedAt: null,
  validityMonths: null,
  customerId: null,
})

function txFalso(e: Escenario = {}) {
  const sobres = e.sobres ?? []
  const dinero = e.dinero ?? { cobrado: 200, devuelto: 0 }
  return {
    payment: {
      findFirst: jest.fn().mockResolvedValue(e.cobroLeido ?? null),
      // Las devoluciones se guardan NEGATIVAS (`summarizeRefunds`).
      aggregate: jest
        .fn()
        .mockImplementation(({ where }: { where: { type?: unknown } }) =>
          Promise.resolve(
            where.type === 'REFUND'
              ? { _sum: { amount: D(-dinero.devuelto), tipAmount: D(-(dinero.devueltoPropina ?? 0)) } }
              : { _sum: { amount: D(dinero.cobrado), tipAmount: D(dinero.cobradoPropina ?? 0) } },
          ),
        ),
    },
    order: {
      findFirst: jest.fn().mockResolvedValue({ paymentStatus: e.pagada === false ? 'PARTIAL' : 'PAID' }),
      updateMany: jest.fn().mockResolvedValue({ count: e.yaCancelada ? 0 : 1 }),
    },
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
    ;(lockGiftCardsForUpdate as jest.Mock).mockResolvedValueOnce([bloqueado('gc1', 'ACTIVE', 500, 500)])
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
      // r1 (fix 4): un reembolso PARCIAL desactiva igual la cuenta entera; la anomalía dice cuánto saldo vivo se apagó.
      detail: { orderId: 'o-gc', originalPaymentId: 'pay-1', canjes: 0, monto: '200', parcial: true, saldoDesactivado: '500.00' },
    })
  })

  it('r1 (fix 4): la devolución de la venta COMPLETA no es parcial; el saldo apagado suma sólo los sobres vivos', async () => {
    const tx = txFalso({
      esDeTarjetas: true,
      sobres: [
        { id: 'gc1', status: 'ACTIVE' },
        { id: 'gc2', status: 'BLOCKED' },
      ],
    })
    ;(lockGiftCardsForUpdate as jest.Mock).mockResolvedValueOnce([
      bloqueado('gc1', 'ACTIVE', 120, 300),
      bloqueado('gc2', 'BLOCKED', 200, 200),
    ])
    await alRegistrarReembolsoEnTx(tx, {
      ...base,
      amount: D(500),
      dineroYaDevuelto: true,
      original: { orderId: 'o-gc', tenderSystemKind: null },
    })
    expect(recordGiftCardAnomaly).toHaveBeenCalledWith(tx, {
      check: 'REFUND_WITHOUT_CANCEL',
      id: 'ref-1',
      venueId: 'v1',
      detail: { orderId: 'o-gc', originalPaymentId: 'pay-1', canjes: 0, monto: '500', parcial: false, saldoDesactivado: '320.00' },
    })
  })

  it.each([
    ['el panel', false],
    ['la terminal', true],
  ])(
    '🔴 r1 (fix 1): una venta de tarjetas SIN pagar se devuelve desde %s; mientras quede dinero, ni un sobre se lee, bloquea ni desactiva (E4) y la cuenta sigue abierta',
    async (_canal, dineroYaDevuelto) => {
      const tx = txFalso({
        esDeTarjetas: true,
        pagada: false,
        sobres: [{ id: 'gc1', status: 'PENDING' }],
        dinero: { cobrado: 200, devuelto: 100 },
      })
      await expect(
        alRegistrarReembolsoEnTx(tx, { ...base, amount: D(100), dineroYaDevuelto, original: { orderId: 'o-gc', tenderSystemKind: null } }),
      ).resolves.toEqual({ cuentaCancelada: false })
      expect(tx.order.findFirst).toHaveBeenCalledWith({ where: { id: 'o-gc', venueId: 'v1' }, select: { paymentStatus: true } })
      expect(tx.orderItem.findMany).not.toHaveBeenCalled()
      expect(tx.giftCard.findMany).not.toHaveBeenCalled()
      expect(lockGiftCardsForUpdate).not.toHaveBeenCalled()
      expect(desactivarSobresDeCuentaEnTx).not.toHaveBeenCalled()
      expect(desactivarSobresPendientesDeCuentaEnTx).not.toHaveBeenCalled()
      expect(tx.order.updateMany).not.toHaveBeenCalled()
      // Ya no es una anomalía: devolver un abono de una venta sin pagar es un camino normal (los sobres PENDING no valen nada).
      expect(recordGiftCardAnomaly).not.toHaveBeenCalled()
    },
  )

  it('🔴 r1 (fix 1): la devolución que deja lo conservado en $0 cancela la cuenta (CAS) y desactiva sus sobres PENDING, en la misma tx', async () => {
    const tx = txFalso({ esDeTarjetas: true, pagada: false, dinero: { cobrado: 200, devuelto: 200 } })
    await expect(alRegistrarReembolsoEnTx(tx, { ...base, original: { orderId: 'o-gc', tenderSystemKind: null } })).resolves.toEqual({
      cuentaCancelada: true,
    })
    // Lo conservado se mide con TODO el dinero de la cuenta (venta + propina), sólo cobros COMPLETED.
    expect(tx.payment.aggregate).toHaveBeenCalledWith({
      where: { venueId: 'v1', orderId: 'o-gc', status: 'COMPLETED', OR: [{ type: null }, { type: { not: 'REFUND' } }] },
      _sum: { amount: true, tipAmount: true },
    })
    expect(tx.payment.aggregate).toHaveBeenCalledWith({
      where: { venueId: 'v1', orderId: 'o-gc', status: 'COMPLETED', type: 'REFUND' },
      _sum: { amount: true, tipAmount: true },
    })
    expect(findLiveTerminalCharge).toHaveBeenCalledWith(tx, { venueId: 'v1', orderId: 'o-gc' })
    expect(tx.order.updateMany).toHaveBeenCalledWith({
      where: { id: 'o-gc', venueId: 'v1', status: { notIn: ['CANCELLED', 'DELETED'] } },
      data: { status: 'CANCELLED', version: { increment: 1 } },
    })
    expect(desactivarSobresPendientesDeCuentaEnTx).toHaveBeenCalledWith(tx, { venueId: 'v1', orderId: 'o-gc', staffId: 's1' })
    // La cuenta se lee y se cancela ANTES de tocar un solo sobre.
    expect((tx.order.updateMany as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(
      (desactivarSobresPendientesDeCuentaEnTx as jest.Mock).mock.invocationCallOrder[0],
    )
    expect(lockGiftCardsForUpdate).not.toHaveBeenCalled()
  })

  it('r1 (fix 1): la propina cuenta como dinero conservado: con la venta devuelta y la propina no, la cuenta sigue abierta', async () => {
    const tx = txFalso({ esDeTarjetas: true, pagada: false, dinero: { cobrado: 200, cobradoPropina: 20, devuelto: 200 } })
    await expect(alRegistrarReembolsoEnTx(tx, { ...base, original: { orderId: 'o-gc', tenderSystemKind: null } })).resolves.toEqual({
      cuentaCancelada: false,
    })
    expect(tx.order.updateMany).not.toHaveBeenCalled()
  })

  it('r1 (fix 1): con un cobro de terminal VIVO sobre la cuenta no se cancela (la cuenta sigue; su desenlace decide)', async () => {
    const tx = txFalso({ esDeTarjetas: true, pagada: false, dinero: { cobrado: 200, devuelto: 200 } })
    ;(findLiveTerminalCharge as jest.Mock).mockResolvedValueOnce({ requestId: 'req-vivo' })
    await expect(alRegistrarReembolsoEnTx(tx, { ...base, original: { orderId: 'o-gc', tenderSystemKind: null } })).resolves.toEqual({
      cuentaCancelada: false,
    })
    expect(tx.order.updateMany).not.toHaveBeenCalled()
    expect(desactivarSobresPendientesDeCuentaEnTx).not.toHaveBeenCalled()
  })

  it('r1 (fix 1): si otro camino ya la canceló, no la cancela dos veces (y desactivar PENDING es idempotente)', async () => {
    const tx = txFalso({ esDeTarjetas: true, pagada: false, dinero: { cobrado: 200, devuelto: 200 }, yaCancelada: true })
    await expect(alRegistrarReembolsoEnTx(tx, { ...base, original: { orderId: 'o-gc', tenderSystemKind: null } })).resolves.toEqual({
      cuentaCancelada: false,
    })
    expect(desactivarSobresPendientesDeCuentaEnTx).toHaveBeenCalled()
  })

  it('los demás caminos no cancelan nada: cobro con saldo, cuenta normal y venta pagada', async () => {
    await expect(
      alRegistrarReembolsoEnTx(txFalso(), { ...base, original: { orderId: 'o-merc', tenderSystemKind: 'GIFT_CARD' } }),
    ).resolves.toEqual({ cuentaCancelada: false })
    await expect(
      alRegistrarReembolsoEnTx(txFalso({ esDeTarjetas: false }), { ...base, original: { orderId: 'o-merc', tenderSystemKind: null } }),
    ).resolves.toEqual({ cuentaCancelada: false })
    const pagadaYa = txFalso({ esDeTarjetas: true, sobres: [{ id: 'gc1', status: 'DEACTIVATED' }] })
    await expect(alRegistrarReembolsoEnTx(pagadaYa, { ...base, original: { orderId: 'o-gc', tenderSystemKind: null } })).resolves.toEqual({
      cuentaCancelada: false,
    })
    expect(pagadaYa.order.updateMany).not.toHaveBeenCalled()
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

describe('B1 · nota 1 (r1, fix 2): el pre-candado sólo BLOQUEA; quién recibe saldo lo decide `revertirCanjeEnTx` en la misma tx', () => {
  it('🔴 con un sobre DEACTIVATED entre los del canje, el pre-candado NO rechaza: uno ya devuelto completo no debe atrapar la parte de otro vivo', async () => {
    const tx = txFalso({ sobresDelCanje: ['gc1', 'gc2'] })
    ;(lockGiftCardsForUpdate as jest.Mock).mockResolvedValueOnce([
      bloqueado('gc1', 'DEACTIVATED', 0, 100),
      bloqueado('gc2', 'ACTIVE', 0, 100),
    ])
    await expect(
      bloquearSobresDelReembolsoEnTx(tx, {
        venueId: 'v1',
        originalPaymentId: 'pay-1',
        original: { orderId: 'o-merc', tenderSystemKind: 'GIFT_CARD' },
      }),
    ).resolves.toBeUndefined()
    expect(lockGiftCardsForUpdate).toHaveBeenCalledWith(tx, ['gc1', 'gc2'])
    expect(tx.giftCard.findMany).not.toHaveBeenCalled()
  })

  it('regresión: con el sobre vivo el pre-candado no rechaza ni lee terminaciones', async () => {
    const tx = txFalso({ sobresDelCanje: ['gc1'] })
    ;(lockGiftCardsForUpdate as jest.Mock).mockResolvedValueOnce([bloqueado('gc1', 'ACTIVE', 0, 500)])
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
    await expect(alRegistrarReembolsoEnTx(tx, { ...base, original: { orderId: 'o-gc', tenderSystemKind: null } })).resolves.toEqual({
      cuentaCancelada: false,
    })
    // Ni siquiera un sobre ya usado lo frena: ya no hay saldo vivo que proteger.
    expect(desactivarSobresDeCuentaEnTx).not.toHaveBeenCalled()
    expect(recordGiftCardAnomaly).not.toHaveBeenCalled()
  })
})

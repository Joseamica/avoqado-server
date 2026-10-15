/**
 * «Regresar el saldo y cancelar» (Tarea A8, r1). Con DOS cobros con saldo, todos los candados —cobros originales y la
 * UNIÓN de sus sobres— se toman ANTES del primer `writeRefundInTx`, que reclama el turno (E4: nunca un sobre después del
 * turno). Y la función ya no escribe `ActivityLog`: dice `replay` y la bitácora la escribe C3 (F9).
 */
jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: jest.fn(() => null) } }))
jest.mock('@/services/shared/tableOrderLock', () => ({
  ...jest.requireActual('@/services/shared/tableOrderLock'),
  lockTableOrderScope: jest.fn().mockResolvedValue({ tables: [] }),
}))
jest.mock('@/services/shared/orderCancelGuard', () => ({
  ...jest.requireActual('@/services/shared/orderCancelGuard'),
  assertNoLiveTerminalCharge: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('@/services/kds/kitchenTicketAuthoring.service', () => ({
  ...jest.requireActual('@/services/kds/kitchenTicketAuthoring.service'),
  retirarComandasDeVentaAnulada: jest.fn().mockResolvedValue({ kdsOrderIds: [], kdsOrderItemIds: [] }),
}))
jest.mock('@/services/tpv/table.tpv.service', () => ({
  ...jest.requireActual('@/services/tpv/table.tpv.service'),
  reconcileTableAfterOrderRemovedInTransaction: jest.fn().mockResolvedValue({ tables: [] }),
}))
jest.mock('@/services/referrals/referralRefund.service', () => ({ onOrderCancelled: jest.fn().mockResolvedValue(undefined) }))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))
const bloquearMock = jest.fn()
const reembolsoMock = jest.fn()
jest.mock('@/services/shared/writeRefundInTx', () => ({
  bloquearCobroParaReembolso: (...a: unknown[]) => bloquearMock(...a),
  writeRefundInTx: (...a: unknown[]) => reembolsoMock(...a),
}))
jest.mock('@/services/tpv/paymentEffects.service', () => ({
  ...jest.requireActual('@/services/tpv/paymentEffects.service'),
  enqueueRefundPaymentEffectsInTx: jest.fn().mockResolvedValue(undefined),
}))
const lockMock = jest.fn()
const sobresMock = jest.fn()
const revertirMock = jest.fn()
jest.mock('@/services/giftCards/giftCardLedger', () => ({
  ...jest.requireActual('@/services/giftCards/giftCardLedger'),
  lockGiftCardsForUpdate: (...a: unknown[]) => lockMock(...a),
  sobresDelCanje: (...a: unknown[]) => sobresMock(...a),
  revertirCanjeEnTx: (...a: unknown[]) => revertirMock(...a),
}))

import { createHash } from 'crypto'
import { Prisma } from '@prisma/client'
import { logAction } from '@/services/dashboard/activity-log.service'
import { returnGiftBalanceAndCancelOrder } from '@/services/mobile/order.mobile.service'
import { prismaMock } from '../../../__helpers__/setup'

const D = (v: number) => new Prisma.Decimal(v)
const LLAVE = 'regresa-0001-abc'
const RAIZ = 'gr' + createHash('sha256').update(LLAVE).digest('hex').slice(0, 48)

beforeEach(() => {
  jest.clearAllMocks()
  prismaMock.$transaction.mockImplementation(async (cb: any) => cb(prismaMock))
  prismaMock.staff.findUnique.mockResolvedValue({ id: 'staff-1' })
  prismaMock.staffVenue.findFirst.mockResolvedValue({ id: 'sv-1', staffId: 'staff-1', venueId: 'venue-1', active: true })
  prismaMock.order.findUnique.mockReset().mockResolvedValue({ id: 'order-1', status: 'CONFIRMED', paymentStatus: 'PARTIAL' })
  prismaMock.payment.findUnique.mockReset().mockResolvedValue(null)
  prismaMock.venueTenderType.findFirst.mockResolvedValue({ id: 'tt-gift' })
  prismaMock.payment.findMany.mockResolvedValue([
    { id: 'pay-1', tenderTypeId: 'tt-gift' },
    { id: 'pay-2', tenderTypeId: 'tt-gift' },
  ])
  prismaMock.order.update.mockResolvedValue({ tableId: null })
  bloquearMock.mockImplementation(async (_tx: unknown, p: { paymentId: string }) => ({
    original: { id: p.paymentId, amount: D(200), tipAmount: D(0) },
    refundedSalesCents: 0,
    refundedTipsCents: 0,
  }))
  sobresMock.mockImplementation(async (_tx: unknown, p: { paymentId: string }) => (p.paymentId === 'pay-1' ? ['gc-1'] : ['gc-2']))
  lockMock.mockResolvedValue([])
  reembolsoMock.mockImplementation(async (_tx: unknown, p: { originalPaymentId: string }) => ({
    refundPaymentId: `ref-${p.originalPaymentId}`,
  }))
  revertirMock.mockResolvedValue([])
})

describe('returnGiftBalanceAndCancelOrder', () => {
  it('🔴 r1 (A-3): dos cobros con saldo — cobros y la UNIÓN de sus sobres se bloquean ANTES del primer writeRefundInTx', async () => {
    await expect(returnGiftBalanceAndCancelOrder('venue-1', 'order-1', { staffId: 'staff-1', operationKey: LLAVE })).resolves.toEqual({
      replay: false,
    })

    const primerReembolso = Math.min(...reembolsoMock.mock.invocationCallOrder)
    expect(bloquearMock).toHaveBeenCalledTimes(2)
    expect(Math.max(...bloquearMock.mock.invocationCallOrder)).toBeLessThan(primerReembolso)
    // Un solo candado de sobres, con los de LOS DOS cobros, antes del turno (el ORDER BY canónico es el de la libreta).
    expect(lockMock).toHaveBeenCalledTimes(1)
    expect(lockMock).toHaveBeenCalledWith(prismaMock, ['gc-1', 'gc-2'])
    expect(lockMock.mock.invocationCallOrder[0]).toBeLessThan(primerReembolso)
    // El bucle reusa cada bloqueo y conserva las llaves por índice.
    expect(reembolsoMock.mock.calls.map(c => [c[1].originalPaymentId, c[1].idempotencyKey, c[1].bloqueado.original.id])).toEqual([
      ['pay-1', `${RAIZ}:0`, 'pay-1'],
      ['pay-2', `${RAIZ}:1`, 'pay-2'],
    ])
    expect(revertirMock).toHaveBeenCalledTimes(2)
  })

  it('r1 (F9): no escribe la bitácora de tarjetas (su dueño es C3)', async () => {
    await returnGiftBalanceAndCancelOrder('venue-1', 'order-1', { staffId: 'staff-1', operationKey: LLAVE })
    expect(logAction).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'GIFT_CARD_BALANCE_RETURNED_ORDER_CANCELLED' }))
  })

  it('r1 (F9): la misma llave sobre la cuenta que ya canceló es una repetición: `replay: true` y nada se escribe', async () => {
    prismaMock.order.findUnique.mockResolvedValue({ id: 'order-1', status: 'CANCELLED', paymentStatus: 'PARTIAL' })
    prismaMock.payment.findUnique.mockResolvedValue({ orderId: 'order-1' })
    await expect(returnGiftBalanceAndCancelOrder('venue-1', 'order-1', { staffId: 'staff-1', operationKey: LLAVE })).resolves.toEqual({
      replay: true,
    })
    expect(bloquearMock).not.toHaveBeenCalled()
    expect(reembolsoMock).not.toHaveBeenCalled()
    expect(logAction).not.toHaveBeenCalled()
  })
})

/** Decisiones del coordinador para A8: rulings 5 y 7, y la numeración de las llaves de reverso. */
describe('returnGiftBalanceAndCancelOrder — rulings del coordinador', () => {
  const sobre = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    venueId: 'venue-1',
    codeHash: 'h',
    status: 'ACTIVE',
    balance: D(0),
    initialAmount: D(500),
    expiresAt: null,
    activatedAt: new Date('2026-09-01T18:00:00Z'),
    validityMonths: null,
    customerId: null,
    ...over,
  })

  it('🔴 ruling 7: un sobre DESACTIVADO no recibe saldo de vuelta — 409 antes de escribir nada; el cobro sigue vivo en la cuenta', async () => {
    lockMock.mockResolvedValue([sobre('gc-1'), sobre('gc-2', { status: 'DEACTIVATED' })])
    prismaMock.giftCard.findMany.mockResolvedValue([{ id: 'gc-2', codeLast4: '4321' }])

    await expect(returnGiftBalanceAndCancelOrder('venue-1', 'order-1', { staffId: 'staff-1', operationKey: LLAVE })).rejects.toMatchObject({
      code: 'GIFT_CARD_TENDER_NOT_ALLOWED',
      statusCode: 409,
      message: expect.stringContaining('4321'),
      details: { motivo: 'SOBRE_DESACTIVADO', giftCardIds: ['gc-2'] },
    })
    expect(reembolsoMock).not.toHaveBeenCalled()
    expect(revertirMock).not.toHaveBeenCalled()
    expect(prismaMock.order.update).not.toHaveBeenCalled()
  })

  it('un BLOQUEADO sí recibe su saldo de vuelta (se queda en la tarjeta mientras el gerente la revisa)', async () => {
    lockMock.mockResolvedValue([sobre('gc-1', { status: 'BLOCKED' }), sobre('gc-2')])
    await expect(returnGiftBalanceAndCancelOrder('venue-1', 'order-1', { staffId: 'staff-1', operationKey: LLAVE })).resolves.toEqual({
      replay: false,
    })
    expect(revertirMock).toHaveBeenCalledTimes(2)
  })

  it('un cobro ya devuelto completo no se reembolsa ni bloquea sus sobres, y la primera devolución escrita lleva la llave :0', async () => {
    bloquearMock.mockImplementation(async (_tx: unknown, p: { paymentId: string }) => ({
      original: { id: p.paymentId, amount: D(200), tipAmount: D(0) },
      refundedSalesCents: p.paymentId === 'pay-1' ? 20000 : 0,
      refundedTipsCents: 0,
    }))

    await expect(returnGiftBalanceAndCancelOrder('venue-1', 'order-1', { staffId: 'staff-1', operationKey: LLAVE })).resolves.toEqual({
      replay: false,
    })
    expect(lockMock).toHaveBeenCalledWith(prismaMock, ['gc-2'])
    expect(reembolsoMock.mock.calls.map(c => [c[1].originalPaymentId, c[1].idempotencyKey])).toEqual([['pay-2', `${RAIZ}:0`]])
    // Y la cuenta se cancela igual. Como la primera devolución ESCRITA es :0 (no la del primer cobro), un reintento de esta
    // operación la encuentra y responde `replay: true`.
    expect(prismaMock.order.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'order-1', venueId: 'venue-1' }, data: { status: 'CANCELLED', version: { increment: 1 } } }),
    )
  })

  it('una cuenta PAGADA no se cancela por aquí (para devolver dinero de una cuenta pagada está el reembolso)', async () => {
    prismaMock.order.findUnique.mockResolvedValue({ id: 'order-1', status: 'COMPLETED', paymentStatus: 'PAID' })
    await expect(returnGiftBalanceAndCancelOrder('venue-1', 'order-1', { staffId: 'staff-1', operationKey: LLAVE })).rejects.toMatchObject({
      code: 'GIFT_CARD_TENDER_NOT_ALLOWED',
    })
    expect(bloquearMock).not.toHaveBeenCalled()
  })

  it('un pago que no es de saldo en la cuenta: no aplica (el guardia general de cancelación no se relaja)', async () => {
    prismaMock.payment.findMany.mockResolvedValue([
      { id: 'pay-1', tenderTypeId: 'tt-gift' },
      { id: 'pay-cash', tenderTypeId: null },
    ])
    await expect(returnGiftBalanceAndCancelOrder('venue-1', 'order-1', { staffId: 'staff-1', operationKey: LLAVE })).rejects.toMatchObject({
      code: 'GIFT_CARD_TENDER_NOT_ALLOWED',
    })
    expect(bloquearMock).not.toHaveBeenCalled()
    expect(reembolsoMock).not.toHaveBeenCalled()
  })

  it('la misma llave sobre OTRA cuenta: IDEMPOTENCY_KEY_REUSED sin tocar nada', async () => {
    prismaMock.payment.findUnique.mockResolvedValue({ orderId: 'order-otra' })
    await expect(returnGiftBalanceAndCancelOrder('venue-1', 'order-1', { staffId: 'staff-1', operationKey: LLAVE })).rejects.toMatchObject({
      code: 'IDEMPOTENCY_KEY_REUSED',
      statusCode: 409,
    })
    expect(bloquearMock).not.toHaveBeenCalled()
  })
})

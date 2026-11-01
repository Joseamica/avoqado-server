/**
 * Cierre B (al traer `develop`): pedidos en línea 1c, S1 (`5572bcc67`) hizo que una cuenta CANCELADA que se reabre por dinero ya
 * capturado no vuelva a la cocina: `registrarAbonoEnTx` devuelve `reabiertaDeCancelada` y quien llama no arma la comanda. En
 * `develop` eso vivía en `payGiftCardBalanceOnOrder`; la 1b movió ese paso a `terminarCobroConSaldo` (lo de después del commit del
 * cobro con saldo, común a `pay-gift-card` y `pay-new-order`). Hoy es inalcanzable por la ruta (`rechazarCobroNuevoSobreCancelada`
 * rechaza antes), pero el paso tiene que quedar igual que en `develop` y en `payCashOrder`: esta prueba lo amarra.
 */
jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: jest.fn(() => null) } }))
jest.mock('@/services/dashboard/receipt.dashboard.service', () => ({
  generateAndStoreReceipt: jest.fn().mockResolvedValue({ id: 'receipt-1' }),
}))
jest.mock('@/services/tpv/payment.tpv.service', () => ({
  mapDigitalReceiptResponse: jest.fn(() => null),
  resolveAutofacturaAvailable: jest.fn().mockResolvedValue(false),
}))
jest.mock('@/services/inventory/inventoryPosting.service', () => ({
  createSalePostingInTx: jest.fn().mockResolvedValue(null),
  applySalePosting: jest.fn().mockResolvedValue(null),
}))
jest.mock('@/services/dashboard/autoReorder.service', () => ({ runAutoReorderForVenue: jest.fn().mockResolvedValue(undefined) }))
jest.mock('@/services/referrals/referralQualification.service', () => ({ onOrderPaid: jest.fn().mockResolvedValue(undefined) }))
jest.mock('@/services/shared/loyaltyOnPaidOrder', () => ({ awardLoyaltyForPaidOrder: jest.fn().mockResolvedValue(undefined) }))
jest.mock('@/services/tpv/table.tpv.service', () => ({
  ...jest.requireActual('@/services/tpv/table.tpv.service'),
  releaseTableIfSettled: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('@/services/kds/kitchenTicketAuthoring.service', () => ({
  ...jest.requireActual('@/services/kds/kitchenTicketAuthoring.service'),
  armarComandasTrasCommit: jest.fn().mockResolvedValue(undefined),
}))

import { Prisma } from '@prisma/client'
import { armarComandasTrasCommit } from '@/services/kds/kitchenTicketAuthoring.service'
import { terminarCobroConSaldo } from '@/services/mobile/order.mobile.service'

const D = (v: number) => new Prisma.Decimal(v)
type Ctx = Parameters<typeof terminarCobroConSaldo>[0]
type Hecho = Parameters<typeof terminarCobroConSaldo>[1]

const ctx = (marcarCocina: boolean): Ctx =>
  ({
    venueId: 'venue-1',
    orderId: 'order-1',
    orderNumber: 'ORD-1',
    tableId: null,
    prueba: { last4: '1234' },
    monto: D(400),
    propina: D(0),
    idempotencyKey: 'saldo-0001',
    effectiveStaffId: 'staff-1',
    deviceId: null,
    marcarCocina,
    cliente: null,
  }) as unknown as Ctx

/** Un cobro con saldo que SALDÓ la cuenta; `reabiertaDeCancelada` es lo único que cambia entre los casos. */
const hecho = (reabiertaDeCancelada: boolean): Hecho =>
  ({
    abono: {
      newPayment: { id: 'pay-1' },
      isFullyPaid: true,
      postingId: null,
      areaTicketOrder: false,
      tableId: null,
      reabiertaDeCancelada,
      loyaltyBase: 400,
      balance: { remainingBalanceCents: 0, orderPaymentStatus: 'PAID', orderTotalCents: 40000, totalPaidCents: 40000 },
    },
    canje: [{ giftCardId: 'gc-1', amount: D(400), balanceAfter: D(600) }],
  }) as unknown as Hecho

beforeEach(() => jest.clearAllMocks())

describe('terminarCobroConSaldo · la cuenta cancelada reabierta por dinero capturado no vuelve a la cocina', () => {
  it('saldada y con cocina, sin reabrir ⇒ arma la comanda (como siempre)', async () => {
    await terminarCobroConSaldo(ctx(true), hecho(false))
    expect(armarComandasTrasCommit).toHaveBeenCalledWith('venue-1', 'order-1', 'PAID')
  })

  it('🔴 saldada y con cocina, pero reabierta de CANCELADA ⇒ NO arma la comanda (develop 5572bcc67)', async () => {
    const r = await terminarCobroConSaldo(ctx(true), hecho(true))
    expect(armarComandasTrasCommit).not.toHaveBeenCalled()
    // El cobro sigue respondiendo igual: sólo la cocina cambia.
    expect(r).toMatchObject({ paymentId: 'pay-1', orderPaymentStatus: 'PAID', orderRemaining: 0, replay: false })
  })

  it('sin cocina ⇒ nunca arma la comanda', async () => {
    await terminarCobroConSaldo(ctx(false), hecho(false))
    expect(armarComandasTrasCommit).not.toHaveBeenCalled()
  })
})

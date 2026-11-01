/**
 * Cobrar con saldo de tarjeta de regalo (Tarea A8, R5): validaciones, idempotencia y el Payment del tender de sistema.
 * La concurrencia y el dinero de punta a punta los prueba la integración (`cobroConSaldo.integration.test.ts`).
 */
jest.mock('@/services/tpv/paymentEffects.service', () => ({
  ...jest.requireActual('@/services/tpv/paymentEffects.service'),
  enqueuePaymentCommissionInTx: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('@/services/venueSalesGuard', () => ({ __esModule: true, assertVenueSalesEnabled: jest.fn() }))
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
jest.mock('@/services/mobile/areaTicketV7.mobile.service', () => ({
  lockAreaTicketCheckoutForPayment: jest.fn().mockResolvedValue(null),
  finalizeAreaTicketPaymentInTransaction: jest.fn().mockResolvedValue({ areaTicketOrder: false }),
}))
jest.mock('@/services/giftCards/giftCardTender', () => ({
  ...jest.requireActual('@/services/giftCards/giftCardTender'),
  ensureGiftCardTender: jest.fn().mockResolvedValue({ id: 'tt-gift', revision: 1 }),
  resolveGiftCardTenderForChargeInTx: jest.fn().mockResolvedValue({
    tenderTypeId: 'tt-gift',
    tenderRevision: 1,
    method: 'OTHER',
    tenderLabel: 'Tarjeta de regalo',
    tenderCountsAsCash: false,
    tenderCaptureTip: true,
    tenderSatFormaPago: '01',
    tenderCommissionPercent: null,
    fundsFlow: 'EXTERNAL_RECORDED',
  }),
}))
// Ronda 1 (fix 2): el reintento completa la liberación de la mesa que una caída se llevó, como `payCashOrder`.
jest.mock('@/services/tpv/table.tpv.service', () => ({
  ...jest.requireActual('@/services/tpv/table.tpv.service'),
  releaseTableIfSettled: jest.fn().mockResolvedValue(undefined),
}))
const lockGiftCardsMock = jest.fn()
const canjearMock = jest.fn()
jest.mock('@/services/giftCards/giftCardLedger', () => ({
  ...jest.requireActual('@/services/giftCards/giftCardLedger'),
  lockGiftCardsForUpdate: (...a: unknown[]) => lockGiftCardsMock(...a),
  canjearSobresEnTx: (...a: unknown[]) => canjearMock(...a),
}))
// 1b S2: la prueba resuelta, espiada (por default la real) para ver con qué hora se juzga bajo el candado (Q91).
const resolverPruebaMock = jest.fn()
jest.mock('@/services/giftCards/giftCardProof', () => ({
  ...jest.requireActual('@/services/giftCards/giftCardProof'),
  resolverPrueba: (...a: unknown[]) => resolverPruebaMock(...a),
}))

import { Prisma } from '@prisma/client'
import { ConflictError } from '@/errors/AppError'
import { generateAndStoreReceipt } from '@/services/dashboard/receipt.dashboard.service'
import { generateGiftCardCode, generateOpaqueToken, hashGiftCardCode } from '@/services/giftCards/giftCardCode'
import { GiftCardError } from '@/services/giftCards/giftCardErrors'
import { reiniciarSellosParaPruebas, rechazoSellado, sellarSiEsDefinitivo } from '@/services/giftCards/giftCardPayKey'
import { resolveGiftCardTenderForChargeInTx } from '@/services/giftCards/giftCardTender'
import { payGiftCardBalanceOnOrder } from '@/services/mobile/order.mobile.service'
import { mapDigitalReceiptResponse } from '@/services/tpv/payment.tpv.service'
import { releaseTableIfSettled } from '@/services/tpv/table.tpv.service'
import { prismaMock } from '../../../__helpers__/setup'

const D = (v: number) => new Prisma.Decimal(v)
const codigo = generateGiftCardCode()
const LIGA = generateOpaqueToken()
/** La hora de la base leída con el candado de la llave puesto (`clock_timestamp()`, Q91). */
const RELOJ_DE_LA_BASE = Date.parse('2026-10-20T18:00:00.000Z')
const sqlDe = (a: any): string => (Array.isArray(a) ? a.join('?') : String(a?.sql ?? ''))
const sobreBloqueado = (over: Record<string, unknown> = {}) => ({
  id: 'gc-1',
  venueId: 'venue-1',
  codeHash: hashGiftCardCode(codigo.normalized), // r1 (A-1): la huella vigente, la misma del código presentado
  pageToken: LIGA, // 1b S2: la liga vigente, leída bajo el candado
  recipientPhone: null,
  deliveryChannel: 'PRINTED',
  status: 'ACTIVE',
  balance: D(1000),
  initialAmount: D(1000),
  expiresAt: null,
  activatedAt: new Date('2026-09-01T18:00:00Z'),
  validityMonths: null,
  customerId: null,
  ...over,
})
const cobro = (over: Record<string, unknown> = {}) =>
  ({
    idempotencyKey: 'saldo-0001',
    proof: { kind: 'CODE', code: codigo.display },
    amount: D(400),
    tip: D(50),
    staffId: 'staff-1',
    deviceId: 'dev-1',
    ...over,
  }) as unknown as Parameters<typeof payGiftCardBalanceOnOrder>[2]

function cuenta(over: Record<string, unknown> = {}) {
  prismaMock.order.findUnique.mockResolvedValue({
    id: 'order-1',
    orderNumber: 'ORD-1',
    areaTicketCheckoutSession: null,
    customer: null,
    paymentStatus: 'PENDING',
    subtotal: D(1000),
    discountAmount: D(0),
    serviceChargeAmount: D(0),
    status: 'CONFIRMED',
    contratoDePrecio: 'IVA_INCLUIDO',
    taxAmount: D(0),
    originSystem: 'AVOQADO',
    version: 1,
    areaTicketCode: null,
    tableId: null,
    total: D(1000),
    paidAmount: D(0),
    remainingBalance: D(1000),
    ...over,
  })
}

beforeEach(() => {
  jest.clearAllMocks()
  prismaMock.$transaction.mockImplementation(async (cb: any) => cb(prismaMock))
  reiniciarSellosParaPruebas()
  resolverPruebaMock.mockImplementation(jest.requireActual('@/services/giftCards/giftCardProof').resolverPrueba)
  prismaMock.$queryRaw.mockImplementation(async (plantilla: any) =>
    sqlDe(plantilla).includes('clock_timestamp') ? [{ ms: BigInt(RELOJ_DE_LA_BASE) }] : [{ id: 'order-1' }],
  )
  cuenta()
  prismaMock.payment.findUnique.mockReset().mockResolvedValue(null)
  prismaMock.payment.findMany.mockResolvedValue([])
  prismaMock.orderItem.findFirst.mockReset().mockResolvedValue(null)
  prismaMock.orderItem.findMany.mockResolvedValue([])
  prismaMock.giftCard.findFirst.mockReset().mockResolvedValue({ id: 'gc-1', codeLast4: codigo.last4 })
  prismaMock.staff.findUnique.mockResolvedValue({ id: 'staff-1' })
  prismaMock.staffVenue.findFirst.mockResolvedValue({ id: 'sv-1', staffId: 'staff-1', venueId: 'venue-1', active: true })
  prismaMock.shift.findFirst.mockResolvedValue(null)
  prismaMock.payment.create.mockImplementation(async ({ data }: any) => ({ id: 'payment-1', createdAt: new Date(), receipts: [], ...data }))
  prismaMock.venueTransaction.create.mockResolvedValue({ id: 'vtx-1' })
  prismaMock.paymentAllocation.create.mockResolvedValue({ id: 'alloc-1' })
  prismaMock.order.updateMany.mockResolvedValue({ count: 1 })
  prismaMock.cashDrawerSession.findFirst.mockResolvedValue(null)
  lockGiftCardsMock.mockResolvedValue([sobreBloqueado()])
  canjearMock.mockResolvedValue([{ giftCardId: 'gc-1', amount: D(450), balanceAfter: D(550) }])
})

describe('payGiftCardBalanceOnOrder', () => {
  it('cobra $400 + $50 de propina: UN Payment del tender de sistema (OTHER, fuera del cajón, forma 01) y el canje con su id', async () => {
    const r = await payGiftCardBalanceOnOrder('venue-1', 'order-1', cobro())

    expect(prismaMock.payment.create.mock.calls[0][0].data).toMatchObject({
      amount: 400,
      tipAmount: 50,
      method: 'OTHER',
      source: 'OTHER',
      fundsFlow: 'EXTERNAL_RECORDED',
      tenderTypeId: 'tt-gift',
      tenderSatFormaPago: '01',
      idempotencyKey: 'saldo-0001',
    })
    expect(lockGiftCardsMock).toHaveBeenCalledWith(prismaMock, ['gc-1'])
    expect(canjearMock).toHaveBeenCalledWith(prismaMock, {
      venueId: 'venue-1',
      orderId: 'order-1',
      paymentId: 'payment-1',
      amount: D(450),
      cards: [sobreBloqueado()],
      staffId: 'staff-1',
      deviceId: 'dev-1',
    })
    expect(r).toEqual({
      paymentId: 'payment-1',
      orderId: 'order-1',
      orderNumber: 'ORD-1',
      amount: 400,
      tipAmount: 50,
      redeemed: [{ giftCardId: 'gc-1', last4: codigo.last4, amount: 450, balanceAfter: 550 }],
      orderRemaining: 600,
      orderPaymentStatus: 'PARTIAL',
      digitalReceipt: null,
      replay: false, // r1 (F9): ESTA llamada creó el Payment
    })
  })

  it('🔴 r1 (A-1): el gerente reemplazó el código mientras el cobro esperaba el candado: la huella vigente ya no es la presentada → 404 y nada se cobra', async () => {
    lockGiftCardsMock.mockResolvedValue([sobreBloqueado({ codeHash: 'huella-del-codigo-nuevo' })])
    await expect(payGiftCardBalanceOnOrder('venue-1', 'order-1', cobro())).rejects.toMatchObject({
      code: 'GIFT_CARD_NOT_FOUND',
      statusCode: 404,
    })
    expect(canjearMock).not.toHaveBeenCalled()
    expect(prismaMock.payment.create).not.toHaveBeenCalled()
  })

  it('el recibo digital se arma como en payCashOrder: se guarda tras el commit y viaja en la respuesta', async () => {
    const recibo = { accessKey: 'rk-1', receiptUrl: 'https://recibos.avoqado.io/rk-1', autofacturaAvailable: false }
    ;(mapDigitalReceiptResponse as jest.Mock).mockReturnValueOnce(recibo)
    const r = await payGiftCardBalanceOnOrder('venue-1', 'order-1', cobro())
    expect(generateAndStoreReceipt).toHaveBeenCalledWith('venue-1', 'payment-1')
    expect(r.digitalReceipt).toEqual(recibo)
  })

  it('si el recibo falla, el cobro NO se cae: digitalReceipt llega null', async () => {
    ;(generateAndStoreReceipt as jest.Mock).mockRejectedValueOnce(new Error('S3 caído'))
    const r = await payGiftCardBalanceOnOrder('venue-1', 'order-1', cobro())
    expect(r).toMatchObject({ paymentId: 'payment-1', digitalReceipt: null })
  })

  it('🔴 el saldo no paga de más: un monto mayor a lo que debe la cuenta se rechaza (422) sin tocar nada', async () => {
    await expect(payGiftCardBalanceOnOrder('venue-1', 'order-1', cobro({ amount: D(1000.01), tip: D(0) }))).rejects.toMatchObject({
      code: 'GIFT_CARD_AMOUNT_OUT_OF_RANGE',
      statusCode: 422,
    })
    expect(lockGiftCardsMock).not.toHaveBeenCalled()
    expect(prismaMock.payment.create).not.toHaveBeenCalled()
  })

  it('si no alcanza: «quedan $X» (409) y ningún Payment', async () => {
    lockGiftCardsMock.mockResolvedValue([sobreBloqueado({ balance: D(300) })])
    await expect(payGiftCardBalanceOnOrder('venue-1', 'order-1', cobro())).rejects.toMatchObject({
      code: 'GIFT_CARD_INSUFFICIENT_BALANCE',
      message: 'Quedan $300.00 en la tarjeta de regalo.',
    })
    expect(prismaMock.payment.create).not.toHaveBeenCalled()
  })

  it.each([
    ['bloqueada', { status: 'BLOCKED' }, 'GIFT_CARD_BLOCKED'],
    ['vencida', { expiresAt: new Date('2026-01-01T00:00:00Z') }, 'GIFT_CARD_EXPIRED'],
    ['vendida sin cobrar', { status: 'PENDING' }, 'GIFT_CARD_NOT_FOUND'],
    ['de otro negocio', { venueId: 'venue-2' }, 'GIFT_CARD_NOT_FOUND'],
  ])('una tarjeta %s no paga', async (_caso, over, code) => {
    lockGiftCardsMock.mockResolvedValue([sobreBloqueado(over)])
    await expect(payGiftCardBalanceOnOrder('venue-1', 'order-1', cobro())).rejects.toMatchObject({ code })
    expect(prismaMock.payment.create).not.toHaveBeenCalled()
  })

  it('una cuenta cancelada no recibe un cobro nuevo con saldo (no se reabre)', async () => {
    cuenta({ status: 'CANCELLED' })
    await expect(payGiftCardBalanceOnOrder('venue-1', 'order-1', cobro())).rejects.toMatchObject({ code: 'ORDER_CANCELLED_NO_NEW_CHARGE' })
    expect(prismaMock.payment.create).not.toHaveBeenCalled()
  })

  it('una cuenta de tarjetas no se paga con saldo de otra tarjeta', async () => {
    prismaMock.orderItem.findFirst.mockResolvedValue({ giftCardId: 'gc-otra' })
    await expect(payGiftCardBalanceOnOrder('venue-1', 'order-1', cobro())).rejects.toMatchObject({ code: 'GIFT_CARD_TENDER_NOT_ALLOWED' })
  })

  it('una cuenta de vales por área no se paga con saldo', async () => {
    cuenta({ areaTicketCheckoutSession: { id: 'sesion-1' } })
    await expect(payGiftCardBalanceOnOrder('venue-1', 'order-1', cobro())).rejects.toMatchObject({ code: 'GIFT_CARD_TENDER_NOT_ALLOWED' })
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
  })

  it('un código que no existe (o mal escrito) es 404, sin abrir transacción', async () => {
    prismaMock.giftCard.findFirst.mockResolvedValue(null)
    await expect(payGiftCardBalanceOnOrder('venue-1', 'order-1', cobro())).rejects.toMatchObject({
      code: 'GIFT_CARD_NOT_FOUND',
      statusCode: 404,
    })
    await expect(payGiftCardBalanceOnOrder('venue-1', 'order-1', cobro({ proof: { kind: 'CODE', code: 'XXXX' } }))).rejects.toMatchObject({
      code: 'GIFT_CARD_NOT_FOUND',
    })
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
  })

  it('llave, prueba, monto o propina mal formados: 400 antes de leer nada', async () => {
    await expect(payGiftCardBalanceOnOrder('venue-1', 'order-1', cobro({ idempotencyKey: 'corta' }))).rejects.toMatchObject({
      statusCode: 400,
    })
    await expect(payGiftCardBalanceOnOrder('venue-1', 'order-1', cobro({ amount: new Prisma.Decimal('10.001') }))).rejects.toMatchObject({
      statusCode: 400,
    })
    await expect(payGiftCardBalanceOnOrder('venue-1', 'order-1', cobro({ tip: D(-1) }))).rejects.toMatchObject({ statusCode: 400 })
    await expect(payGiftCardBalanceOnOrder('venue-1', 'order-1', cobro({ amount: 400 }))).rejects.toMatchObject({ statusCode: 400 })
    await expect(
      payGiftCardBalanceOnOrder('venue-1', 'order-1', cobro({ proof: { kind: 'WALLET_PASS', qrToken: 'qr-1' } })),
    ).rejects.toMatchObject({ statusCode: 400 })
    expect(prismaMock.order.findUnique).not.toHaveBeenCalled()
  })

  describe('idempotencia (R12)', () => {
    const pagoGuardado = (over: Record<string, unknown> = {}) => ({
      id: 'payment-1',
      orderId: 'order-1',
      amount: D(400),
      tipAmount: D(50),
      tenderType: { systemKind: 'GIFT_CARD' },
      order: { orderNumber: 'ORD-1' },
      receipts: [],
      ...over,
    })

    beforeEach(() => {
      prismaMock.giftCardActivity.findMany.mockResolvedValue([
        {
          giftCardId: 'gc-1',
          amount: D(450),
          balanceAfter: D(550),
          giftCard: { codeLast4: codigo.last4, status: 'ACTIVE', balance: D(550), expiresAt: null },
        },
      ])
      cuenta({ paymentStatus: 'PARTIAL', paidAmount: D(450), remainingBalance: D(600), total: D(1050) })
    })

    it('🔴 la MISMA llave con el MISMO cobro devuelve el original (replay) sin abrir transacción ni descontar', async () => {
      prismaMock.payment.findUnique.mockResolvedValueOnce({ id: 'payment-1' }).mockResolvedValueOnce(pagoGuardado())
      const r = await payGiftCardBalanceOnOrder('venue-1', 'order-1', cobro())
      expect(r).toMatchObject({
        paymentId: 'payment-1',
        amount: 400,
        tipAmount: 50,
        orderRemaining: 600,
        redeemed: [{ giftCardId: 'gc-1', last4: codigo.last4, amount: 450, balanceAfter: 550 }],
        digitalReceipt: null, // `pagoGuardado` no tiene recibo guardado
        replay: true, // r1 (F9): C3 no repite la bitácora
      })
      expect(prismaMock.$transaction).not.toHaveBeenCalled()
      expect(canjearMock).not.toHaveBeenCalled()
    })

    // r1 (A-2): las dos peticiones pasan la consulta rápida (1.ª llamada a `payment.findUnique`: null); la perdedora falla
    // bajo el candado y, ANTES de mostrar el error, encuentra a la ganadora por la llave (2.ª llamada).
    // 1b S2 (Q91): estas tres son la SEGUNDA red. La llave ya se lee bajo su candado (3.ª llamada: `null`); la ganadora por la
    // llave se busca igual en el catch ante CUALQUIER error.
    it('🔴 r1 (A-2): carrera con la MISMA llave, pago parcial — la perdedora ve «quedan $X» bajo el candado pero devuelve el cobro de la ganadora', async () => {
      prismaMock.payment.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValueOnce(pagoGuardado())
      lockGiftCardsMock.mockResolvedValue([sobreBloqueado({ balance: D(100) })]) // la ganadora ya descontó $450 de $550
      const r = await payGiftCardBalanceOnOrder('venue-1', 'order-1', cobro())
      expect(r).toMatchObject({ paymentId: 'payment-1', amount: 400, tipAmount: 50, replay: true })
      expect(canjearMock).not.toHaveBeenCalled()
      expect(prismaMock.payment.create).not.toHaveBeenCalled()
    })

    it('🔴 r1 (A-2): carrera con la MISMA llave, pago completo — la cuenta ya quedó PAGADA por la ganadora: su respuesta, no «ya está pagada»', async () => {
      prismaMock.payment.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValueOnce(pagoGuardado())
      cuenta({ paymentStatus: 'PAID', paidAmount: D(1050), remainingBalance: D(0), total: D(1050) })
      const r = await payGiftCardBalanceOnOrder('venue-1', 'order-1', cobro())
      expect(r).toMatchObject({ paymentId: 'payment-1', replay: true })
      expect(prismaMock.payment.create).not.toHaveBeenCalled()
    })

    it('r1 (A-2): la ganadora de la carrera registró OTRO cobro con esa llave: IDEMPOTENCY_KEY_REUSED, no el error de carrera', async () => {
      prismaMock.payment.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(pagoGuardado({ amount: D(300) }))
      lockGiftCardsMock.mockResolvedValue([sobreBloqueado({ balance: D(100) })])
      await expect(payGiftCardBalanceOnOrder('venue-1', 'order-1', cobro())).rejects.toMatchObject({
        code: 'IDEMPOTENCY_KEY_REUSED',
        statusCode: 409,
      })
    })

    it('r1 (A-2): sin ganadora por la llave, el error es real y sale tal cual («quedan $X»)', async () => {
      lockGiftCardsMock.mockResolvedValue([sobreBloqueado({ balance: D(100) })])
      await expect(payGiftCardBalanceOnOrder('venue-1', 'order-1', cobro())).rejects.toMatchObject({
        code: 'GIFT_CARD_INSUFFICIENT_BALANCE',
      })
      expect(prismaMock.payment.findUnique).toHaveBeenCalledTimes(3) // la consulta rápida, la llave bajo su candado y la ganadora
    })

    it('r1 (M3): sin ganadora, el CAS perdido del núcleo sale como 409 ORDER_PAYMENT_CONFLICT con un texto para la cajera (sin «llave»)', async () => {
      lockGiftCardsMock.mockResolvedValue([sobreBloqueado()])
      canjearMock.mockRejectedValueOnce(Object.assign(new Error('PAY_CASH_CAS_LOST'), { code: 'PAY_CASH_CAS_LOST' }))
      await expect(payGiftCardBalanceOnOrder('venue-1', 'order-1', cobro())).rejects.toMatchObject({
        code: 'ORDER_PAYMENT_CONFLICT',
        statusCode: 409,
        message: 'Otro cobro cambió esta cuenta al mismo tiempo. Intenta otra vez.',
      })
    })

    it('🔴 la MISMA llave con OTRO monto: IDEMPOTENCY_KEY_REUSED (409)', async () => {
      prismaMock.payment.findUnique.mockResolvedValueOnce({ id: 'payment-1' }).mockResolvedValueOnce(pagoGuardado())
      await expect(payGiftCardBalanceOnOrder('venue-1', 'order-1', cobro({ amount: D(300) }))).rejects.toMatchObject({
        code: 'IDEMPOTENCY_KEY_REUSED',
        statusCode: 409,
      })
    })

    it('una llave que ya usó un cobro que NO es de saldo (otro tender): IDEMPOTENCY_KEY_REUSED', async () => {
      prismaMock.payment.findUnique.mockResolvedValueOnce({ id: 'payment-9' }).mockResolvedValueOnce(pagoGuardado({ tenderType: null }))
      await expect(payGiftCardBalanceOnOrder('venue-1', 'order-1', cobro())).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' })
    })
  })
})

/**
 * Decisiones del coordinador para A8 (rulings 3, 5 y 8): orden de candados Order → sobre → turno con el rechazo de un sobre
 * inservible ANTES del turno, una cuenta de tarjetas rechazada antes de tocar sobres, y la auditoría atribuida al cobro con
 * saldo (no a `payCashOrder`).
 */
describe('payGiftCardBalanceOnOrder — rulings del coordinador', () => {
  it('🔴 ruling 5: el sobre se bloquea DESPUÉS del candado de la Order y ANTES de reclamar el turno', async () => {
    await payGiftCardBalanceOnOrder('venue-1', 'order-1', cobro())

    const candadoDeLaOrden = prismaMock.$queryRaw.mock.invocationCallOrder[0]
    const candadoDelSobre = lockGiftCardsMock.mock.invocationCallOrder[0]
    const turno = prismaMock.shift.findFirst.mock.invocationCallOrder[0]
    expect([candadoDeLaOrden < candadoDelSobre, candadoDelSobre < turno]).toEqual([true, true])
    // El canje (que escribe en el sobre ya bloqueado) va después del turno y NO vuelve a pedir candado de sobres.
    expect(lockGiftCardsMock).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['cancelado (DEACTIVATED)', { status: 'DEACTIVATED', balance: D(0) }, 'GIFT_CARD_NOT_FOUND'],
    ['vendido sin cobrar (PENDING)', { status: 'PENDING', balance: D(0) }, 'GIFT_CARD_NOT_FOUND'],
    ['bloqueado', { status: 'BLOCKED' }, 'GIFT_CARD_BLOCKED'],
    ['vencido', { expiresAt: new Date('2026-01-01T00:00:00Z') }, 'GIFT_CARD_EXPIRED'],
    ['sin saldo', { balance: D(0) }, 'GIFT_CARD_INSUFFICIENT_BALANCE'],
  ])('🔴 ruling 5: un sobre %s se rechaza bajo su candado y ANTES del turno: ni turno, ni Order, ni Payment', async (_caso, over, code) => {
    lockGiftCardsMock.mockResolvedValue([sobreBloqueado(over)])
    await expect(payGiftCardBalanceOnOrder('venue-1', 'order-1', cobro())).rejects.toMatchObject({ code })
    expect(lockGiftCardsMock).toHaveBeenCalledTimes(1)
    expect(prismaMock.shift.findFirst).not.toHaveBeenCalled()
    expect(prismaMock.shift.updateMany).not.toHaveBeenCalled()
    expect(prismaMock.order.updateMany).not.toHaveBeenCalled()
    expect(prismaMock.payment.create).not.toHaveBeenCalled()
    expect(canjearMock).not.toHaveBeenCalled()
  })

  it('un sobre sin saldo dice «quedan $0.00»', async () => {
    lockGiftCardsMock.mockResolvedValue([sobreBloqueado({ balance: D(0) })])
    await expect(payGiftCardBalanceOnOrder('venue-1', 'order-1', cobro())).rejects.toMatchObject({
      code: 'GIFT_CARD_INSUFFICIENT_BALANCE',
      message: 'Quedan $0.00 en la tarjeta de regalo.',
      details: { saldoDisponible: 0 },
    })
  })

  it('🔴 ruling 8: una cuenta de tarjetas se rechaza bajo el candado de la Order, antes de bloquear ningún sobre ni el turno', async () => {
    prismaMock.orderItem.findFirst.mockResolvedValue({ giftCardId: 'gc-otra' })
    await expect(payGiftCardBalanceOnOrder('venue-1', 'order-1', cobro())).rejects.toMatchObject({
      code: 'GIFT_CARD_TENDER_NOT_ALLOWED',
      statusCode: 409,
    })
    expect(prismaMock.orderItem.findFirst).toHaveBeenCalledWith({
      where: { orderId: 'order-1', giftCardId: { not: null } },
      select: { giftCardId: true },
    })
    expect(lockGiftCardsMock).not.toHaveBeenCalled()
    expect(prismaMock.shift.findFirst).not.toHaveBeenCalled()
    expect(prismaMock.payment.create).not.toHaveBeenCalled()
  })

  it('🔴 ruling 3: la auditoría del turno atribuye el cobro a payGiftCardBalanceOnOrder, nunca a payCashOrder', async () => {
    prismaMock.venueSettings.findUnique.mockResolvedValue({ enableShifts: true }) // gate encendido; sin turno abierto (NO_SHIFT)
    await payGiftCardBalanceOnOrder('venue-1', 'order-1', cobro())

    expect(prismaMock.activityLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'PAYMENT_WITHOUT_SHIFT',
        entityId: 'payment-1',
        data: expect.objectContaining({ channel: 'payGiftCardBalanceOnOrder', reason: 'NO_SHIFT', totalPesos: '450.00' }),
      }),
    })
    expect(JSON.stringify(prismaMock.activityLog.create.mock.calls)).not.toContain('payCashOrder')
  })
})

/** Ronda 1 de A8: los reintentos liberan la mesa (fix 2) y un fallo al buscar a la ganadora no tapa el error real (fix 3). */
describe('payGiftCardBalanceOnOrder — ronda 1', () => {
  const pagoGuardado = () => ({
    id: 'payment-1',
    orderId: 'order-1',
    amount: D(400),
    tipAmount: D(50),
    tenderType: { systemKind: 'GIFT_CARD' },
    order: { orderNumber: 'ORD-1' },
    receipts: [],
  })
  beforeEach(() => {
    prismaMock.giftCardActivity.findMany.mockResolvedValue([
      { giftCardId: 'gc-1', amount: D(450), balanceAfter: D(550), giftCard: { codeLast4: codigo.last4 } },
    ])
    // La cuenta con mesa que el primer cobro dejó SALDADA (la caída se llevó la liberación de la mesa).
    cuenta({ tableId: 'mesa-1', paymentStatus: 'PAID', status: 'COMPLETED', paidAmount: D(1050), remainingBalance: D(0), total: D(1050) })
  })

  it('🔴 fix 2: el reintento por llave (repetición) libera la mesa de la cuenta saldada', async () => {
    prismaMock.payment.findUnique.mockResolvedValueOnce({ id: 'payment-1' }).mockResolvedValueOnce(pagoGuardado())
    await expect(payGiftCardBalanceOnOrder('venue-1', 'order-1', cobro())).resolves.toMatchObject({ paymentId: 'payment-1', replay: true })
    expect(releaseTableIfSettled).toHaveBeenCalledWith('venue-1', 'mesa-1')
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
  })

  it('🔴 fix 2: la carrera perdida (la ganadora ya saldó la cuenta) también libera la mesa', async () => {
    // 1b S2 (Q91): la perdedora ve el cobro de la ganadora bajo el candado de la llave (2.ª llamada) y sale por su respuesta.
    prismaMock.payment.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'payment-1' })
      .mockResolvedValueOnce(pagoGuardado())
    await expect(payGiftCardBalanceOnOrder('venue-1', 'order-1', cobro())).resolves.toMatchObject({ paymentId: 'payment-1', replay: true })
    expect(releaseTableIfSettled).toHaveBeenCalledWith('venue-1', 'mesa-1')
    expect(prismaMock.payment.create).not.toHaveBeenCalled()
  })

  it('fix 2: una cuenta sin mesa no intenta liberar nada', async () => {
    cuenta({ tableId: null, paymentStatus: 'PAID', paidAmount: D(1050), remainingBalance: D(0), total: D(1050) })
    prismaMock.payment.findUnique.mockResolvedValueOnce({ id: 'payment-1' }).mockResolvedValueOnce(pagoGuardado())
    await payGiftCardBalanceOnOrder('venue-1', 'order-1', cobro())
    expect(releaseTableIfSettled).not.toHaveBeenCalled()
  })

  it('🔴 fix 3: si buscar a la ganadora por la llave falla, sale el error ORIGINAL del cobro (no el de la búsqueda)', async () => {
    cuenta()
    lockGiftCardsMock.mockResolvedValue([sobreBloqueado({ balance: D(100) })])
    prismaMock.payment.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null) // bajo el candado de la llave (Q91)
      .mockRejectedValueOnce(new Error('la base no contesta'))
    await expect(payGiftCardBalanceOnOrder('venue-1', 'order-1', cobro())).rejects.toMatchObject({
      code: 'GIFT_CARD_INSUFFICIENT_BALANCE',
      message: 'Quedan $100.00 en la tarjeta de regalo.',
    })
    expect(prismaMock.payment.create).not.toHaveBeenCalled()
  })
})

/** 1b S2 (Q7): la liga de la tarjeta (`PAGE_TOKEN`) también paga, con la misma prueba bajo el candado que el código. */
describe('payGiftCardBalanceOnOrder — PAGE_TOKEN', () => {
  const porLiga = (over: Record<string, unknown> = {}) => cobro({ proof: { kind: 'PAGE_TOKEN', pageToken: LIGA }, ...over })

  it('PAGE_TOKEN cobra el sobre de esa liga', async () => {
    const r = await payGiftCardBalanceOnOrder('venue-1', 'order-1', porLiga())
    expect(prismaMock.giftCard.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { venueId: 'venue-1', pageToken: LIGA } }))
    expect(lockGiftCardsMock).toHaveBeenCalledWith(prismaMock, ['gc-1'])
    expect(canjearMock).toHaveBeenCalledWith(prismaMock, expect.objectContaining({ amount: D(450), cards: [sobreBloqueado()] }))
    expect(r).toMatchObject({ paymentId: 'payment-1', replay: false })
  })

  it('🔴 la liga reemplazada mientras se esperaba el candado ⇒ 404 y sin payment.create', async () => {
    lockGiftCardsMock.mockResolvedValue([sobreBloqueado({ pageToken: generateOpaqueToken() })])
    await expect(payGiftCardBalanceOnOrder('venue-1', 'order-1', porLiga())).rejects.toMatchObject({
      code: 'GIFT_CARD_NOT_FOUND',
      statusCode: 404,
    })
    expect(canjearMock).not.toHaveBeenCalled()
    expect(prismaMock.payment.create).not.toHaveBeenCalled()
  })

  it('una liga que no existe en el negocio es el mismo 404, sin abrir transacción', async () => {
    prismaMock.giftCard.findFirst.mockResolvedValue(null)
    await expect(payGiftCardBalanceOnOrder('venue-1', 'order-1', porLiga())).rejects.toMatchObject({
      code: 'GIFT_CARD_NOT_FOUND',
      statusCode: 404,
    })
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
  })

  it('🔴 misma llave con PAGE_TOKEN ⇒ replay: true sin mover saldo', async () => {
    prismaMock.giftCardActivity.findMany.mockResolvedValue([
      { giftCardId: 'gc-1', amount: D(450), balanceAfter: D(550), giftCard: { codeLast4: codigo.last4 } },
    ])
    prismaMock.payment.findUnique.mockResolvedValueOnce({ id: 'payment-1' }).mockResolvedValueOnce({
      id: 'payment-1',
      orderId: 'order-1',
      amount: D(400),
      tipAmount: D(50),
      tenderType: { systemKind: 'GIFT_CARD' },
      order: { orderNumber: 'ORD-1' },
      receipts: [],
    })
    const r = await payGiftCardBalanceOnOrder('venue-1', 'order-1', porLiga())
    expect(r).toMatchObject({ paymentId: 'payment-1', replay: true })
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
    expect(canjearMock).not.toHaveBeenCalled()
  })

  it('un kind de prueba desconocido ⇒ 400 antes de leer nada (lo rechaza la prueba, no una lista en el cobro)', async () => {
    const err = await payGiftCardBalanceOnOrder('venue-1', 'order-1', cobro({ proof: { kind: 'WALLET_PASS', qrToken: 'qr-1' } })).catch(
      e => e,
    )
    expect(err).toMatchObject({ statusCode: 400, message: 'Falta cómo se identificó la tarjeta: código, liga o teléfono.' })
    expect(prismaMock.order.findUnique).not.toHaveBeenCalled()
  })
})

/** 1b S2 (Q91, Q94): la llave se ordena con su candado ANTES de decidir nada, y su rechazo definitivo queda sellado. */
describe('payGiftCardBalanceOnOrder — la llave (Q91)', () => {
  const pagoGuardado = (over: Record<string, unknown> = {}) => ({
    id: 'payment-1',
    orderId: 'order-1',
    amount: D(400),
    tipAmount: D(50),
    tenderType: { systemKind: 'GIFT_CARD' },
    order: { orderNumber: 'ORD-1' },
    receipts: [],
    ...over,
  })
  beforeEach(() => {
    prismaMock.giftCardActivity.findMany.mockResolvedValue([
      { giftCardId: 'gc-1', amount: D(450), balanceAfter: D(550), giftCard: { codeLast4: codigo.last4 } },
    ])
  })

  it('🔴 lo primero de la transacción es el candado de la llave (antes del candado de la Order y de cualquier lectura)', async () => {
    await payGiftCardBalanceOnOrder('venue-1', 'order-1', cobro())

    const inicioTx = prismaMock.$transaction.mock.invocationCallOrder[0]
    const candadoDeLaLlave = prismaMock.$executeRaw.mock.invocationCallOrder[0]
    expect(candadoDeLaLlave).toBe(inicioTx + 1)
    expect((prismaMock.$executeRaw.mock.calls[0] as unknown[]).slice(1)).toEqual(['giftpay:venue-1:saldo-0001'])
    const candadoDeLaOrden = prismaMock.$queryRaw.mock.calls.findIndex((c: unknown[]) => !sqlDe(c[0]).includes('clock_timestamp'))
    expect(candadoDeLaLlave).toBeLessThan(prismaMock.$queryRaw.mock.invocationCallOrder[candadoDeLaOrden])
    expect(candadoDeLaLlave).toBeLessThan((resolveGiftCardTenderForChargeInTx as jest.Mock).mock.invocationCallOrder[0])
  })

  it('🔴 bajo el candado la llave ya cobró ⇒ la salida de la ganadora (replay), sin tomar el sobre ni crear Payment', async () => {
    prismaMock.payment.findUnique
      .mockResolvedValueOnce(null) // la consulta rápida: todavía no
      .mockResolvedValueOnce({ id: 'payment-1' }) // bajo el candado de la llave: la ganadora ya confirmó
      .mockResolvedValueOnce(pagoGuardado())
    const r = await payGiftCardBalanceOnOrder('venue-1', 'order-1', cobro())
    expect(r).toMatchObject({ paymentId: 'payment-1', amount: 400, tipAmount: 50, replay: true })
    expect(lockGiftCardsMock).not.toHaveBeenCalled()
    expect(resolveGiftCardTenderForChargeInTx).not.toHaveBeenCalled()
    expect(prismaMock.payment.create).not.toHaveBeenCalled()
  })

  it('bajo el candado la llave ya cobró OTRA cosa ⇒ 409 IDEMPOTENCY_KEY_REUSED', async () => {
    prismaMock.payment.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'payment-1' })
      .mockResolvedValueOnce(pagoGuardado({ amount: D(300) }))
    await expect(payGiftCardBalanceOnOrder('venue-1', 'order-1', cobro())).rejects.toMatchObject({
      code: 'IDEMPOTENCY_KEY_REUSED',
      statusCode: 409,
    })
    expect(lockGiftCardsMock).not.toHaveBeenCalled()
    expect(prismaMock.payment.create).not.toHaveBeenCalled()
  })

  it('🔴 la prueba se juzga con la hora leída bajo el candado (`ahora` de tomarLlaveDeCobro)', async () => {
    const vigente = jest.fn(() => true)
    resolverPruebaMock.mockResolvedValueOnce({ giftCardId: 'gc-1', last4: codigo.last4, vigente, rechazo: jest.fn() })
    await payGiftCardBalanceOnOrder('venue-1', 'order-1', cobro())
    expect(vigente).toHaveBeenCalledWith(sobreBloqueado(), new Date(RELOJ_DE_LA_BASE))
  })

  it('una prueba que ya no vale bajo el candado lanza SU rechazo y nada se cobra', async () => {
    const rechazo = new GiftCardError('GIFT_CARD_PHONE_PROOF_INVALID' as any, 'La verificación por teléfono venció. Pide otro código.', 409)
    resolverPruebaMock.mockResolvedValueOnce({ giftCardId: 'gc-1', last4: codigo.last4, vigente: () => false, rechazo: () => rechazo })
    await expect(payGiftCardBalanceOnOrder('venue-1', 'order-1', cobro())).rejects.toBe(rechazo)
    expect(prismaMock.payment.create).not.toHaveBeenCalled()
  })

  it('🔴 un rechazo definitivo bajo el candado se sella; ORDER_PAYMENT_CONFLICT y ORDER_CANCEL_BLOCKED_BY_TERMINAL_CHARGE no', async () => {
    lockGiftCardsMock.mockResolvedValueOnce([sobreBloqueado({ balance: D(100) })])
    const definitivo = await payGiftCardBalanceOnOrder('venue-1', 'order-1', cobro({ idempotencyKey: 'saldo-sella-1' })).catch(e => e)
    expect(definitivo).toMatchObject({ code: 'GIFT_CARD_INSUFFICIENT_BALANCE' })
    expect(rechazoSellado('venue-1', 'saldo-sella-1')).toBe(definitivo)

    canjearMock.mockRejectedValueOnce(
      new ConflictError('Otro cobro cambió esta cuenta al mismo tiempo. Intenta otra vez.', 'ORDER_PAYMENT_CONFLICT'),
    )
    await expect(payGiftCardBalanceOnOrder('venue-1', 'order-1', cobro({ idempotencyKey: 'saldo-sella-2' }))).rejects.toMatchObject({
      code: 'ORDER_PAYMENT_CONFLICT',
    })
    expect(rechazoSellado('venue-1', 'saldo-sella-2')).toBeNull()

    lockGiftCardsMock.mockRejectedValueOnce(
      new ConflictError('Hay un cobro en curso en la terminal.', 'ORDER_CANCEL_BLOCKED_BY_TERMINAL_CHARGE'),
    )
    await expect(payGiftCardBalanceOnOrder('venue-1', 'order-1', cobro({ idempotencyKey: 'saldo-sella-3' }))).rejects.toMatchObject({
      code: 'ORDER_CANCEL_BLOCKED_BY_TERMINAL_CHARGE',
    })
    expect(rechazoSellado('venue-1', 'saldo-sella-3')).toBeNull()
  })

  it('🔴 una llave sellada responde su rechazo antes de leer nada (el atajo del principio)', async () => {
    const sellado = new GiftCardError('GIFT_CARD_INSUFFICIENT_BALANCE', 'Quedan $100.00 en la tarjeta de regalo.', 409, {
      saldoDisponible: 100,
    })
    sellarSiEsDefinitivo('venue-1', 'saldo-0001', sellado)
    await expect(payGiftCardBalanceOnOrder('venue-1', 'order-1', cobro())).rejects.toBe(sellado)
    expect(prismaMock.order.findUnique).not.toHaveBeenCalled()
    expect(prismaMock.giftCard.findFirst).not.toHaveBeenCalled()
    expect(prismaMock.payment.findUnique).not.toHaveBeenCalled()
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
  })
})

/**
 * El Cambio con saldo a favor (spec 2026-10-30-saldo-a-favor §5.4, tarea S5): la diferencia a favor de la clienta se abona a su sobre
 * (`settlement.method: 'STORE_CREDIT'`). Aquí, las reglas puras (de qué cobro sale y por qué medios), el cuerpo y las puertas del
 * servicio antes de abrir la transacción. Lo que sólo prueba Postgres (el abono en la MISMA transacción, el tope sin escribir el cambio,
 * la bitácora, la cadena real con raíz en tarjeta) está en `tests/integration/exchanges/exchangeStoreCredit.integration.test.ts`.
 */
const mockExecute = jest.fn()
const mockPreparar = jest.fn()
const mockDisponible = jest.fn(() => true)
jest.mock('@/services/mobile/order.mobile.service', () => ({
  executeExchangeInTransaction: (...a: unknown[]) => mockExecute(...a),
  cancelOrderInTransaction: jest.fn(),
  publishCancelledOrder: jest.fn(),
}))
jest.mock('@/services/venueSalesGuard', () => ({ assertVenueSalesEnabled: jest.fn(async () => undefined) }))
jest.mock('@/utils/staff-venue.util', () => ({ validateStaffVenue: jest.fn(async () => undefined) }))
jest.mock('@/services/storeCredit/storeCreditTender', () => ({
  ...jest.requireActual('@/services/storeCredit/storeCreditTender'),
  prepararMediosDeSaldoAFavor: (...a: unknown[]) => mockPreparar(...a),
  storeCreditAvailable: () => mockDisponible(),
}))

import { prismaMock } from '../../../__helpers__/setup'
import {
  allocateAcrossPayments,
  modesForExchangeCredit,
  payoutModesFor,
  payoutOptionsOf,
  rigeSoloSaldoAFavor,
  soloSaldoAFavor,
  type MoneyShape,
  type PaymentCapacity,
  type PayoutModes,
} from '@/services/exchanges/exchangeRules'
import { resolveChainRefund, type ChainRefundRoot } from '@/services/exchanges/exchangeChainRefund'
import { createExchangeSchema } from '@/schemas/mobile/exchange.mobile.schema'
import { createExchange, type CreateExchangeBody } from '@/services/exchanges/exchange.service'
import { hayDevolucionEnTerminal, marcarDevolucionEnTerminal } from '@/services/storeCredit/terminalRefundMarker'

const money = (over: Partial<MoneyShape> = {}): MoneyShape => ({
  method: 'CASH',
  source: 'POS',
  externalSource: null,
  fundsFlow: 'CASH_DRAWER',
  tenderTypeId: null,
  tenderCountsAsCash: null,
  tenderSatFormaPago: null,
  tenderSystemKind: null,
  ...over,
})
const tarjetaDeTerminal = money({ method: 'CREDIT_CARD', source: 'TPV', fundsFlow: 'AVOQADO_PROCESSED' })
const saldoDeRegalo = money({ method: 'OTHER', fundsFlow: 'EXTERNAL_RECORDED', tenderTypeId: 'tt-gc', tenderSystemKind: 'GIFT_CARD' })
const cap = (paymentId: string, saleRemainingCents: number, modes: PayoutModes): PaymentCapacity => ({
  paymentId,
  saleRemainingCents,
  modes,
})

describe('payoutModesFor con saldo a favor', () => {
  it('venta con tarjeta $500 → cambio por $300 → $200 a saldo (antes: 422 INSUFFICIENT_FOR_METHOD)', () => {
    const hoy = allocateAcrossPayments([cap('card', 50000, payoutModesFor(tarjetaDeTerminal))], 30000, { method: 'CASH', cents: 20000 })
    expect(hoy).toMatchObject({ ok: false, reason: 'INSUFFICIENT_FOR_METHOD' })

    const modes = payoutModesFor(tarjetaDeTerminal, true)
    expect(modes).toEqual({ STORE_CREDIT: 'CHOSEN' })
    expect(allocateAcrossPayments([cap('card', 50000, modes)], 30000, { method: 'STORE_CREDIT', cents: 20000 })).toEqual({
      ok: true,
      slices: [
        { paymentId: 'card', cents: 20000, role: 'PAYOUT', mode: 'CHOSEN' },
        { paymentId: 'card', cents: 30000, role: 'CREDIT', mode: null },
      ],
      needsRefundToCash: false,
    })
  })

  it('una app vieja que manda CASH en una venta con tarjeta sigue recibiendo el 422 de hoy (y STORE_CREDIT va en payoutOptions, que ella descarta)', () => {
    const r = allocateAcrossPayments([cap('card', 50000, payoutModesFor(tarjetaDeTerminal, true))], 30000, { method: 'CASH', cents: 20000 })
    expect(r).toEqual({
      ok: false,
      reason: 'INSUFFICIENT_FOR_METHOD',
      payoutOptions: [{ method: 'STORE_CREDIT', maxCents: 50000, maxSameCents: 0, needsRefundToCash: false }],
    })
  })

  it('efectivo y transferencia suman el saldo a favor como «Devolver con», sin quitar lo de hoy', () => {
    expect(payoutModesFor(money(), true)).toEqual({ CASH: 'SAME', BANK_TRANSFER: 'CHOSEN', STORE_CREDIT: 'CHOSEN' })
    expect(payoutModesFor(money({ method: 'BANK_TRANSFER', fundsFlow: 'EXTERNAL_RECORDED' }), true)).toEqual({
      BANK_TRANSFER: 'SAME',
      CASH: 'CHOSEN',
      STORE_CREDIT: 'CHOSEN',
    })
  })

  it('sin las llaves (o sin pedirlo) los modos son los de hoy', () => {
    expect(payoutModesFor(money())).toEqual({ CASH: 'SAME', BANK_TRANSFER: 'CHOSEN' })
    expect(payoutModesFor(tarjetaDeTerminal, false)).toEqual({})
  })

  it('lo pagado con saldo de regalo regresa a SU sobre, nunca a un saldo nuevo; lo de una app de reparto, tampoco', () => {
    expect(payoutModesFor(saldoDeRegalo, true)).toEqual({ GIFT_CARD_BALANCE: 'SAME' })
    expect(payoutModesFor(money({ method: 'OTHER', source: 'DELIVERY_PLATFORM', fundsFlow: 'EXTERNAL_RECORDED' }), true)).toEqual({})
  })

  it('un solo grupo de sobres: el saldo a favor nunca sale de un cobro con saldo de regalo (sólo de la tarjeta de la misma venta)', () => {
    const r = allocateAcrossPayments(
      [cap('gift', 20000, payoutModesFor(saldoDeRegalo, true)), cap('card', 30000, payoutModesFor(tarjetaDeTerminal, true))],
      30000,
      { method: 'STORE_CREDIT', cents: 20000 },
    )
    expect(r.ok && r.slices.filter(s => s.role === 'PAYOUT')).toEqual([{ paymentId: 'card', cents: 20000, role: 'PAYOUT', mode: 'CHOSEN' }])
    // Más de lo que la tarjeta respalda no cabe: el saldo de regalo no presta para el saldo a favor.
    expect(
      allocateAcrossPayments(
        [cap('gift', 20000, payoutModesFor(saldoDeRegalo, true)), cap('card', 30000, payoutModesFor(tarjetaDeTerminal, true))],
        0,
        { method: 'STORE_CREDIT', cents: 30001 },
      ),
    ).toMatchObject({ ok: false, reason: 'INSUFFICIENT_FOR_METHOD' })
  })
})

describe('«Sólo saldo a favor» en el Cambio', () => {
  const caps = (modes: PayoutModes) => [cap('cash', 50000, modes)]
  it('con sólo saldo y sin DEFECT, payoutOptions = [STORE_CREDIT]', () => {
    expect(rigeSoloSaldoAFavor(true, ['SIZE', 'TASTE'])).toBe(true)
    expect(payoutOptionsOf(caps(soloSaldoAFavor(payoutModesFor(money(), true)))).map(o => o.method)).toEqual(['STORE_CREDIT'])
  })
  it('con una línea DEFECT salen todas', () => {
    expect(rigeSoloSaldoAFavor(true, ['SIZE', 'DEFECT'])).toBe(false)
    expect(payoutOptionsOf(caps(payoutModesFor(money(), true))).map(o => o.method)).toEqual(['CASH', 'BANK_TRANSFER', 'STORE_CREDIT'])
  })
  it('con el interruptor apagado no rige', () => expect(rigeSoloSaldoAFavor(false, ['SIZE'])).toBe(false))
  it('pagado con saldo: GIFT_CARD_BALANCE sigue aunque haya sólo saldo', () => {
    expect(soloSaldoAFavor(payoutModesFor(saldoDeRegalo, true))).toEqual({ GIFT_CARD_BALANCE: 'SAME' })
    expect(payoutOptionsOf([cap('gift', 30000, soloSaldoAFavor(payoutModesFor(saldoDeRegalo, true)))]).map(o => o.method)).toEqual([
      'GIFT_CARD_BALANCE',
    ])
  })
})

describe('crédito de cambio (la cadena) con saldo a favor', () => {
  const link = { exchangeId: 'ex-1' }
  const raiz = (over: Partial<ChainRefundRoot> = {}): ChainRefundRoot =>
    ({
      id: 'root',
      method: 'CREDIT_CARD',
      source: 'TPV',
      fundsFlow: 'AVOQADO_PROCESSED',
      merchantAccountId: 'merchant',
      ecommerceMerchantId: null,
      tenderTypeId: null,
      tenderRevision: null,
      tenderLabel: null,
      tenderCountsAsCash: null,
      tenderCaptureTip: null,
      tenderSatFormaPago: null,
      tenderType: null,
      ...over,
    }) as ChainRefundRoot
  const modos = (root: ChainRefundRoot, rootMoney: MoneyShape, conSaldo: boolean) =>
    modesForExchangeCredit(rootMoney, resolveChainRefund(link, root), conSaldo ? resolveChainRefund(link, root, 'STORE_CREDIT') : null)

  it('crédito de cambio con raíz en tarjeta bancaria → STORE_CREDIT permitido (hoy: nada, va a la terminal)', () => {
    expect(modos(raiz(), tarjetaDeTerminal, false)).toEqual({})
    expect(modos(raiz(), tarjetaDeTerminal, true)).toEqual({ STORE_CREDIT: 'CHOSEN' })
  })
  it('raíz en efectivo: el mismo medio de hoy más el saldo a favor', () => {
    const efectivo = raiz({ method: 'CASH', source: 'POS', fundsFlow: 'CASH_DRAWER', merchantAccountId: null })
    expect(modos(efectivo, money(), true)).toEqual({ CASH: 'SAME', STORE_CREDIT: 'CHOSEN' })
  })
  it('raíz «en efectivo» con procesador: el saldo a favor sí, el efectivo sigue sin prestarse (como hoy)', () => {
    const conProcesador = raiz({ method: 'CASH', source: 'POS', fundsFlow: 'CASH_DRAWER', merchantAccountId: 'merchant' })
    expect(modos(conProcesador, money(), false)).toEqual({})
    expect(modos(conProcesador, money(), true)).toEqual({ STORE_CREDIT: 'CHOSEN' })
  })
  it('raíz en tarjeta de regalo: sigue bloqueada', () => {
    const regalo = raiz({
      method: 'OTHER',
      fundsFlow: 'EXTERNAL_RECORDED',
      merchantAccountId: null,
      tenderType: { systemKind: 'GIFT_CARD' },
    })
    expect(modos(regalo, saldoDeRegalo, true)).toEqual({})
  })
})

describe('el cuerpo del Cambio (createExchangeSchema)', () => {
  const cuerpo = (settlement: Record<string, unknown>) => ({
    params: { venueId: 'ckvenue000000000000000001' },
    query: {},
    body: {
      idempotencyKey: 'llave-del-cambio-1',
      originalPaymentId: 'ckpayment0000000000000001',
      returned: [{ orderItemId: 'ckitem000000000000000001', quantity: 1, restock: true, reason: 'SIZE' }],
      taken: [{ productId: 'ckproduct0000000000000001', quantity: 1 }],
      staffId: 'ckstaff000000000000000001',
      deviceId: 'caja-1',
      createdAtLocal: '2026-10-31T12:00:00-06:00',
      settlement,
    },
  })
  it('acepta STORE_CREDIT con la clienta', () => {
    const r = createExchangeSchema.safeParse(
      cuerpo({ kind: 'PAYOUT', method: 'STORE_CREDIT', expectedDifferenceCents: -20000, customerId: 'ckcustomer000000000000001' }),
    )
    expect(r.success).toBe(true)
  })
  it('sin la clienta el cuerpo pasa: el servicio responde STORE_CREDIT_CUSTOMER_REQUIRED', () => {
    expect(
      createExchangeSchema.safeParse(cuerpo({ kind: 'PAYOUT', method: 'STORE_CREDIT', expectedDifferenceCents: -20000 })).success,
    ).toBe(true)
  })
  it('no cobra la diferencia con saldo a favor', () => {
    expect(
      createExchangeSchema.safeParse(
        cuerpo({ kind: 'COLLECT', method: 'STORE_CREDIT', expectedDifferenceCents: 20000, customerId: 'ckcustomer000000000000001' }),
      ).success,
    ).toBe(false)
  })
  it('la clienta sólo va con STORE_CREDIT', () => {
    expect(
      createExchangeSchema.safeParse(
        cuerpo({ kind: 'PAYOUT', method: 'CASH', expectedDifferenceCents: -20000, customerId: 'ckcustomer000000000000001' }),
      ).success,
    ).toBe(false)
  })
})

describe('createExchange con STORE_CREDIT: las puertas antes de la transacción', () => {
  const mock = prismaMock as any
  const body = (settlement: Partial<CreateExchangeBody['settlement']> = {}): CreateExchangeBody => ({
    idempotencyKey: 'llave-del-cambio-1',
    originalPaymentId: 'pay-1',
    returned: [{ orderItemId: 'item-1', quantity: 1, restock: true, reason: 'SIZE' }],
    taken: [{ productId: 'prod-1', quantity: 1 }],
    settlement: { kind: 'PAYOUT', method: 'STORE_CREDIT', expectedDifferenceCents: -20000, customerId: 'cust-1', ...settlement },
    staffId: 'staff-1',
    deviceId: 'caja-1',
    createdAtLocal: '2026-10-31T12:00:00-06:00',
  })
  beforeEach(() => {
    mockExecute.mockReset()
    mockPreparar.mockReset()
    mockDisponible.mockReturnValue(true)
    mock.exchange.findUnique.mockResolvedValue(null)
    mock.venue.findUnique.mockResolvedValue({ type: 'CLOTHING', settings: { exchangesEnabled: true } })
    mock.payment.findFirst.mockResolvedValue({ orderId: 'order-1' })
  })

  it('sin customerId → STORE_CREDIT_CUSTOMER_REQUIRED (400), sin abrir la transacción', async () => {
    await expect(createExchange({ venueId: 'v1', actorStaffId: 'staff-1', body: body({ customerId: undefined }) })).rejects.toMatchObject({
      statusCode: 400,
      code: 'STORE_CREDIT_CUSTOMER_REQUIRED',
    })
    expect(mockExecute).not.toHaveBeenCalled()
  })

  it('sin las llaves → STORE_CREDIT_UNAVAILABLE (422), sin abrir la transacción', async () => {
    mockDisponible.mockReturnValue(false)
    await expect(createExchange({ venueId: 'v1', actorStaffId: 'staff-1', body: body() })).rejects.toMatchObject({
      statusCode: 422,
      code: 'STORE_CREDIT_UNAVAILABLE',
    })
    expect(mockExecute).not.toHaveBeenCalled()
  })

  it('prepara los medios con el cliente global ANTES de la transacción del Cambio', async () => {
    const orden: string[] = []
    mockPreparar.mockImplementation(async () => orden.push('medios'))
    mockExecute.mockImplementation(async () => {
      orden.push('tx')
      return { reserved: { id: 'ex-1' } }
    })
    await createExchange({ venueId: 'v1', actorStaffId: 'staff-1', body: body() })
    expect(mockPreparar).toHaveBeenCalledWith('v1')
    expect(orden).toEqual(['medios', 'tx'])
  })

  it('una repetición por llave responde lo escrito antes de las puertas (aunque hoy falten las llaves)', async () => {
    mockDisponible.mockReturnValue(false)
    const { operationHash } = jest.requireActual('@/utils/operationHash') as typeof import('@/utils/operationHash')
    const b = body()
    mock.exchange.findUnique.mockResolvedValue({
      requestHash: operationHash({ venueId: 'v1', ...b, idempotencyKey: undefined, isOfflineReplay: undefined }),
      result: { id: 'ex-1', status: 'COMPLETED', paymentIds: [], settlement: { storeCredit: { amountCents: 20000 } } },
      resultRevision: 1,
    })
    const r = await createExchange({ venueId: 'v1', actorStaffId: 'staff-1', body: b })
    expect(r).toMatchObject({ replay: true, exchange: { settlement: { storeCredit: { amountCents: 20000 } } } })
    expect(mockExecute).not.toHaveBeenCalled()
  })

  it('regresión: devolver en efectivo no pide clienta ni prepara medios', async () => {
    mockExecute.mockResolvedValue({ reserved: { id: 'ex-1' } })
    await createExchange({
      venueId: 'v1',
      actorStaffId: 'staff-1',
      body: body({ method: 'CASH', customerId: undefined }),
    })
    expect(mockPreparar).not.toHaveBeenCalled()
    expect(mockExecute).toHaveBeenCalled()
  })

  // S7 (spec §5.5, opción 1): la terminal devuelve al banco ANTES de avisar. Mientras vive la marca de un cobro de la venta (3 min), el
  // Cambio no da saldo a favor de ella.
  it('con la terminal devolviendo un cobro de la venta → 409 STORE_CREDIT_TERMINAL_REFUND_IN_PROGRESS, sin preparar medios ni abrir la transacción', async () => {
    const ahora = Date.now()
    marcarDevolucionEnTerminal('pay-2')
    mock.payment.count.mockResolvedValue(1)
    try {
      await expect(createExchange({ venueId: 'v1', actorStaffId: 'staff-1', body: body() })).rejects.toMatchObject({
        statusCode: 409,
        code: 'STORE_CREDIT_TERMINAL_REFUND_IN_PROGRESS',
      })
      // Los cobros de la venta original entre los marcados (pay-2 es el segundo cobro de esa venta).
      expect(mock.payment.count).toHaveBeenCalledWith({ where: { venueId: 'v1', orderId: 'order-1', id: { in: ['pay-2'] } } })
      expect(mockPreparar).not.toHaveBeenCalled()
      expect(mockExecute).not.toHaveBeenCalled()
    } finally {
      // La marca es memoria del módulo: se deja vencida para no tocar a las pruebas que siguen.
      const reloj = jest.spyOn(Date, 'now').mockReturnValue(ahora + 4 * 60_000)
      expect(hayDevolucionEnTerminal('pay-2')).toBe(false)
      reloj.mockRestore()
    }
  })
})

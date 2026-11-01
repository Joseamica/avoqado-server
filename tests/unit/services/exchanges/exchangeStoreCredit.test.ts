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
import { prepareExchangeInTx } from '@/services/exchanges/exchangeTx'
import { ExchangeError } from '@/services/exchanges/exchangeErrors'
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

describe('createExchange con STORE_CREDIT: afuera sólo lo que no cambia entre el envío y el reenvío', () => {
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
  const huella = (b: CreateExchangeBody) =>
    (jest.requireActual('@/utils/operationHash') as typeof import('@/utils/operationHash')).operationHash({
      venueId: 'v1',
      ...b,
      idempotencyKey: undefined,
      isOfflineReplay: undefined,
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

  it('S10 (I1): sin las llaves NO rechaza afuera ni prepara medios: la regla la corre la transacción, después de la llave', async () => {
    mockDisponible.mockReturnValue(false)
    mockExecute.mockResolvedValue({ reserved: { id: 'ex-1' } })
    await createExchange({ venueId: 'v1', actorStaffId: 'staff-1', body: body() })
    expect(mockPreparar).not.toHaveBeenCalled()
    expect(mockExecute).toHaveBeenCalledTimes(1)
  })

  it('S10 (I1): con la terminal devolviendo un cobro de la venta, ni los cambios apagados, rechaza afuera: va a la transacción', async () => {
    const ahora = Date.now()
    marcarDevolucionEnTerminal('pay-2')
    mock.payment.count.mockResolvedValue(1)
    mock.venue.findUnique.mockResolvedValue({ type: 'CLOTHING', settings: { exchangesEnabled: false } })
    mockExecute.mockResolvedValue({ reserved: { id: 'ex-1' } })
    try {
      await createExchange({ venueId: 'v1', actorStaffId: 'staff-1', body: body() })
      expect(mockExecute).toHaveBeenCalledTimes(1)
      expect(mock.payment.count).not.toHaveBeenCalled()
    } finally {
      const reloj = jest.spyOn(Date, 'now').mockReturnValue(ahora + 4 * 60_000)
      expect(hayDevolucionEnTerminal('pay-2')).toBe(false)
      reloj.mockRestore()
    }
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
    const b = body()
    mock.exchange.findUnique.mockResolvedValue({
      requestHash: huella(b),
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

  describe('I2 (S10): con saldo a favor, todo 4xx sin prefijo sale como STORE_CREDIT_REJECTED', () => {
    it('un rechazo de la transacción (la diferencia cambió) conserva status, mensaje y datos, con su código en details', async () => {
      mockExecute.mockRejectedValue(
        new ExchangeError('EXCHANGE_DIFFERENCE_CHANGED', 'La diferencia cambió.', 409, { differenceCents: -10000 }),
      )
      await expect(createExchange({ venueId: 'v1', actorStaffId: 'staff-1', body: body() })).rejects.toMatchObject({
        statusCode: 409,
        code: 'STORE_CREDIT_REJECTED',
        message: 'La diferencia cambió.',
        details: { originalCode: 'EXCHANGE_DIFFERENCE_CHANGED', differenceCents: -10000 },
      })
    })

    it('EXCHANGE_CHAIN_GIFT_CARD_PENDING también', async () => {
      mockExecute.mockRejectedValue(new ExchangeError('EXCHANGE_CHAIN_GIFT_CARD_PENDING', 'Viene de una tarjeta de regalo.', 422))
      await expect(createExchange({ venueId: 'v1', actorStaffId: 'staff-1', body: body() })).rejects.toMatchObject({
        statusCode: 422,
        code: 'STORE_CREDIT_REJECTED',
        details: { originalCode: 'EXCHANGE_CHAIN_GIFT_CARD_PENDING' },
      })
    })

    it('🔴 ACTOR_MISMATCH NO se envuelve: se revisa ANTES de reconocer la llave, así que puede salir aunque un envío anterior con esa llave sí haya escrito (lo pendiente no se borra)', async () => {
      const error = await createExchange({ venueId: 'v1', actorStaffId: 'otra-persona', body: body() }).catch(e => e)
      expect(error).toMatchObject({ statusCode: 400, code: 'ACTOR_MISMATCH' })
      expect(error.details?.originalCode).toBeUndefined()
      expect(mock.exchange.findUnique).not.toHaveBeenCalled() // ni siquiera llegó a mirar la llave
    })

    it('IDEMPOTENCY_KEY_REUSED no se envuelve: la llave es de otra operación y lo pendiente no se borra', async () => {
      mock.exchange.findUnique.mockResolvedValue({ requestHash: 'otra', result: {}, resultRevision: 1 })
      await expect(createExchange({ venueId: 'v1', actorStaffId: 'staff-1', body: body() })).rejects.toMatchObject({
        statusCode: 409,
        code: 'IDEMPOTENCY_KEY_REUSED',
      })
    })

    it('regresión: sin saldo a favor, el mismo rechazo sale exactamente como hoy', async () => {
      const error = new ExchangeError('EXCHANGE_DIFFERENCE_CHANGED', 'La diferencia cambió.', 409)
      mockExecute.mockRejectedValue(error)
      await expect(
        createExchange({ venueId: 'v1', actorStaffId: 'staff-1', body: body({ method: 'CASH', customerId: undefined }) }),
      ).rejects.toBe(error)
    })
  })
})

describe('prepareExchangeInTx (S10, I1): lo que cambia entre el envío y el reenvío se mira DESPUÉS de la llave, bajo su candado', () => {
  const global = prismaMock as any
  const cuerpo = (settlement: Partial<CreateExchangeBody['settlement']> = {}): CreateExchangeBody => ({
    idempotencyKey: 'llave-del-cambio-2',
    originalPaymentId: 'pay-1',
    returned: [{ orderItemId: 'item-1', quantity: 1, restock: true, reason: 'SIZE' }],
    taken: [{ productId: 'prod-1', quantity: 1 }],
    settlement: { kind: 'PAYOUT', method: 'STORE_CREDIT', expectedDifferenceCents: -20000, customerId: 'cust-1', ...settlement },
    staffId: 'staff-1',
    deviceId: 'caja-1',
    createdAtLocal: '2026-10-31T12:00:00-06:00',
  })
  const entrada = (b = cuerpo()) => ({
    venueId: 'v1',
    actorStaffId: 'staff-1',
    body: b,
    requestHash: 'huella-1',
    originalOrderId: 'order-1',
  })
  /**
   * La transacción del Cambio, aparte del cliente global (S10 r2, familia A): cada consulta de la transacción va por ELLA. Con el
   * cliente global, cada Cambio ocupa una conexión y pide otra: con 18 a la vez se traban todos.
   */
  const transaccion = () => ({
    $queryRaw: jest.fn(async () => []),
    giftCard: { findFirst: jest.fn(async () => null) },
    exchange: { findUnique: jest.fn(async () => null) },
    venue: {
      findUnique: jest.fn(async () => ({
        id: 'v1',
        name: 'Tienda',
        salesEnabled: true,
        type: 'CLOTHING',
        settings: { exchangesEnabled: true },
      })),
    },
    staffVenue: { findFirst: jest.fn(async () => ({ staffId: 'staff-1' })), findMany: jest.fn(async () => []) },
    payment: { count: jest.fn(async () => 0) },
    exchangeCreditLink: { count: jest.fn(async () => 0) },
  })
  let tx: ReturnType<typeof transaccion>
  const ahora = Date.now()
  beforeEach(() => {
    mockDisponible.mockReturnValue(true)
    tx = transaccion()
  })
  afterEach(() => {
    const reloj = jest.spyOn(Date, 'now').mockReturnValue(ahora + 4 * 60_000)
    expect(hayDevolucionEnTerminal('pay-3')).toBe(false)
    reloj.mockRestore()
  })
  const preparar = (b?: CreateExchangeBody) => prepareExchangeInTx(tx as never, entrada(b))

  it('una repetición (la primera ya escribió) contesta lo escrito aunque hoy falten las llaves, esté la marca o se hayan apagado los cambios', async () => {
    mockDisponible.mockReturnValue(false)
    marcarDevolucionEnTerminal('pay-3')
    tx.payment.count.mockResolvedValue(1)
    tx.venue.findUnique.mockResolvedValue({
      id: 'v1',
      name: 'Tienda',
      salesEnabled: true,
      type: 'CLOTHING',
      settings: { exchangesEnabled: false },
    })
    tx.exchange.findUnique.mockResolvedValue({ requestHash: 'huella-1', result: { id: 'ex-1' }, resultRevision: 3 } as never)

    await expect(preparar()).resolves.toEqual({ replay: { id: 'ex-1' }, resultRevision: 3 })
    expect(tx.venue.findUnique).not.toHaveBeenCalled()
    expect(tx.staffVenue.findFirst).not.toHaveBeenCalled()
    expect(tx.payment.count).not.toHaveBeenCalled()
  })

  it('🔴 S10 r2 (familia A): la venta de la sucursal y la persona activa se leen con la TRANSACCIÓN, nunca con el cliente global', async () => {
    mockDisponible.mockReturnValue(false) // se detiene justo después de las puertas
    await expect(preparar()).rejects.toMatchObject({ code: 'STORE_CREDIT_UNAVAILABLE' })

    expect(tx.staffVenue.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { staffId: 'staff-1', venueId: 'v1', active: true } }),
    )
    expect(tx.venue.findUnique).toHaveBeenCalledTimes(2) // cambios prendidos + ventas de la sucursal
    expect(global.staffVenue.findFirst).not.toHaveBeenCalled()
    expect(global.venue.findUnique).not.toHaveBeenCalled()
  })

  it('una persona ya inactiva en la sucursal se rechaza después de la llave (400, como siempre)', async () => {
    tx.staffVenue.findFirst.mockResolvedValue(null as never)
    await expect(preparar(cuerpo({ method: 'CASH', customerId: undefined }))).rejects.toMatchObject({ statusCode: 400 })
    expect(tx.exchange.findUnique).toHaveBeenCalled()
  })

  it('sin las llaves → STORE_CREDIT_UNAVAILABLE (422), después de leer la llave', async () => {
    mockDisponible.mockReturnValue(false)
    await expect(preparar()).rejects.toMatchObject({ statusCode: 422, code: 'STORE_CREDIT_UNAVAILABLE' })
    expect(tx.exchange.findUnique).toHaveBeenCalled()
  })

  it('con la terminal devolviendo un cobro de la venta → 409 STORE_CREDIT_TERMINAL_REFUND_IN_PROGRESS, con la transacción', async () => {
    marcarDevolucionEnTerminal('pay-3')
    tx.payment.count.mockResolvedValue(1)
    await expect(preparar()).rejects.toMatchObject({ statusCode: 409, code: 'STORE_CREDIT_TERMINAL_REFUND_IN_PROGRESS' })
    // Los cobros de la venta original entre los marcados, contados con la transacción.
    expect(tx.payment.count).toHaveBeenCalledWith({ where: { venueId: 'v1', orderId: 'order-1', id: { in: ['pay-3'] } } })
    expect(global.payment.count).not.toHaveBeenCalled()
  })

  it('con los cambios apagados → EXCHANGES_DISABLED (422), después de leer la llave', async () => {
    tx.venue.findUnique.mockResolvedValue({
      id: 'v1',
      name: 'Tienda',
      salesEnabled: true,
      type: 'CLOTHING',
      settings: { exchangesEnabled: false },
    })
    await expect(preparar(cuerpo({ method: 'CASH', customerId: undefined }))).rejects.toMatchObject({
      statusCode: 422,
      code: 'EXCHANGES_DISABLED',
    })
    expect(tx.exchange.findUnique).toHaveBeenCalled()
  })

  it('con la sucursal sin ventas → VENUE_SALES_DISABLED (403), leído con la transacción', async () => {
    tx.venue.findUnique.mockResolvedValue({
      id: 'v1',
      name: 'Tienda',
      salesEnabled: false,
      type: 'CLOTHING',
      settings: { exchangesEnabled: true },
    })
    await expect(preparar(cuerpo({ method: 'CASH', customerId: undefined }))).rejects.toMatchObject({
      statusCode: 403,
      code: 'VENUE_SALES_DISABLED',
    })
  })
})

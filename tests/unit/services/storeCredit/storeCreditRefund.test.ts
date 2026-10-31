/**
 * El Reembolso del POS a saldo a favor (spec 2026-10-30-saldo-a-favor §4 y §5.5, tarea S4).
 *
 * Lo que protege:
 * - `refundMethod: 'STORE_CREDIT'` abona lo devuelto al sobre de la clienta elegida (no necesariamente la de la venta: mamá → hija),
 *   con llave obligatoria; sin llaves de tarjetas el SERVIDOR no lo da y no escribe nada;
 * - lo pagado con saldo de regalo sigue regresando a su mismo sobre (nunca a un saldo a favor nuevo);
 * - «Sólo saldo a favor»: con devolución de mercancía u «Otro» y sin defecto, sólo sale como saldo (o a su mismo sobre); cobro por
 *   error, fraudulento o cuenta cancelada salen libres. Una app vieja que manda CASH recibe 400 con la razón;
 * - 🔴 la app muere tras el commit y reenvía OTRA cajera con la misma llave: la huella no lleva a la cajera, así que se reconoce el
 *   reembolso original (con la cajera que lo hizo) y no se crea otro; la respuesta repetida trae el mismo `storeCredit`;
 * - el detalle de un REFUND a saldo dice a quién se abonó, para reimprimir el ticket.
 */
jest.mock('@/services/dashboard/refund.dashboard.service', () => ({
  ...jest.requireActual('@/services/dashboard/refund.dashboard.service'),
  issueRefund: jest.fn(),
  listRefundsForPayment: jest.fn().mockResolvedValue([]),
}))
jest.mock('@/services/storeCredit/storeCreditTender', () => ({
  ...jest.requireActual('@/services/storeCredit/storeCreditTender'),
  prepararMediosDeSaldoAFavor: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('@/services/giftCards/giftCardLedger', () => ({
  ...jest.requireActual('@/services/giftCards/giftCardLedger'),
  abonarSaldoAFavorEnTx: jest.fn(),
}))

import { Prisma } from '@prisma/client'
import { issueRefund, type AbonarSaldoAFavor } from '@/services/dashboard/refund.dashboard.service'
import { prepararMediosDeSaldoAFavor } from '@/services/storeCredit/storeCreditTender'
import { abonarSaldoAFavorEnTx, type SobrePreparado } from '@/services/giftCards/giftCardLedger'
import { logAction } from '@/services/dashboard/activity-log.service'
import { operationHash } from '@/utils/operationHash'
import {
  issuePosRefund,
  opcionDeSaldoAFavor,
  soloSaldoLoImpide,
  type PosRefundInput,
} from '@/services/storeCredit/storeCreditRefund.service'
import { getTransactionDetail, getTransactions } from '@/services/mobile/transaction.mobile.service'
import { prismaMock } from '../../../__helpers__/setup'

const VENUE = 'cmvixy2n100006kwa5fvmb7r7'
const PAGO = 'cmvixy2n200026kwa0nkl078r'
const REFUND = 'cmvixy2n200036kwaf9s420p2'
const ORDER = 'cmvixy2n200016kwa586a3ucx'
const HIJA = 'cmvixy2n3000b6kwa8c9y3ehr'
const CAJERA_A = 'cmvixy2n200056kwa8y39hsli'
const CAJERA_B = 'cmvixy2n200066kwad0rtcdnh'
const SOBRE = 'cmvixy2n200076kwafwkmecvb'
const LLAVE = 'reembolso-saldo-0001'

const issueRefundMock = issueRefund as jest.Mock
const prepararMock = prepararMediosDeSaldoAFavor as jest.Mock
const abonarMock = abonarSaldoAFavorEnTx as jest.Mock

/** El cobro que se devuelve, como lo lee el pre-vuelo (medio, canal y marca del tender). */
const cobro = (over: Record<string, unknown> = {}) => ({
  method: 'CASH',
  source: 'POS',
  externalSource: null,
  tenderSatFormaPago: '01',
  fundsFlow: 'CASH_DRAWER',
  tenderTypeId: null,
  tenderCountsAsCash: null,
  tenderType: null,
  ...over,
})
const TARJETA_DE_TERMINAL = { method: 'CREDIT_CARD', source: 'TPV', fundsFlow: 'AVOQADO_PROCESSED', tenderSatFormaPago: '04' }
const TRANSFERENCIA = { method: 'BANK_TRANSFER', source: 'POS', fundsFlow: 'EXTERNAL_RECORDED', tenderSatFormaPago: '03' }
const SALDO_DE_REGALO = { method: 'OTHER', source: 'POS', fundsFlow: 'EXTERNAL_RECORDED', tenderType: { systemKind: 'GIFT_CARD' } }

/** El movimiento de la libreta que dejó el abono (`saldo-a-favor:<id del REFUND>`), con el sobre y su clienta. */
const movimiento = (over: { phone?: string | null; recipientPhone?: string; amount?: number; balanceAfter?: number } = {}) => ({
  refundPaymentId: REFUND,
  amount: new Prisma.Decimal(over.amount ?? 150),
  balanceAfter: new Prisma.Decimal(over.balanceAfter ?? 350),
  giftCard: {
    customerId: HIJA,
    recipientName: 'Hija Prueba',
    recipientPhone: over.recipientPhone ?? '+525512345678',
    customer: { firstName: 'Hija', lastName: 'Prueba', phone: over.phone === undefined ? '5512345678' : over.phone },
  },
})

const resultadoDelNucleo = { refundId: REFUND, originalPaymentId: PAGO, amount: 150, remainingRefundable: 150, status: 'COMPLETED' }

const pedir = (over: Partial<PosRefundInput> = {}): PosRefundInput => ({
  venueId: VENUE,
  paymentId: PAGO,
  amount: 15000,
  reason: 'RETURNED_GOODS',
  staffId: CAJERA_A,
  refundMethod: 'STORE_CREDIT',
  customerId: HIJA,
  idempotencyKey: LLAVE,
  ...over,
})

const guardadas = { code: process.env.GIFT_CARD_CODE_KEY, hmac: process.env.GIFT_CARD_HMAC_KEY }
afterEach(() => {
  process.env.GIFT_CARD_CODE_KEY = guardadas.code
  process.env.GIFT_CARD_HMAC_KEY = guardadas.hmac
})

beforeEach(() => {
  prismaMock.payment.findFirst.mockResolvedValue(cobro())
  prismaMock.payment.findUnique.mockResolvedValue(null)
  prismaMock.venueSettings.findUnique.mockResolvedValue(null)
  prismaMock.giftCardActivity.findMany.mockResolvedValue([movimiento()])
  issueRefundMock.mockResolvedValue({ ...resultadoDelNucleo, abono: { giftCardId: SOBRE } })
})

describe('Reembolso del POS a saldo a favor', () => {
  it.each([
    ['efectivo', {}],
    ['transferencia', TRANSFERENCIA],
    ['tarjeta de terminal', TARJETA_DE_TERMINAL],
  ])(
    '%s se puede devolver a saldo: el núcleo recibe el destino con la clienta elegida y los medios se preparan antes',
    async (_n, medio) => {
      prismaMock.payment.findFirst.mockResolvedValue(cobro(medio))

      const r = await issuePosRefund(pedir())

      expect(prepararMock).toHaveBeenCalledWith(VENUE)
      expect(prepararMock.mock.invocationCallOrder[0]).toBeLessThan(issueRefundMock.mock.invocationCallOrder[0])
      const entregado = issueRefundMock.mock.calls[0][0]
      expect(entregado).toMatchObject({ venueId: VENUE, paymentId: PAGO, amount: 15000, idempotencyKey: LLAVE, staffId: CAJERA_A })
      expect(entregado.aSaldoAFavor).toEqual({ customerId: HIJA, abonar: expect.any(Function) })
      expect(entregado.refundMethod).toBeUndefined()
      expect(r.storeCredit).toMatchObject({ customerId: HIJA, amountCents: 15000 })
      expect(opcionDeSaldoAFavor({ ...cobro(medio), tenderSystemKind: null })).toEqual({ available: true })
    },
  )

  it('el abono va a la libreta con el monto de la fila, la cajera, el folio de la venta y el tipo REEMBOLSO', async () => {
    await issuePosRefund(pedir())
    const abonar = issueRefundMock.mock.calls[0][0].aSaldoAFavor.abonar as AbonarSaldoAFavor
    const tx = { order: { findFirst: jest.fn().mockResolvedValue({ orderNumber: 'ORD-77' }) } } as never
    const preparado = { venueId: VENUE, customerId: HIJA } as SobrePreparado
    abonarMock.mockResolvedValue({ giftCardId: SOBRE })

    await abonar(tx, REFUND, preparado, { orderId: ORDER, montoCents: 15050 })

    expect(abonarMock).toHaveBeenCalledWith(tx, {
      preparado,
      monto: new Prisma.Decimal('150.50'),
      staffId: CAJERA_A,
      origen: { orderId: ORDER, refundPaymentId: REFUND },
      folio: 'ORD-77',
      tipo: 'REEMBOLSO',
    })
  })

  it('lo pagado con saldo de regalo sigue regresando a su sobre (refundToGiftCardBalance): a saldo a favor nuevo no, y sin medio pasa como hoy', async () => {
    prismaMock.payment.findFirst.mockResolvedValue(cobro(SALDO_DE_REGALO))

    await expect(issuePosRefund(pedir())).rejects.toMatchObject({ statusCode: 422, code: 'STORE_CREDIT_NOT_ALLOWED' })
    expect(issueRefundMock).not.toHaveBeenCalled()
    expect(prepararMock).not.toHaveBeenCalled()

    await issuePosRefund(pedir({ refundMethod: undefined, customerId: undefined }))
    expect(issueRefundMock.mock.calls[0][0].aSaldoAFavor).toBeUndefined()
    expect(opcionDeSaldoAFavor({ ...cobro(SALDO_DE_REGALO), tenderSystemKind: 'GIFT_CARD' })).toEqual({
      available: false,
      reason: expect.stringContaining('regresa a su misma tarjeta'),
    })
  })

  it('crédito de cambio con raíz en tarjeta bancaria se devuelve a saldo (lo decide el núcleo con la raíz); con raíz en tarjeta de regalo sigue bloqueado y no escribe', async () => {
    prismaMock.payment.findFirst.mockResolvedValue(cobro({ method: 'OTHER', tenderType: { systemKind: 'EXCHANGE_CREDIT' } }))
    await issuePosRefund(pedir())
    expect(issueRefundMock.mock.calls[0][0].aSaldoAFavor).toEqual({ customerId: HIJA, abonar: expect.any(Function) })
    ;(logAction as jest.Mock).mockClear()

    const bloqueo = Object.assign(new Error('Este crédito viene de una tarjeta de regalo.'), {
      statusCode: 422,
      code: 'EXCHANGE_CHAIN_GIFT_CARD_PENDING',
    })
    issueRefundMock.mockRejectedValueOnce(bloqueo)
    await expect(issuePosRefund(pedir())).rejects.toBe(bloqueo)
    expect(logAction).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'REFUND_TO_STORE_CREDIT' }))
  })

  it('una venta de una app de reparto no se pasa a saldo', async () => {
    prismaMock.payment.findFirst.mockResolvedValue(cobro({ method: 'OTHER', source: 'DELIVERY_PLATFORM', fundsFlow: 'EXTERNAL_RECORDED' }))
    await expect(issuePosRefund(pedir())).rejects.toMatchObject({ statusCode: 422, code: 'STORE_CREDIT_NOT_ALLOWED' })
    expect(issueRefundMock).not.toHaveBeenCalled()
  })

  it('sin idempotencyKey con STORE_CREDIT da 400 y no escribe', async () => {
    await expect(issuePosRefund(pedir({ idempotencyKey: undefined }))).rejects.toMatchObject({
      statusCode: 400,
      code: 'STORE_CREDIT_IDEMPOTENCY_KEY_REQUIRED',
    })
    expect(issueRefundMock).not.toHaveBeenCalled()
    expect(prepararMock).not.toHaveBeenCalled()
  })

  it('sin clienta con STORE_CREDIT da 400 STORE_CREDIT_CUSTOMER_REQUIRED y no escribe', async () => {
    await expect(issuePosRefund(pedir({ customerId: undefined }))).rejects.toMatchObject({
      statusCode: 400,
      code: 'STORE_CREDIT_CUSTOMER_REQUIRED',
    })
    expect(issueRefundMock).not.toHaveBeenCalled()
  })

  it('sin llaves de tarjetas responde STORE_CREDIT_UNAVAILABLE (422) y no escribe', async () => {
    delete process.env.GIFT_CARD_HMAC_KEY

    await expect(issuePosRefund(pedir())).rejects.toMatchObject({
      statusCode: 422,
      code: 'STORE_CREDIT_UNAVAILABLE',
      message: 'Pide a Avoqado que active el saldo a favor.',
    })
    expect(prepararMock).not.toHaveBeenCalled()
    expect(issueRefundMock).not.toHaveBeenCalled()
    expect(opcionDeSaldoAFavor({ ...cobro(), tenderSystemKind: null })).toEqual({
      available: false,
      reason: 'Pide a Avoqado que active el saldo a favor.',
    })
  })

  it('la respuesta trae storeCredit con phoneMismatch (el sobre se usa con otro teléfono que el de la ficha) y sin el abono crudo', async () => {
    prismaMock.giftCardActivity.findMany.mockResolvedValue([movimiento({ phone: '5599998888', recipientPhone: '+525512345678' })])

    const r = await issuePosRefund(pedir())

    expect(r.storeCredit).toEqual({
      customerId: HIJA,
      customerName: 'Hija Prueba',
      amountCents: 15000,
      newBalanceCents: 35000,
      phoneLast4: '5678',
      phoneMismatch: true,
    })
    expect(r).not.toHaveProperty('abono')
    expect(prismaMock.giftCardActivity.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { venueId: VENUE, operationKey: { in: [`saldo-a-favor:${REFUND}`] } } }),
    )
  })

  it('con el mismo teléfono en la ficha y en el sobre, phoneMismatch es false', async () => {
    const r = await issuePosRefund(pedir())
    expect(r.storeCredit).toMatchObject({ phoneLast4: '5678', phoneMismatch: false })
  })

  it('deja en la bitácora REFUND_TO_STORE_CREDIT con a quién y cuánto (sólo cuando el núcleo abonó, no en una repetición)', async () => {
    await issuePosRefund(pedir())
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'REFUND_TO_STORE_CREDIT',
        venueId: VENUE,
        staffId: CAJERA_A,
        entity: 'Payment',
        entityId: REFUND,
        data: expect.objectContaining({ originalPaymentId: PAGO, giftCardId: SOBRE, customerId: HIJA, amount: 150, newBalance: 350 }),
      }),
    )
    ;(logAction as jest.Mock).mockClear()
    issueRefundMock.mockResolvedValue(resultadoDelNucleo) // la repetición por llave no trae abono
    await issuePosRefund(pedir())
    expect(logAction).not.toHaveBeenCalled()
  })

  it('regresión: CASH y BANK_TRANSFER siguen yendo al núcleo como hoy, sin destino de saldo ni medios preparados', async () => {
    await issuePosRefund(pedir({ refundMethod: 'CASH', customerId: undefined, idempotencyKey: undefined, reason: 'ACCIDENTAL_CHARGE' }))
    const entregado = issueRefundMock.mock.calls[0][0]
    expect(entregado.refundMethod).toBe('CASH')
    expect(entregado.aSaldoAFavor).toBeUndefined()
    expect(prepararMock).not.toHaveBeenCalled()
    expect(prismaMock.giftCardActivity.findMany).not.toHaveBeenCalled()
  })
})

describe('«Sólo saldo a favor»', () => {
  const soloSaldo = () => prismaMock.venueSettings.findUnique.mockResolvedValue({ storeCreditOnly: true })

  it('sólo saldo a favor + RETURNED_GOODS rechaza CASH con 400 y razón, sin escribir', async () => {
    soloSaldo()
    await expect(issuePosRefund(pedir({ refundMethod: 'CASH', customerId: undefined }))).rejects.toMatchObject({
      statusCode: 400,
      code: 'STORE_CREDIT_ONLY',
      message: expect.stringContaining('Este negocio devuelve sólo como saldo a favor'),
    })
    expect(issueRefundMock).not.toHaveBeenCalled()
  })

  it('… + OTHER sin medio (una app vieja, «como se pagó») también se rechaza', async () => {
    soloSaldo()
    await expect(issuePosRefund(pedir({ reason: 'OTHER', refundMethod: undefined, customerId: undefined }))).rejects.toMatchObject({
      code: 'STORE_CREDIT_ONLY',
    })
  })

  it('… + defective acepta CASH', async () => {
    soloSaldo()
    await issuePosRefund(pedir({ refundMethod: 'CASH', customerId: undefined, defective: true }))
    expect(issueRefundMock).toHaveBeenCalledWith(expect.objectContaining({ refundMethod: 'CASH' }))
  })

  it.each(['ACCIDENTAL_CHARGE', 'FRAUDULENT_CHARGE', 'CANCELLED_ORDER'] as const)('… + %s acepta CASH', async reason => {
    soloSaldo()
    await issuePosRefund(pedir({ reason, refundMethod: 'CASH', customerId: undefined }))
    expect(issueRefundMock).toHaveBeenCalledWith(expect.objectContaining({ refundMethod: 'CASH', reason }))
  })

  it('… + pagado con saldo deja regresar al mismo sobre', async () => {
    soloSaldo()
    prismaMock.payment.findFirst.mockResolvedValue(cobro(SALDO_DE_REGALO))
    await issuePosRefund(pedir({ refundMethod: undefined, customerId: undefined }))
    expect(issueRefundMock).toHaveBeenCalledTimes(1)
  })

  it('… + STORE_CREDIT pasa', async () => {
    soloSaldo()
    await issuePosRefund(pedir())
    expect(issueRefundMock).toHaveBeenCalledTimes(1)
  })

  it('la regla, sola', () => {
    const base = { storeCreditOnly: true, reason: 'RETURNED_GOODS', pagadoConSaldo: false }
    expect(soloSaldoLoImpide({ ...base, refundMethod: 'CASH' })).toBe(true)
    expect(soloSaldoLoImpide({ ...base, refundMethod: 'BANK_TRANSFER' })).toBe(true)
    expect(soloSaldoLoImpide({ ...base, refundMethod: undefined })).toBe(true)
    expect(soloSaldoLoImpide({ ...base, refundMethod: 'STORE_CREDIT' })).toBe(false)
    expect(soloSaldoLoImpide({ ...base, refundMethod: undefined, pagadoConSaldo: true })).toBe(false)
    expect(soloSaldoLoImpide({ ...base, refundMethod: 'CASH', defective: true })).toBe(false)
    expect(soloSaldoLoImpide({ ...base, reason: 'OTHER', refundMethod: 'CASH' })).toBe(true)
    expect(soloSaldoLoImpide({ ...base, reason: 'ACCIDENTAL_CHARGE', refundMethod: 'CASH' })).toBe(false)
    expect(soloSaldoLoImpide({ ...base, storeCreditOnly: false, refundMethod: 'CASH' })).toBe(false)
  })

  it('sin el interruptor, una petición vieja con CASH ni siquiera lee la venta', async () => {
    await issuePosRefund(pedir({ refundMethod: 'CASH', customerId: undefined, idempotencyKey: undefined }))
    expect(prismaMock.payment.findFirst).not.toHaveBeenCalled()
    expect(issueRefundMock).toHaveBeenCalledTimes(1)
  })
})

describe('🔴 la app muere tras el commit y reenvía OTRA cajera con la misma llave', () => {
  it('la repetición se reconoce ANTES de las reglas (aunque se hayan apagado las llaves o prendido «sólo saldo») y responde el mismo storeCredit', async () => {
    prismaMock.payment.findUnique.mockResolvedValue({ id: REFUND })
    prismaMock.venueSettings.findUnique.mockResolvedValue({ storeCreditOnly: true })
    delete process.env.GIFT_CARD_CODE_KEY
    issueRefundMock.mockResolvedValue(resultadoDelNucleo) // la repetición no trae abono

    const r = await issuePosRefund(pedir({ staffId: CAJERA_B }))

    expect(prepararMock).not.toHaveBeenCalled()
    expect(issueRefundMock).toHaveBeenCalledTimes(1)
    expect(r.refundId).toBe(REFUND)
    expect(r.storeCredit).toEqual({
      customerId: HIJA,
      customerName: 'Hija Prueba',
      amountCents: 15000,
      newBalanceCents: 35000,
      phoneLast4: '5678',
      phoneMismatch: false,
    })
  })

  describe('la huella de la llave (núcleo real)', () => {
    const real = jest.requireActual(
      '@/services/dashboard/refund.dashboard.service',
    ) as typeof import('@/services/dashboard/refund.dashboard.service')
    const abonar = jest.fn()
    const entrada = (staffId: string, aSaldo: boolean) => ({
      venueId: VENUE,
      paymentId: PAGO,
      amount: 15000,
      reason: 'RETURNED_GOODS' as const,
      staffId,
      note: null,
      idempotencyKey: LLAVE,
      ...(aSaldo ? { aSaldoAFavor: { customerId: HIJA, abonar } } : {}),
    })
    /** La fila que dejó A: su huella es la que el núcleo calculó al escribirla. */
    const filaDeA = (hash: string) => ({
      id: REFUND,
      type: 'REFUND',
      amount: new Prisma.Decimal(-150),
      tipAmount: new Prisma.Decimal(0),
      processorData: { originalPaymentId: PAGO, idempotencyRequestHash: hash, remainingAfterCents: 15000 },
    })

    it('A envía, se pierde la respuesta, B reenvía con la misma llave → un solo reembolso, staffId de A (la huella no lleva a la cajera)', async () => {
      const huellaDeA = operationHash({ ...entrada(CAJERA_A, true), idempotencyKey: undefined, staffId: undefined })
      prismaMock.payment.findUnique.mockResolvedValue(filaDeA(huellaDeA))

      const r = await real.issueRefund(entrada(CAJERA_B, true))

      expect(r).toMatchObject({ refundId: REFUND, amount: 150, remainingRefundable: 150 })
      expect(prismaMock.$transaction).not.toHaveBeenCalled()
      expect(abonar).not.toHaveBeenCalled()
    })

    it('regresión: fuera del saldo a favor la huella sigue llevando a la cajera (otra cajera con la misma llave = IDEMPOTENCY_KEY_REUSED)', async () => {
      const huellaDeA = operationHash({ ...entrada(CAJERA_A, false), idempotencyKey: undefined })
      prismaMock.payment.findUnique.mockResolvedValue(filaDeA(huellaDeA))

      await expect(real.issueRefund(entrada(CAJERA_B, false))).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' })
      prismaMock.payment.findUnique.mockResolvedValue(filaDeA(huellaDeA))
      await expect(real.issueRefund(entrada(CAJERA_A, false))).resolves.toMatchObject({ refundId: REFUND })
    })

    it('el saldo a favor para OTRA clienta con la misma llave no es repetición', async () => {
      const huellaDeA = operationHash({ ...entrada(CAJERA_A, true), idempotencyKey: undefined, staffId: undefined })
      prismaMock.payment.findUnique.mockResolvedValue(filaDeA(huellaDeA))
      const otra = { ...entrada(CAJERA_A, true), aSaldoAFavor: { customerId: 'cmvixy2n3000c6kwa8c9y3ehr', abonar } }

      await expect(real.issueRefund(otra)).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' })
    })
  })
})

describe('el detalle y la lista del POS dicen a quién se abonó (reimpresión del ticket)', () => {
  const refundASaldo = {
    id: REFUND,
    amount: -150,
    tipAmount: 0,
    method: 'OTHER',
    source: 'OTHER',
    externalSource: null,
    tenderSatFormaPago: '17',
    fundsFlow: 'EXTERNAL_RECORDED',
    tenderTypeId: 'tender-sc',
    tenderCountsAsCash: false,
    tenderLabel: 'Saldo a favor',
    tenderType: { systemKind: 'STORE_CREDIT' },
    status: 'COMPLETED',
    type: 'REFUND',
    cardBrand: null,
    maskedPan: null,
    referenceNumber: null,
    authorizationNumber: null,
    createdAt: new Date('2026-10-31T18:00:00.000Z'),
    processorData: { originalPaymentId: PAGO },
    orderId: null,
    processedBy: null,
    // La venta es de la MAMÁ; el saldo fue para la HIJA.
    order: { status: 'COMPLETED', paymentStatus: 'PAID', customerId: 'mama', customerName: 'Mamá Prueba', orderCustomers: [], items: [] },
  }

  it('el detalle del REFUND a saldo trae storeCredit.customerName aunque la venta tenga otra clienta (mamá → hija)', async () => {
    prismaMock.payment.findFirst.mockResolvedValue(refundASaldo)

    const d = await getTransactionDetail(VENUE, REFUND)

    expect(d.customerName).toBe('Mamá Prueba')
    expect(d.storeCredit).toEqual({ customerName: 'Hija Prueba', amountCents: 15000 })
  })

  it('la lista trae storeCredit en la fila del REFUND a saldo, y nada en las demás', async () => {
    const fila = (id: string, systemKind: string | null) => ({
      id,
      amount: -150,
      tipAmount: 0,
      method: 'OTHER',
      status: 'COMPLETED',
      cardBrand: null,
      maskedPan: null,
      referenceNumber: null,
      createdAt: new Date('2026-10-31T18:00:00.000Z'),
      order: null,
      processedBy: null,
      tenderType: systemKind ? { systemKind } : null,
    })
    prismaMock.$transaction.mockResolvedValue([[fila(REFUND, 'STORE_CREDIT'), fila('pay_efectivo', null)], 2])

    const r = await getTransactions(VENUE, 1, 20)

    expect(r.data.map(t => [t.id, t.storeCredit])).toEqual([
      [REFUND, { customerName: 'Hija Prueba', amountCents: 15000 }],
      ['pay_efectivo', undefined],
    ])
    expect(prismaMock.giftCardActivity.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 1 }))
  })

  it('una página sin devoluciones a saldo no consulta la libreta', async () => {
    prismaMock.$transaction.mockResolvedValue([[], 0])
    await getTransactions(VENUE, 1, 20)
    expect(prismaMock.giftCardActivity.findMany).not.toHaveBeenCalled()
  })

  it('el detalle de una venta trae storeCreditOption (y un cobro con saldo de regalo la trae apagada con su razón)', async () => {
    prismaMock.payment.findFirst.mockResolvedValue({
      ...refundASaldo,
      ...cobro(),
      id: PAGO,
      type: 'REGULAR',
      amount: 300,
      processorData: null,
    })
    expect((await getTransactionDetail(VENUE, PAGO)).storeCreditOption).toEqual({ available: true })

    prismaMock.payment.findFirst.mockResolvedValue({
      ...refundASaldo,
      ...cobro(SALDO_DE_REGALO),
      id: PAGO,
      type: 'REGULAR',
      amount: 300,
      processorData: null,
    })
    const conSaldo = await getTransactionDetail(VENUE, PAGO)
    expect(conSaldo.storeCreditOption).toEqual({ available: false, reason: expect.any(String) })
    expect(conSaldo.refundToGiftCardBalance).toBe(true)
    expect(conSaldo).not.toHaveProperty('storeCredit')
  })
})

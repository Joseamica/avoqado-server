/**
 * La devolución de la terminal que llega DESPUÉS del saldo a favor (spec 2026-10-30-saldo-a-favor §5.5, opción 1 del founder: avisar y
 * congelar; tarea S7). Aquí lo que no necesita Postgres:
 * - la marca «la terminal está devolviendo este cobro» (memoria, 3 min) y el rechazo del Reembolso a saldo mientras vive;
 * - lo duplicado es el exceso NUEVO sobre el cobro (no se cuenta dos veces lo que ya se avisó);
 * - el tope de la terminal: lo que se pasó a saldo no salió del banco, así que el banco todavía lo tiene.
 * Lo que sólo prueba Postgres (anomalía, sobres congelados, cadena del Cambio, interbloqueo) está en
 * `tests/integration/storeCredit/devolucionTardiaDeTerminal.integration.test.ts`.
 */
jest.mock('@/services/dashboard/refund.dashboard.service', () => ({
  ...jest.requireActual('@/services/dashboard/refund.dashboard.service'),
  issueRefund: jest.fn(),
}))
jest.mock('@/services/storeCredit/storeCreditTender', () => ({
  ...jest.requireActual('@/services/storeCredit/storeCreditTender'),
  prepararMediosDeSaldoAFavor: jest.fn().mockResolvedValue(undefined),
}))

import { issueRefund } from '@/services/dashboard/refund.dashboard.service'
import { prepararMediosDeSaldoAFavor } from '@/services/storeCredit/storeCreditTender'
import { issuePosRefund, type PosRefundInput } from '@/services/storeCredit/storeCreditRefund.service'
import { hayDevolucionEnTerminal, marcarDevolucionEnTerminal } from '@/services/storeCredit/terminalRefundMarker'
import { centavosQueNoPasaronPorElBanco, duplicadoCents } from '@/services/exchanges/exchangeTerminalRefund'
import { prismaMock } from '../../../__helpers__/setup'

const VENUE = 'cmvixy2n100006kwa5fvmb7r7'
const CREDITO = 'cmvixy2n200026kwa0nkl078r'
const RAIZ = 'cmvixy2n200016kwa586a3ucx'

describe('la marca «la terminal está devolviendo este cobro»', () => {
  afterEach(() => jest.useRealTimers())

  it('vive 3 minutos y después se va sola', () => {
    jest.useFakeTimers({ now: new Date('2026-10-31T12:00:00Z') })
    marcarDevolucionEnTerminal('cobro-ttl')

    expect(hayDevolucionEnTerminal('cobro-ttl')).toBe(true)
    expect(hayDevolucionEnTerminal('otro-cobro')).toBe(false)
    jest.advanceTimersByTime(3 * 60_000 - 1)
    expect(hayDevolucionEnTerminal('cobro-ttl')).toBe(true)
    jest.advanceTimersByTime(1)
    expect(hayDevolucionEnTerminal('cobro-ttl')).toBe(false)
  })

  it('volver a abrir la devolución renueva los 3 minutos', () => {
    jest.useFakeTimers({ now: new Date('2026-10-31T12:00:00Z') })
    marcarDevolucionEnTerminal('cobro-renueva')
    jest.advanceTimersByTime(2 * 60_000)
    marcarDevolucionEnTerminal('cobro-renueva')
    jest.advanceTimersByTime(2 * 60_000)
    expect(hayDevolucionEnTerminal('cobro-renueva')).toBe(true)
    jest.advanceTimersByTime(60_000)
    expect(hayDevolucionEnTerminal('cobro-renueva')).toBe(false)
  })
})

describe('lo duplicado es el exceso NUEVO sobre el cobro, medido bajo su candado', () => {
  it.each([
    ['terminal $400 + saldo $150 sobre $500 → $50', { totalCents: 50000, devueltoAntesCents: 15000, esteCents: 40000 }, 5000],
    ['después otra de $100 → $100 (suman $150, no $200)', { totalCents: 50000, devueltoAntesCents: 55000, esteCents: 10000 }, 10000],
    ['sin exceso → nada', { totalCents: 50000, devueltoAntesCents: 15000, esteCents: 30000 }, 0],
    ['justo hasta el total → nada', { totalCents: 50000, devueltoAntesCents: 15000, esteCents: 35000 }, 0],
  ])('%s', (_n, entrada, esperado) => {
    expect(duplicadoCents(entrada)).toBe(esperado)
  })
})

describe('el tope de la terminal: lo que no pasó por el banco, el banco todavía lo tiene', () => {
  const fila = (cents: number, extra: Record<string, unknown> = {}) => ({
    amount: -cents / 100,
    tipAmount: 0,
    status: 'COMPLETED',
    processorData: {},
    tenderType: null,
    ...extra,
  })

  it('cuenta el saldo a favor, el gemelo del crédito y la diferencia de un Cambio, cada uno una sola vez', () => {
    expect(
      centavosQueNoPasaronPorElBanco([
        fila(15000, { tenderType: { systemKind: 'STORE_CREDIT' } }),
        fila(30000, { processorData: { exchange: { role: 'CREDIT', exchangeId: 'x1' } } }),
        // La diferencia de un Cambio que se fue a saldo: lleva las dos marcas y cuenta UNA vez.
        fila(20000, { processorData: { exchange: { role: 'DIFFERENCE', exchangeId: 'x1' } }, tenderType: { systemKind: 'STORE_CREDIT' } }),
      ]),
    ).toBe(65000)
  })

  it('no cuenta lo que devolvió la terminal, ni lo que no se completó', () => {
    expect(
      centavosQueNoPasaronPorElBanco([
        fila(40000),
        fila(15000, { status: 'FAILED', tenderType: { systemKind: 'STORE_CREDIT' } }),
        fila(1000, { tenderType: { systemKind: 'GIFT_CARD' } }),
      ]),
    ).toBe(0)
  })
})

describe('con la marca viva, el saldo a favor de ese cobro se rechaza', () => {
  const issueRefundMock = issueRefund as jest.Mock
  const prepararMock = prepararMediosDeSaldoAFavor as jest.Mock
  const pedir = (over: Partial<PosRefundInput> = {}): PosRefundInput => ({
    venueId: VENUE,
    paymentId: 'cobro-con-marca',
    amount: 15000,
    reason: 'RETURNED_GOODS',
    staffId: 'cajera-1',
    refundMethod: 'STORE_CREDIT',
    customerId: 'clienta-1',
    idempotencyKey: 'reembolso-saldo-marca-1',
    ...over,
  })

  beforeEach(() => {
    prismaMock.payment.findUnique.mockResolvedValue(null)
    prismaMock.payment.findFirst.mockResolvedValue({
      method: 'CREDIT_CARD',
      source: 'TPV',
      externalSource: null,
      tenderSatFormaPago: '04',
      fundsFlow: 'AVOQADO_PROCESSED',
      tenderTypeId: null,
      tenderCountsAsCash: null,
      tenderType: null,
    })
    prismaMock.exchangeCreditLink.count.mockResolvedValue(0)
    issueRefundMock.mockResolvedValue({ refundId: 'r1', originalPaymentId: 'cobro-con-marca', amount: 150, remainingRefundable: 0 })
    prismaMock.giftCardActivity.findMany.mockResolvedValue([])
  })

  it('el Reembolso a saldo responde 409 STORE_CREDIT_TERMINAL_REFUND_IN_PROGRESS y no escribe nada', async () => {
    marcarDevolucionEnTerminal('cobro-con-marca')

    await expect(issuePosRefund(pedir())).rejects.toMatchObject({
      statusCode: 409,
      code: 'STORE_CREDIT_TERMINAL_REFUND_IN_PROGRESS',
      message: expect.stringContaining('La terminal está devolviendo este cobro'),
    })
    expect(prepararMock).not.toHaveBeenCalled()
    expect(issueRefundMock).not.toHaveBeenCalled()
  })

  it('también si la terminal está devolviendo la RAÍZ de un crédito de cambio', async () => {
    marcarDevolucionEnTerminal(RAIZ)
    prismaMock.exchangeCreditLink.count.mockResolvedValue(1)

    await expect(issuePosRefund(pedir({ paymentId: CREDITO }))).rejects.toMatchObject({
      code: 'STORE_CREDIT_TERMINAL_REFUND_IN_PROGRESS',
    })
    // La raíz se busca entre los cobros marcados, por el vínculo del crédito (acotado por las marcas, no por la historia).
    expect(prismaMock.exchangeCreditLink.count).toHaveBeenCalledWith({
      where: { venueId: VENUE, originPaymentId: { in: expect.arrayContaining([RAIZ]) }, creditPaymentId: CREDITO },
    })
    expect(issueRefundMock).not.toHaveBeenCalled()
  })

  it('sin marca de ese cobro pasa igual que hoy', async () => {
    marcarDevolucionEnTerminal('otro-cobro-con-marca')

    await issuePosRefund(pedir({ paymentId: 'cobro-sin-marca' }))
    expect(issueRefundMock).toHaveBeenCalledTimes(1)
  })

  it('regresión: devolver como se pagó (sin saldo a favor) no mira la marca', async () => {
    marcarDevolucionEnTerminal('cobro-efectivo')

    await issuePosRefund(pedir({ paymentId: 'cobro-efectivo', refundMethod: 'CASH', customerId: undefined }))
    expect(issueRefundMock).toHaveBeenCalledTimes(1)
  })

  it('una repetición por llave se contesta como se escribió, aunque la marca esté viva', async () => {
    marcarDevolucionEnTerminal('cobro-repetido')
    prismaMock.payment.findUnique.mockResolvedValue({ id: 'r1' })

    await issuePosRefund(pedir({ paymentId: 'cobro-repetido' }))
    expect(issueRefundMock).toHaveBeenCalledTimes(1)
  })
})

/**
 * B1 · reembolsos con tarjetas de regalo contra Postgres real (spec §5.5; índice R2 y Review Focus 2). Más las notas del
 * coordinador: (1) nunca saldo a un sobre DEACTIVATED, (2) nunca dinero atrapado en una venta pagada con todo desactivado,
 * (4) el mismo reembolso dos veces a la vez regresa el saldo una sola vez.
 *
 * Correr: source ../urls-tarjetas.sh && TZ=UTC npx jest --selectProjects=integration --runInBand \
 *   --runTestsByPath tests/integration/giftCards/reembolsos.integration.test.ts
 */
jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: jest.fn(() => null) } }))
jest.mock('@/services/tpv/digitalReceipt.tpv.service', () => ({ generateDigitalReceipt: jest.fn().mockResolvedValue(null) }))

import { Prisma } from '@prisma/client'
import cuid from 'cuid'
import prisma from '@/utils/prismaClient'
import { issueRefund } from '@/services/dashboard/refund.dashboard.service'
import { recordRefund } from '@/services/tpv/refund.tpv.service'
import { activarSobresDeCuentaPagadaEnTx, revertirCanjeEnTx } from '@/services/giftCards/giftCardLedger'
import { ORDER_LOCK_WAIT_BUDGET, lockExistingOrderForPayment } from '@/services/shared/paymentShiftClaim'
import { crearNegocioDePrueba, sembrarCanje, sembrarVentaDeTarjetas } from './sembrarTarjetasDeRegalo'

jest.setTimeout(60000)

describe('B1 · reembolsos con tarjetas de regalo', () => {
  let venueId: string
  let staffId: string
  let organizationId: string

  // Negocio propio con nombre único y SIN limpieza (la libreta es de sólo inserción): ver la cabecera de la siembra.
  beforeAll(async () => {
    ;({ venueId, staffId, organizationId } = await crearNegocioDePrueba('b1-reembolsos'))
  })

  const refundsDe = (orderId: string) => prisma.payment.count({ where: { orderId, type: 'REFUND' } })

  it('🔴 el reembolso de un cobro con saldo regresa al saldo: REFUND con el tender de sistema y su REDEEM_REVERSAL', async () => {
    const venta = await sembrarVentaDeTarjetas({ venueId, organizationId, staffId, montos: [500], metodo: 'CASH' })
    const canje = await sembrarCanje({ venueId, staffId, giftCardIds: venta.giftCardIds, total: 300, conSaldo: 200, restoEnEfectivo: 100 })

    const r = await issueRefund({ venueId, paymentId: canje.pagoConSaldo.id, amount: 20000, reason: 'RETURNED_GOODS', staffId })

    const fila = await prisma.payment.findUniqueOrThrow({ where: { id: r.refundId } })
    expect(fila.type).toBe('REFUND')
    expect(fila.tenderTypeId).toBe(canje.pagoConSaldo.tenderTypeId)
    expect(fila.fundsFlow).toBe('EXTERNAL_RECORDED')
    expect(fila.tenderSatFormaPago).toBe('01')
    const reversos = await prisma.giftCardActivity.findMany({ where: { refundPaymentId: r.refundId }, take: 5 })
    expect(reversos).toHaveLength(1)
    expect(reversos[0]).toMatchObject({ type: 'REDEEM_REVERSAL', giftCardId: venta.giftCardIds[0] })
    expect(reversos[0].amount.toString()).toBe('200')
    const sobre = await prisma.giftCard.findUniqueOrThrow({ where: { id: venta.giftCardIds[0] } })
    expect(sobre.balance.toString()).toBe('500')
    // Los ganchos de siempre siguen corriendo en la misma transacción: el reverso de referido quedó encolado.
    expect(await prisma.paymentEffect.count({ where: { paymentId: r.refundId, kind: 'REFERRAL' } })).toBe(1)
  })

  it('un reembolso PARCIAL de un cobro con saldo sólo regresa esa parte', async () => {
    const venta = await sembrarVentaDeTarjetas({ venueId, organizationId, staffId, montos: [500], metodo: 'CASH' })
    const canje = await sembrarCanje({ venueId, staffId, giftCardIds: venta.giftCardIds, total: 200, conSaldo: 200 })
    await issueRefund({ venueId, paymentId: canje.pagoConSaldo.id, amount: 5000, reason: 'RETURNED_GOODS', staffId })
    const sobre = await prisma.giftCard.findUniqueOrThrow({ where: { id: venta.giftCardIds[0] } })
    expect(sobre.balance.toString()).toBe('350')
  })

  it.each(['CASH', 'BANK_TRANSFER'] as const)(
    '🔴 Review Focus 2: una app vieja pide «Devolver con %s» sobre un cobro con saldo ⇒ GIFT_CARD_REFUND_TO_BALANCE_ONLY y nada se escribe',
    async refundMethod => {
      const venta = await sembrarVentaDeTarjetas({ venueId, organizationId, staffId, montos: [500], metodo: 'CASH' })
      const canje = await sembrarCanje({ venueId, staffId, giftCardIds: venta.giftCardIds, total: 200, conSaldo: 200 })
      await expect(
        issueRefund({ venueId, paymentId: canje.pagoConSaldo.id, amount: 20000, reason: 'RETURNED_GOODS', staffId, refundMethod }),
      ).rejects.toMatchObject({ code: 'GIFT_CARD_REFUND_TO_BALANCE_ONLY' })
      expect(await refundsDe(canje.orderId)).toBe(0)
      const sobre = await prisma.giftCard.findUniqueOrThrow({ where: { id: venta.giftCardIds[0] } })
      expect(sobre.balance.toString()).toBe('300')
    },
  )

  it('🔴 la terminal no registra devoluciones de un cobro con saldo', async () => {
    const venta = await sembrarVentaDeTarjetas({ venueId, organizationId, staffId, montos: [500], metodo: 'CASH' })
    const canje = await sembrarCanje({ venueId, staffId, giftCardIds: venta.giftCardIds, total: 200, conSaldo: 200 })
    await expect(
      recordRefund(
        venueId,
        {
          venueId,
          originalPaymentId: canje.pagoConSaldo.id,
          amount: 20000,
          reason: 'CUSTOMER_REQUEST',
          authorizationNumber: 'AUT-GC-1',
          referenceNumber: 'REF-GC-1',
          isPartialRefund: false,
          currency: 'MXN',
        },
        staffId,
      ),
    ).rejects.toMatchObject({ code: 'GIFT_CARD_REFUND_TO_BALANCE_ONLY' })
    expect(await refundsDe(canje.orderId)).toBe(0)
  })

  it('🔴 R2: devolver la VENTA de tarjetas desde el panel sin iniciar la cancelación ⇒ GIFT_CARD_CANCEL_NOT_STARTED, sin REFUND', async () => {
    const venta = await sembrarVentaDeTarjetas({ venueId, organizationId, staffId, montos: [500], metodo: 'CASH' })
    await expect(
      issueRefund({ venueId, paymentId: venta.pagos[0].id, amount: 50000, reason: 'CANCELLED_ORDER', staffId }),
    ).rejects.toMatchObject({
      code: 'GIFT_CARD_CANCEL_NOT_STARTED',
    })
    expect(await refundsDe(venta.orderId)).toBe(0)
    const sobre = await prisma.giftCard.findUniqueOrThrow({ where: { id: venta.giftCardIds[0] } })
    expect(sobre.status).toBe('ACTIVE')
  })

  it('🔴 la terminal YA devolvió una venta de tarjetas que nadie canceló ⇒ se registra, los sobres se desactivan y queda la anomalía', async () => {
    const venta = await sembrarVentaDeTarjetas({ venueId, organizationId, staffId, montos: [300, 200], metodo: 'CREDIT_CARD' })
    const r = await recordRefund(
      venueId,
      {
        venueId,
        originalPaymentId: venta.pagos[0].id,
        amount: 50000,
        reason: 'CUSTOMER_REQUEST',
        authorizationNumber: 'AUT-GC-2',
        referenceNumber: 'REF-GC-2',
        isPartialRefund: false,
        currency: 'MXN',
        idempotencyKey: 'tpv-gc-sin-cancelar-0001',
      },
      staffId,
    )
    expect(await refundsDe(venta.orderId)).toBe(1)
    const sobres = await prisma.giftCard.findMany({ where: { id: { in: venta.giftCardIds } }, take: 2 })
    expect(sobres.map(s => s.status)).toEqual(['DEACTIVATED', 'DEACTIVATED'])
    expect(sobres.every(s => s.balance.isZero())).toBe(true)
    expect(
      await prisma.giftCardActivity.count({
        where: { giftCardId: { in: venta.giftCardIds }, type: 'DEACTIVATE', reason: 'SALE_CANCELLED' },
      }),
    ).toBe(2)
    expect(await prisma.moneyAnomaly.count({ where: { stripeEventId: `giftcard:REFUND_WITHOUT_CANCEL:${r.id}` } })).toBe(1)
  })

  it('🔴 E1: la terminal YA devolvió una venta de tarjetas cuyo sobre ya se USÓ ⇒ se registra igual, el sobre se desactiva con lo que le quedaba y queda la anomalía', async () => {
    const venta = await sembrarVentaDeTarjetas({ venueId, organizationId, staffId, montos: [500], metodo: 'CREDIT_CARD' })
    await sembrarCanje({ venueId, staffId, giftCardIds: venta.giftCardIds, total: 200, conSaldo: 200 })
    const r = await recordRefund(
      venueId,
      {
        venueId,
        originalPaymentId: venta.pagos[0].id,
        amount: 50000,
        reason: 'CUSTOMER_REQUEST',
        authorizationNumber: 'AUT-GC-3',
        referenceNumber: 'REF-GC-3',
        isPartialRefund: false,
        currency: 'MXN',
        idempotencyKey: 'tpv-gc-ya-usada-0001',
      },
      staffId,
    )
    expect(await refundsDe(venta.orderId)).toBe(1)
    const sobre = await prisma.giftCard.findUniqueOrThrow({ where: { id: venta.giftCardIds[0] } })
    expect([sobre.status, sobre.balance.toString()]).toEqual(['DEACTIVATED', '0'])
    const baja = await prisma.giftCardActivity.findFirstOrThrow({ where: { giftCardId: sobre.id, type: 'DEACTIVATE' } })
    expect([baja.amount.toFixed(2), baja.reason, baja.refundPaymentId]).toEqual(['300.00', 'SALE_CANCELLED', r.id])
    expect(await prisma.moneyAnomaly.count({ where: { stripeEventId: `giftcard:REFUND_WITHOUT_CANCEL:${r.id}` } })).toBe(1)
  })

  it('regresión: un reembolso en efectivo de una cuenta normal no toca tarjetas', async () => {
    const venta = await sembrarVentaDeTarjetas({ venueId, organizationId, staffId, montos: [500], metodo: 'CASH' })
    const canje = await sembrarCanje({ venueId, staffId, giftCardIds: venta.giftCardIds, total: 300, conSaldo: 200, restoEnEfectivo: 100 })
    const r = await issueRefund({ venueId, paymentId: canje.pagoEnEfectivo!.id, amount: 10000, reason: 'RETURNED_GOODS', staffId })
    expect(await prisma.giftCardActivity.count({ where: { refundPaymentId: r.refundId } })).toBe(0)
    const sobre = await prisma.giftCard.findUniqueOrThrow({ where: { id: venta.giftCardIds[0] } })
    expect(sobre.balance.toString()).toBe('300')
  })

  /** La terminal devuelve la venta de tarjetas sin cancelación (E1): los sobres quedan DEACTIVATED. */
  const terminalDevuelveLaVenta = (pagoId: string, centavos: number, llave: string) =>
    recordRefund(
      venueId,
      {
        venueId,
        originalPaymentId: pagoId,
        amount: centavos,
        reason: 'CUSTOMER_REQUEST',
        authorizationNumber: `AUT-${llave}`,
        referenceNumber: `REF-${llave}`,
        isPartialRefund: false,
        currency: 'MXN',
        idempotencyKey: `tpv-${llave}-${Date.now()}`,
      },
      staffId,
    )

  it('🔴 nota 1: devolver una compra pagada con el saldo de un sobre YA DEACTIVATED ⇒ 409 con su terminación y nada se escribe', async () => {
    const venta = await sembrarVentaDeTarjetas({ venueId, organizationId, staffId, montos: [500], metodo: 'CREDIT_CARD' })
    const canje = await sembrarCanje({ venueId, staffId, giftCardIds: venta.giftCardIds, total: 200, conSaldo: 200 })
    await terminalDevuelveLaVenta(venta.pagos[0].id, 50000, 'gc-nota1')
    const muerto = await prisma.giftCard.findUniqueOrThrow({ where: { id: venta.giftCardIds[0] } })
    expect(muerto.status).toBe('DEACTIVATED')

    await expect(
      issueRefund({ venueId, paymentId: canje.pagoConSaldo.id, amount: 20000, reason: 'RETURNED_GOODS', staffId }),
    ).rejects.toMatchObject({
      code: 'GIFT_CARD_TENDER_NOT_ALLOWED',
      statusCode: 409,
      details: { motivo: 'SOBRE_DESACTIVADO', giftCardIds: [muerto.id] },
      message: expect.stringContaining(`terminación ${muerto.codeLast4}`),
    })
    expect(await refundsDe(canje.orderId)).toBe(0)
    expect(await prisma.giftCardActivity.count({ where: { giftCardId: muerto.id, type: 'REDEEM_REVERSAL' } })).toBe(0)
    const despues = await prisma.giftCard.findUniqueOrThrow({ where: { id: muerto.id } })
    expect([despues.status, despues.balance.toString()]).toEqual(['DEACTIVATED', '0'])
  })

  it('🔴 nota 2: una venta PAGADA con todos sus sobres desactivados que recibió dinero DESPUÉS se devuelve desde el panel (nada queda atrapado)', async () => {
    const venta = await sembrarVentaDeTarjetas({ venueId, organizationId, staffId, montos: [300, 200], metodo: 'CREDIT_CARD' })
    await terminalDevuelveLaVenta(venta.pagos[0].id, 50000, 'gc-nota2')
    // Llega dinero tarde a la cuenta cancelada (un cobro reproducido): A6 no revive los sobres y deja PAID_WITH_DEACTIVATED.
    const tardio = await prisma.payment.create({
      data: {
        venueId,
        orderId: venta.orderId,
        amount: new Prisma.Decimal(500),
        tipAmount: new Prisma.Decimal(0),
        netAmount: new Prisma.Decimal(500),
        feePercentage: 0,
        feeAmount: new Prisma.Decimal(0),
        method: 'CASH',
        status: 'COMPLETED',
        type: 'REGULAR',
        splitType: 'FULLPAYMENT',
        source: 'POS',
        fundsFlow: 'CASH_DRAWER',
        processedById: staffId,
      },
    })
    await prisma.$transaction(async tx => {
      await lockExistingOrderForPayment(tx, { venueId, orderId: venta.orderId })
      await activarSobresDeCuentaPagadaEnTx(tx, { venueId, orderId: venta.orderId, staffId })
    }, ORDER_LOCK_WAIT_BUDGET)
    expect(await prisma.moneyAnomaly.count({ where: { stripeEventId: `giftcard:PAID_WITH_DEACTIVATED:${venta.orderId}` } })).toBe(1)
    const orden = await prisma.order.findUniqueOrThrow({ where: { id: venta.orderId } })
    expect(orden.paymentStatus).toBe('PAID')

    const r = await issueRefund({ venueId, paymentId: tardio.id, amount: 50000, reason: 'RETURNED_GOODS', staffId })

    expect(await refundsDe(venta.orderId)).toBe(2)
    expect(await prisma.giftCardActivity.count({ where: { refundPaymentId: r.refundId } })).toBe(0)
    const sobres = await prisma.giftCard.findMany({ where: { id: { in: venta.giftCardIds } }, take: 2 })
    expect(sobres.every(s => s.status === 'DEACTIVATED' && s.balance.isZero())).toBe(true)
    expect(await prisma.giftCardActivity.count({ where: { giftCardId: { in: venta.giftCardIds }, type: 'DEACTIVATE' } })).toBe(2)
  })

  it('🔴 nota 4: el MISMO reembolso dos veces A LA VEZ sobre un cobro de DOS sobres regresa el saldo una sola vez', async () => {
    const venta = await sembrarVentaDeTarjetas({ venueId, organizationId, staffId, montos: [100, 100], metodo: 'CASH' })
    const canje = await sembrarCanje({ venueId, staffId, giftCardIds: venta.giftCardIds, total: 200, conSaldo: 200 })
    expect(await prisma.giftCardActivity.count({ where: { paymentId: canje.pagoConSaldo.id, type: 'REDEEM' } })).toBe(2)
    const refundPaymentId = cuid()
    const entrada = {
      venueId,
      originalPaymentId: canje.pagoConSaldo.id,
      refundPaymentId,
      amount: new Prisma.Decimal(100),
      staffId,
    }
    const espera = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
    // El primero escribe su reverso y SOSTIENE el candado sin confirmar; el segundo pasa la primera lectura (vacía) y espera.
    const primero = prisma.$transaction(
      async tx => {
        const hecho = await revertirCanjeEnTx(tx, entrada)
        await espera(1500)
        return hecho
      },
      { timeout: 20_000, maxWait: 5_000 },
    )
    await espera(300)
    const segundo = prisma.$transaction(tx => revertirCanjeEnTx(tx, entrada), { timeout: 20_000, maxWait: 5_000 })
    const [a, b] = await Promise.all([primero, segundo])

    const comoTexto = (filas: Array<{ giftCardId: string; amount: Prisma.Decimal }>) =>
      filas.map(f => `${f.giftCardId}:${f.amount.toFixed(2)}`)
    expect(comoTexto(b)).toEqual(comoTexto(a))
    expect(await prisma.giftCardActivity.count({ where: { refundPaymentId, type: 'REDEEM_REVERSAL' } })).toBe(1)
    const sobres = await prisma.giftCard.findMany({ where: { id: { in: venta.giftCardIds } }, take: 2 })
    const saldoTotal = sobres.reduce((suma, s) => suma.plus(s.balance), new Prisma.Decimal(0))
    expect(saldoTotal.toFixed(2)).toBe('100.00')
  })
})

/**
 * B1 · reembolsos con tarjetas de regalo contra Postgres real (spec §5.5; índice R2 y Review Focus 2). Más las notas del
 * coordinador: (1) nunca saldo a un sobre DEACTIVATED, (2) nunca dinero atrapado en una venta pagada con todo desactivado,
 * (4) el mismo reembolso dos veces a la vez regresa el saldo una sola vez. Ronda 1: la venta SIN pagar se devuelve abono por abono y
 * la devolución que la deja en $0 la cancela (fix 1); un sobre muerto ya devuelto no atrapa la parte de otro vivo (fix 2); el saldo
 * nunca sale del cajón y la propina regresa con la venta (fix 6). Los `PaymentEffect` del negocio se limpian al final (fix 7).
 *
 * Correr: source ../urls-tarjetas.sh && TZ=UTC npx jest --selectProjects=integration --runInBand \
 *   --runTestsByPath tests/integration/giftCards/reembolsos.integration.test.ts
 */
jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: jest.fn(() => null) } }))
jest.mock('@/services/tpv/digitalReceipt.tpv.service', () => ({ generateDigitalReceipt: jest.fn().mockResolvedValue(null) }))
jest.mock('@/services/wallet/notifyPassUpdated.service', () => ({
  notifyCustomerPassUpdated: jest.fn().mockResolvedValue({ notified: 0 }),
}))
// El aviso a las pantallas de una cuenta cancelada, contado (r2, fix 2). El resto del guardia (cobro de terminal vivo) es el REAL.
jest.mock('@/services/shared/orderCancelGuard', () => ({
  ...jest.requireActual('@/services/shared/orderCancelGuard'),
  avisarOrdenCancelada: jest.fn().mockResolvedValue(undefined),
}))
// El cajón REAL, espiado: la prueba lee qué respondió por cada reembolso (fix 6a).
jest.mock('@/services/shared/cashDrawerPosting', () => {
  const real = jest.requireActual('@/services/shared/cashDrawerPosting')
  return { ...real, postCashRefundToDrawer: jest.fn((...a: unknown[]) => real.postCashRefundToDrawer(...a)) }
})

import { Prisma } from '@prisma/client'
import cuid from 'cuid'
import prisma from '@/utils/prismaClient'
import { issueRefund } from '@/services/dashboard/refund.dashboard.service'
import { recordRefund } from '@/services/tpv/refund.tpv.service'
import { activarSobresDeCuentaPagadaEnTx, revertirCanjeEnTx } from '@/services/giftCards/giftCardLedger'
import { ORDER_LOCK_WAIT_BUDGET, lockExistingOrderForPayment } from '@/services/shared/paymentShiftClaim'
import { postCashRefundToDrawer } from '@/services/shared/cashDrawerPosting'
import { payCashOrder } from '@/services/mobile/order.mobile.service'
// `integration-setup.ts` mockea la bitácora (fire-and-forget): se comprueba la llamada.
import { logAction } from '@/services/dashboard/activity-log.service'
import { avisarOrdenCancelada } from '@/services/shared/orderCancelGuard'
import {
  crearNegocioDePrueba,
  esperarAQueAlguienEspereA,
  limpiarEfectosDePagoDelNegocio,
  pidDe,
  sembrarCanje,
  sembrarVentaDeTarjetas,
  sembrarVentaDeTarjetasSinPagar,
} from './sembrarTarjetasDeRegalo'

jest.setTimeout(60000)

describe('B1 · reembolsos con tarjetas de regalo', () => {
  let venueId: string
  let staffId: string
  let organizationId: string

  // Negocio propio con nombre único y SIN limpieza (la libreta es de sólo inserción): ver la cabecera de la siembra.
  beforeAll(async () => {
    ;({ venueId, staffId, organizationId } = await crearNegocioDePrueba('b1-reembolsos'))
  })

  // Fix 7: los efectos que encolaron ESTOS cobros y reembolsos no se quedan para el worker de otra suite. La libreta no se toca.
  afterAll(async () => {
    await limpiarEfectosDePagoDelNegocio(venueId)
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
    // El primero escribe su reverso y SOSTIENE el candado sin confirmar; el segundo pasa la primera lectura (vacía) y espera.
    // r1 (M1): el primero no confirma hasta que el segundo esté DETENIDO en su candado (`pg_blocking_pids`), no por tiempo: así la
    // prueba siempre ejerce la carrera que cubre la segunda lectura bajo candado.
    let avisarQueTieneElCandado!: () => void
    const primeroTieneElCandado = new Promise<void>(resolve => (avisarQueTieneElCandado = resolve))
    const primero = prisma.$transaction(
      async tx => {
        const hecho = await revertirCanjeEnTx(tx, entrada)
        avisarQueTieneElCandado()
        await esperarAQueAlguienEspereA(await pidDe(tx))
        return hecho
      },
      { timeout: 20_000, maxWait: 5_000 },
    )
    await primeroTieneElCandado
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

  describe('r1 · fix 1: una venta de tarjetas SIN pagar tiene salida', () => {
    const ordenDe = (orderId: string) => prisma.order.findUniqueOrThrow({ where: { id: orderId } })
    const sobresDe = (ids: string[]) =>
      prisma.giftCard.findMany({ where: { id: { in: ids } }, select: { status: true, balance: true }, take: ids.length })
    const anomaliaDeActivacion = (orderId: string) =>
      prisma.moneyAnomaly.findFirst({ where: { stripeEventId: `giftcard:ACTIVATION_AMOUNT_MISMATCH:${orderId}` } })
    const cancelacionesEnBitacora = (orderId: string) =>
      (logAction as jest.Mock).mock.calls.filter(([a]) => a.action === 'ORDER_CANCELLED' && a.entityId === orderId).map(([a]) => a)
    const avisosDeCancelacion = (orderId: string) => (avisarOrdenCancelada as jest.Mock).mock.calls.filter(([, id]) => id === orderId)

    it('🔴 (b) venta de $500 con un abono de $200 en efectivo: devolver los $200 desde el panel ⇒ 1 REFUND, la cuenta CANCELLED y sus sobres DEACTIVATED', async () => {
      const venta = await sembrarVentaDeTarjetasSinPagar({ venueId, organizationId, staffId, montos: [500], abonosEnEfectivo: [200] })
      expect((await ordenDe(venta.orderId)).paymentStatus).toBe('PARTIAL')

      const r = await issueRefund({ venueId, paymentId: venta.abonos[0].id, amount: 20000, reason: 'CANCELLED_ORDER', staffId })

      expect(await refundsDe(venta.orderId)).toBe(1)
      expect((await ordenDe(venta.orderId)).status).toBe('CANCELLED')
      const sobres = await sobresDe(venta.giftCardIds)
      expect(sobres.map(x => [x.status, x.balance.toFixed(2)])).toEqual([['DEACTIVATED', '0.00']])
      expect(await prisma.giftCardActivity.count({ where: { giftCardId: venta.giftCardIds[0], type: 'ACTIVATE' } })).toBe(0)
      expect(
        await prisma.giftCardActivity.count({ where: { giftCardId: venta.giftCardIds[0], type: 'DEACTIVATE', reason: 'SALE_CANCELLED' } }),
      ).toBe(1)
      // Ya no es anomalía: es la salida normal de una venta sin pagar.
      expect(await prisma.moneyAnomaly.count({ where: { stripeEventId: `giftcard:REFUND_WITHOUT_CANCEL:${r.refundId}` } })).toBe(0)
      // Como `deleteOrder`: bitácora ORDER_CANCELLED después del commit (una sola).
      expect(cancelacionesEnBitacora(venta.orderId)).toEqual([
        expect.objectContaining({ staffId, venueId, entity: 'Order', data: expect.objectContaining({ refundPaymentId: r.refundId }) }),
      ])
      expect(avisosDeCancelacion(venta.orderId)).toEqual([[venueId, venta.orderId, 'CANCELLED']])
    })

    it('🔴 (c) dos abonos de $100: el primer reembolso deja la cuenta PARTIAL con sus sobres PENDING; el segundo la cierra', async () => {
      const venta = await sembrarVentaDeTarjetasSinPagar({ venueId, organizationId, staffId, montos: [500], abonosEnEfectivo: [100, 100] })
      expect(venta.abonos).toHaveLength(2)

      await issueRefund({ venueId, paymentId: venta.abonos[0].id, amount: 10000, reason: 'CANCELLED_ORDER', staffId })
      const aMedias = await ordenDe(venta.orderId)
      expect([aMedias.status === 'CANCELLED', aMedias.paymentStatus]).toEqual([false, 'PARTIAL'])
      expect((await sobresDe(venta.giftCardIds)).map(x => x.status)).toEqual(['PENDING'])
      expect(cancelacionesEnBitacora(venta.orderId)).toEqual([])

      await issueRefund({ venueId, paymentId: venta.abonos[1].id, amount: 10000, reason: 'CANCELLED_ORDER', staffId })
      expect(await refundsDe(venta.orderId)).toBe(2)
      expect((await ordenDe(venta.orderId)).status).toBe('CANCELLED')
      expect((await sobresDe(venta.giftCardIds)).map(x => x.status)).toEqual(['DEACTIVATED'])
    })

    it('🔴 (d) $500 con abono de $200, se devuelven $100 y luego se paga el resto ($300): la activación se NIEGA (DINERO_DEVUELTO), sobres PENDING y anomalía', async () => {
      const venta = await sembrarVentaDeTarjetasSinPagar({ venueId, organizationId, staffId, montos: [500], abonosEnEfectivo: [200] })
      await issueRefund({ venueId, paymentId: venta.abonos[0].id, amount: 10000, reason: 'RETURNED_GOODS', staffId })
      expect((await ordenDe(venta.orderId)).status).not.toBe('CANCELLED')

      await payCashOrder(venueId, venta.orderId, { amount: 30000, tip: 0, staffId, idempotencyKey: `b1r1-resto-${venta.orderId}` })

      expect((await ordenDe(venta.orderId)).paymentStatus).toBe('PAID')
      expect((await sobresDe(venta.giftCardIds)).map(x => [x.status, x.balance.toFixed(2)])).toEqual([['PENDING', '0.00']])
      expect(await prisma.giftCardActivity.count({ where: { giftCardId: venta.giftCardIds[0], type: 'ACTIVATE' } })).toBe(0)
      expect((await anomaliaDeActivacion(venta.orderId))?.observedState).toMatchObject({
        motivo: 'DINERO_DEVUELTO',
        cobrado: '500.00',
        reembolsado: '100.00',
        esperado: '500.00',
      })
    })

    it('(d) variante: se devuelven $100 y se paga DE MÁS ($400 con terminal externa): lo cobrado no cuadra ⇒ COBRADO_DISTINTO, sin activar', async () => {
      const venta = await sembrarVentaDeTarjetasSinPagar({ venueId, organizationId, staffId, montos: [500], abonosEnEfectivo: [200] })
      await issueRefund({ venueId, paymentId: venta.abonos[0].id, amount: 10000, reason: 'RETURNED_GOODS', staffId })

      await payCashOrder(venueId, venta.orderId, {
        amount: 40000,
        tip: 0,
        staffId,
        idempotencyKey: `b1r1-de-mas-${venta.orderId}`,
        method: 'CREDIT_CARD',
        externalSource: 'Terminal externa',
      })

      expect((await sobresDe(venta.giftCardIds)).map(x => x.status)).toEqual(['PENDING'])
      expect((await anomaliaDeActivacion(venta.orderId))?.observedState).toMatchObject({
        motivo: 'COBRADO_DISTINTO',
        cobrado: '600.00',
        reembolsado: '100.00',
        esperado: '500.00',
      })
    })

    it('(e) carrera con el cobro que completa la cuenta, orden «cobro primero»: la venta ya está PAGADA ⇒ GIFT_CARD_CANCEL_NOT_STARTED (es el flujo de B2), sin REFUND', async () => {
      // Los dos toman el candado de la Order: se serializan. «Reembolso primero» es el caso (d): F8 niega la activación.
      const venta = await sembrarVentaDeTarjetasSinPagar({ venueId, organizationId, staffId, montos: [500], abonosEnEfectivo: [200] })
      await payCashOrder(venueId, venta.orderId, { amount: 30000, tip: 0, staffId, idempotencyKey: `b1r1-completa-${venta.orderId}` })
      expect((await sobresDe(venta.giftCardIds)).map(x => x.status)).toEqual(['ACTIVE'])

      await expect(
        issueRefund({ venueId, paymentId: venta.abonos[0].id, amount: 20000, reason: 'CANCELLED_ORDER', staffId }),
      ).rejects.toMatchObject({ code: 'GIFT_CARD_CANCEL_NOT_STARTED' })
      expect(await refundsDe(venta.orderId)).toBe(0)
      expect((await sobresDe(venta.giftCardIds)).map(x => x.status)).toEqual(['ACTIVE'])
    })

    it('🔴 r2 · fix 1: la cuenta del caso (d) —PAGADA con sus sobres PENDING porque F8 negó la activación— se devuelve cobro por cobro y en $0 se cierra', async () => {
      const venta = await sembrarVentaDeTarjetasSinPagar({ venueId, organizationId, staffId, montos: [500], abonosEnEfectivo: [200] })
      await issueRefund({ venueId, paymentId: venta.abonos[0].id, amount: 10000, reason: 'RETURNED_GOODS', staffId })
      await payCashOrder(venueId, venta.orderId, { amount: 30000, tip: 0, staffId, idempotencyKey: `b1r2-resto-${venta.orderId}` })
      expect((await ordenDe(venta.orderId)).paymentStatus).toBe('PAID')
      expect((await sobresDe(venta.giftCardIds)).map(x => x.status)).toEqual(['PENDING'])
      const cobros = await prisma.payment.findMany({
        where: { venueId, orderId: venta.orderId, status: 'COMPLETED', type: { not: 'REFUND' } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: 5,
      })
      expect(cobros.map(c => c.amount.toFixed(2))).toEqual(['200.00', '300.00'])

      // Lo que queda del abono ($100): todavía hay dinero, la cuenta sigue abierta y nada se cancela.
      await issueRefund({ venueId, paymentId: cobros[0].id, amount: 10000, reason: 'RETURNED_GOODS', staffId })
      expect((await ordenDe(venta.orderId)).status).not.toBe('CANCELLED')
      expect((await sobresDe(venta.giftCardIds)).map(x => x.status)).toEqual(['PENDING'])
      expect(cancelacionesEnBitacora(venta.orderId)).toEqual([])

      // El cobro que la completó ($300): $0 ⇒ la misma transacción la cancela y apaga sus sobres en $0.
      const ultimo = await issueRefund({ venueId, paymentId: cobros[1].id, amount: 30000, reason: 'RETURNED_GOODS', staffId })
      expect(await refundsDe(venta.orderId)).toBe(3)
      expect((await ordenDe(venta.orderId)).status).toBe('CANCELLED')
      expect((await sobresDe(venta.giftCardIds)).map(x => [x.status, x.balance.toFixed(2)])).toEqual([['DEACTIVATED', '0.00']])
      expect(await prisma.giftCardActivity.count({ where: { giftCardId: venta.giftCardIds[0], type: 'ACTIVATE' } })).toBe(0)
      expect(cancelacionesEnBitacora(venta.orderId)).toEqual([
        expect.objectContaining({ data: expect.objectContaining({ refundPaymentId: ultimo.refundId }) }),
      ])
      expect(avisosDeCancelacion(venta.orderId)).toHaveLength(1)
    })

    it('🔴 r2 · fix 2: por la TERMINAL (recordRefund) una venta sin pagar se devuelve hasta $0 y se cierra: CANCELLED, sobres DEACTIVATED, un aviso y una bitácora', async () => {
      const venta = await sembrarVentaDeTarjetasSinPagar({ venueId, organizationId, staffId, montos: [500], abonosConTerminal: [200] })
      expect((await ordenDe(venta.orderId)).paymentStatus).toBe('PARTIAL')

      const r = await terminalDevuelveLaVenta(venta.abonos[0].id, 20000, 'gc-r2-terminal')

      expect(await refundsDe(venta.orderId)).toBe(1)
      expect((await ordenDe(venta.orderId)).status).toBe('CANCELLED')
      expect((await sobresDe(venta.giftCardIds)).map(x => [x.status, x.balance.toFixed(2)])).toEqual([['DEACTIVATED', '0.00']])
      expect(avisosDeCancelacion(venta.orderId)).toEqual([[venueId, venta.orderId, 'CANCELLED']])
      expect(cancelacionesEnBitacora(venta.orderId)).toEqual([
        expect.objectContaining({ staffId, venueId, entity: 'Order', data: expect.objectContaining({ refundPaymentId: r.id }) }),
      ])
      // Una venta sin pagar devuelta no es anomalía (r1).
      expect(await prisma.moneyAnomaly.count({ where: { stripeEventId: `giftcard:REFUND_WITHOUT_CANCEL:${r.id}` } })).toBe(0)
    })
  })

  it('🔴 r1 · fix 2: un sobre DEACTIVATED que ya se devolvió completo no atrapa la parte del sobre VIVO del mismo cobro', async () => {
    const ventaA = await sembrarVentaDeTarjetas({ venueId, organizationId, staffId, montos: [100], metodo: 'CREDIT_CARD' })
    const ventaB = await sembrarVentaDeTarjetas({ venueId, organizationId, staffId, montos: [100], metodo: 'CREDIT_CARD' })
    const canje = await sembrarCanje({
      venueId,
      staffId,
      giftCardIds: [ventaA.giftCardIds[0], ventaB.giftCardIds[0]],
      total: 200,
      conSaldo: 200,
    })
    expect(await prisma.giftCardActivity.count({ where: { paymentId: canje.pagoConSaldo.id, type: 'REDEEM' } })).toBe(2)
    // Primer reembolso: regresa al sobre del primer canje.
    const r1 = await issueRefund({ venueId, paymentId: canje.pagoConSaldo.id, amount: 10000, reason: 'RETURNED_GOODS', staffId })
    const yaDevuelto = (await prisma.giftCardActivity.findFirstOrThrow({ where: { refundPaymentId: r1.refundId } })).giftCardId
    const [ventaDelMuerto, vivo] = yaDevuelto === ventaA.giftCardIds[0] ? [ventaA, ventaB.giftCardIds[0]] : [ventaB, ventaA.giftCardIds[0]]
    // La terminal devuelve la venta de ESE sobre (E1): muere con su saldo. Ya no le queda nada por regresar de este cobro.
    await terminalDevuelveLaVenta(ventaDelMuerto.pagos[0].id, 10000, 'gc-fix2')
    expect((await prisma.giftCard.findUniqueOrThrow({ where: { id: yaDevuelto } })).status).toBe('DEACTIVATED')

    // Segundo reembolso: lo que queda es del sobre VIVO. Antes el pre-candado rechazaba por el muerto y esa parte quedaba atrapada.
    const r2 = await issueRefund({ venueId, paymentId: canje.pagoConSaldo.id, amount: 10000, reason: 'RETURNED_GOODS', staffId })

    const reverso = await prisma.giftCardActivity.findFirstOrThrow({ where: { refundPaymentId: r2.refundId } })
    expect([reverso.type, reverso.giftCardId, reverso.amount.toFixed(2)]).toEqual(['REDEEM_REVERSAL', vivo, '100.00'])
    expect((await prisma.giftCard.findUniqueOrThrow({ where: { id: vivo } })).balance.toFixed(2)).toBe('100.00')
    expect((await prisma.giftCard.findUniqueOrThrow({ where: { id: yaDevuelto } })).balance.toFixed(2)).toBe('0.00')
  })

  describe('r1 · fix 6: el dinero del saldo', () => {
    const respuestaDelCajon = async (refundPaymentId: string) => {
      const mock = postCashRefundToDrawer as jest.Mock
      const i = mock.mock.calls.findIndex(([posting]) => (posting as { refundPaymentId: string }).refundPaymentId === refundPaymentId)
      expect(i).toBeGreaterThanOrEqual(0)
      return mock.mock.results[i].value
    }

    it('🔴 (a) devolver un cobro con saldo NO saca efectivo del cajón: el cajón responde NOT_DRAWER_CASH (un efectivo, en contraste, sí lo intenta)', async () => {
      const venta = await sembrarVentaDeTarjetas({ venueId, organizationId, staffId, montos: [500], metodo: 'CASH' })
      const canje = await sembrarCanje({
        venueId,
        staffId,
        giftCardIds: venta.giftCardIds,
        total: 300,
        conSaldo: 200,
        restoEnEfectivo: 100,
      })

      const conSaldo = await issueRefund({ venueId, paymentId: canje.pagoConSaldo.id, amount: 20000, reason: 'RETURNED_GOODS', staffId })
      const enEfectivo = await issueRefund({
        venueId,
        paymentId: canje.pagoEnEfectivo!.id,
        amount: 10000,
        reason: 'RETURNED_GOODS',
        staffId,
      })

      await expect(respuestaDelCajon(conSaldo.refundId)).resolves.toBe('NOT_DRAWER_CASH')
      // Sin cajón abierto en esta prueba, el efectivo responde NO_OPEN_DRAWER: prueba que la pregunta sí distingue.
      await expect(respuestaDelCajon(enEfectivo.refundId)).resolves.not.toBe('NOT_DRAWER_CASH')
      expect(await prisma.cashDrawerEvent.count({ where: { venueId, type: 'PAY_OUT' } })).toBe(0)
    })

    it('🔴 (b) un cobro con saldo CON propina se devuelve completo: el reverso regresa venta + propina, lo mismo que descontó el REDEEM de A8', async () => {
      const venta = await sembrarVentaDeTarjetas({ venueId, organizationId, staffId, montos: [500], metodo: 'CASH' })
      const canje = await sembrarCanje({ venueId, staffId, giftCardIds: venta.giftCardIds, total: 200, conSaldo: 200, propina: 20 })
      const canjeado = await prisma.giftCardActivity.findFirstOrThrow({ where: { paymentId: canje.pagoConSaldo.id, type: 'REDEEM' } })
      expect(canjeado.amount.toFixed(2)).toBe('220.00')

      const r = await issueRefund({ venueId, paymentId: canje.pagoConSaldo.id, amount: 22000, reason: 'RETURNED_GOODS', staffId })

      const fila = await prisma.payment.findUniqueOrThrow({ where: { id: r.refundId } })
      expect(fila.amount.plus(fila.tipAmount).toFixed(2)).toBe('-220.00')
      const reverso = await prisma.giftCardActivity.findFirstOrThrow({ where: { refundPaymentId: r.refundId } })
      expect([reverso.type, reverso.amount.toFixed(2), reverso.reversesActivityId]).toEqual(['REDEEM_REVERSAL', '220.00', canjeado.id])
      expect((await prisma.giftCard.findUniqueOrThrow({ where: { id: venta.giftCardIds[0] } })).balance.toFixed(2)).toBe('500.00')
    })
  })
})

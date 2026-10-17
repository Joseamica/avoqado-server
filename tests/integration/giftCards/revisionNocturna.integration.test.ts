/**
 * B7 · las consultas de la revisión nocturna, contra Postgres real: que corran, que encuentren lo sembrado y que la activación nocturna
 * use la función del cobro. Las aserciones miran SÓLO lo sembrado aquí (la base desechable trae filas de otras pruebas: la noche
 * las recorre también).
 * r1 B-1 (F8): la secuencia completa con los servicios REALES —abono, devolución, abono final, noche— no activa saldo por dinero que
 * ya se devolvió. Notas del coordinador: dinero conservado sin sobres vivos ⇒ `PAID_WITH_DEACTIVATED` (la llave de A6); cuenta en $0
 * abierta con sobres PENDING ⇒ `OPEN_AT_ZERO_WITH_PENDING`; una cuenta pagada con PENDING + DEACTIVATED no se activa.
 * B7 r1: lo que un sobre desactivado alcanzó a canjear SÍ respalda lo conservado (#1, el caso E1, en la noche y en el cobro de A6);
 * las notas 1-2 sólo miran cuentas que se movieron en 7 días (M1); REFUND_WITHOUT_REVERSAL y CANCEL_STUCK encuentran lo sembrado (M5).
 *
 * Correr: source ../urls-tarjetas.sh && TZ=UTC npx jest --selectProjects=integration --runInBand \
 *   --runTestsByPath tests/integration/giftCards/revisionNocturna.integration.test.ts
 */
jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: jest.fn(() => null) } }))
jest.mock('@/services/tpv/digitalReceipt.tpv.service', () => ({ generateDigitalReceipt: jest.fn().mockResolvedValue(null) }))
jest.mock('@/services/wallet/notifyPassUpdated.service', () => ({
  notifyCustomerPassUpdated: jest.fn().mockResolvedValue({ notified: 0 }),
}))
jest.mock('@/services/shared/orderCancelGuard', () => ({
  ...jest.requireActual('@/services/shared/orderCancelGuard'),
  avisarOrdenCancelada: jest.fn().mockResolvedValue(undefined),
}))

import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { GiftCardReconciliationJob } from '@/jobs/giftCardReconciliation.job'
import { issueRefund } from '@/services/dashboard/refund.dashboard.service'
import { payCashOrder } from '@/services/mobile/order.mobile.service'
import { recordRefund } from '@/services/tpv/refund.tpv.service'
import { activarSobresDeCuentaPagadaEnTx, desactivarSobresPendientesDeCuentaEnTx } from '@/services/giftCards/giftCardLedger'
import { ensureGiftCardTender } from '@/services/giftCards/giftCardTender'
import { ORDER_LOCK_WAIT_BUDGET, lockExistingOrderForPayment } from '@/services/shared/paymentShiftClaim'
import {
  crearCobroConSaldoEnTx,
  crearCuentaDeMercancia,
  crearNegocioDePrueba,
  limpiarEfectosDePagoDelNegocio,
  sembrarCanje,
  sembrarVentaDeTarjetas,
  sembrarVentaDeTarjetasSinPagar,
} from './sembrarTarjetasDeRegalo'

jest.setTimeout(120000)

const D = (pesos: number) => new Prisma.Decimal(pesos)
const noopCron = { start: jest.fn(), stop: jest.fn() }
const noche = () => new GiftCardReconciliationJob({ cron: noopCron }).runNow()
const anomalia = (check: string, id: string) => prisma.moneyAnomaly.count({ where: { stripeEventId: `giftcard:${check}:${id}` } })
const observado = async (check: string, id: string) =>
  (await prisma.moneyAnomaly.findFirst({ where: { stripeEventId: `giftcard:${check}:${id}` } }))?.observedState
/** Todas las anomalías de tarjetas con este id, de cualquier check. */
const anomaliasDe = (id: string) =>
  prisma.moneyAnomaly.findMany({ where: { stripeEventId: { startsWith: 'giftcard:', endsWith: `:${id}` } }, take: 10 })
const estados = async (ids: string[]) =>
  (await prisma.giftCard.findMany({ where: { id: { in: ids } }, orderBy: { id: 'asc' }, select: { status: true }, take: ids.length })).map(
    s => s.status,
  )
/** Lo que la ventana de la noche ve como «sin movimiento»: los pagos de la cuenta, dos días atrás. */
const envejecerPagos = (orderId: string) =>
  prisma.$executeRaw`UPDATE "Payment" SET "createdAt" = "createdAt" - interval '2 days', "updatedAt" = "updatedAt" - interval '2 days' WHERE "orderId" = ${orderId}`
/** r1 M1: todo lo que la ventana mira de una cuenta (pagos, desactivación de sus sobres y la Order), ocho días atrás. */
const envejecerOchoDias = async (orderId: string) => {
  await prisma.$executeRaw`UPDATE "Payment" SET "createdAt" = "createdAt" - interval '8 days', "updatedAt" = "updatedAt" - interval '8 days' WHERE "orderId" = ${orderId}`
  await prisma.$executeRaw`UPDATE "GiftCard" SET "deactivatedAt" = "deactivatedAt" - interval '8 days' WHERE id IN (SELECT "giftCardId" FROM "OrderItem" WHERE "orderId" = ${orderId} AND "giftCardId" IS NOT NULL)`
  await prisma.$executeRaw`UPDATE "Order" SET "updatedAt" = "updatedAt" - interval '8 days' WHERE id = ${orderId}`
}

describe('B7 · revisión nocturna', () => {
  let venueId: string
  let staffId: string
  let organizationId: string

  // Negocio propio con nombre único y SIN limpieza de la libreta (sólo inserción): ver la cabecera de la siembra.
  beforeAll(async () => {
    ;({ venueId, staffId, organizationId } = await crearNegocioDePrueba('b7-noche'))
  })

  afterAll(async () => {
    await limpiarEfectosDePagoDelNegocio(venueId)
  })

  /** Un pago en efectivo registrado directo (sin el camino del cobro, que activaría): lo que la red nocturna existe para atrapar. */
  const pagoDirecto = (orderId: string, pesos: number, extra: Partial<Prisma.PaymentUncheckedCreateInput> = {}) =>
    prisma.payment.create({
      data: {
        venueId,
        orderId,
        amount: D(pesos),
        tipAmount: D(0),
        netAmount: D(pesos),
        feePercentage: 0,
        feeAmount: D(0),
        method: 'CASH',
        status: 'COMPLETED',
        type: 'REGULAR',
        splitType: 'CUSTOMAMOUNT',
        source: 'POS',
        fundsFlow: 'CASH_DRAWER',
        processedById: staffId,
        ...extra,
      },
    })

  /** Una cuenta PAGADA cuyos sobres siguen PENDING (pagada por un camino que no activó) y pasada la gracia de 10 minutos. */
  const cuentaPagadaSinActivar = async (montos: number[]) => {
    const venta = await sembrarVentaDeTarjetasSinPagar({ venueId, organizationId, staffId, montos })
    const total = montos.reduce((s, m) => s + m, 0)
    await prisma.order.update({
      where: { id: venta.orderId },
      data: { status: 'COMPLETED', paymentStatus: 'PAID', paidAmount: D(total), remainingBalance: D(0), completedAt: new Date() },
    })
    await pagoDirecto(venta.orderId, total)
    await prisma.$executeRaw`UPDATE "Order" SET "updatedAt" = "updatedAt" - interval '1 hour' WHERE id = ${venta.orderId}`
    return venta
  }

  /** Lo que deja el caso de B1: el reembolso llevó la cuenta a $0 pero no la cerró (había un cobro de terminal vivo que falló). */
  const enCeroSinCerrar = async (montos: number[]) => {
    const venta = await sembrarVentaDeTarjetasSinPagar({ venueId, organizationId, staffId, montos, abonosEnEfectivo: [200] })
    await pagoDirecto(venta.orderId, -200, {
      type: 'REFUND',
      splitType: 'FULLPAYMENT',
      netAmount: D(-200),
      processorData: { originalPaymentId: venta.abonos[0].id },
    })
    return venta
  }

  /** Venta sin pagar con abono de $200 devuelto completo por el panel (se cancela, B1 r1) y un cobro tardío de `tardio` que nadie devolvió. */
  const canceladaConDineroTardio = async (tardio: number) => {
    const venta = await sembrarVentaDeTarjetasSinPagar({ venueId, organizationId, staffId, montos: [500], abonosEnEfectivo: [200] })
    await issueRefund({ venueId, paymentId: venta.abonos[0].id, amount: 20000, reason: 'CANCELLED_ORDER', staffId })
    expect((await prisma.order.findUniqueOrThrow({ where: { id: venta.orderId } })).status).toBe('CANCELLED')
    await pagoDirecto(venta.orderId, tardio)
    return venta
  }

  it('🔴 Review Focus 3: una cuenta PAGADA con sobres PENDING se activa de noche y deja PAID_WITH_PENDING', async () => {
    const venta = await cuentaPagadaSinActivar([500])

    await noche()

    const despues = await prisma.giftCard.findUniqueOrThrow({ where: { id: venta.giftCardIds[0] } })
    expect([despues.status, despues.balance.toFixed(2)]).toEqual(['ACTIVE', '500.00'])
    expect(await prisma.giftCardActivity.count({ where: { giftCardId: venta.giftCardIds[0], type: 'ACTIVATE' } })).toBe(1)
    expect(await anomalia('PAID_WITH_PENDING', venta.orderId)).toBe(1)
  })

  it('⭐ (B7 r1) una cuenta CANCELADA aunque diga PAGADA, con sobres PENDING, no se activa de noche ni deja PAID_WITH_PENDING', async () => {
    const venta = await cuentaPagadaSinActivar([300])
    await prisma.$executeRaw`UPDATE "Order" SET status = 'CANCELLED', "updatedAt" = "updatedAt" - interval '1 hour' WHERE id = ${venta.orderId}`

    await noche()

    expect(await estados(venta.giftCardIds)).toEqual(['PENDING'])
    expect(await prisma.giftCardActivity.count({ where: { giftCardId: venta.giftCardIds[0], type: 'ACTIVATE' } })).toBe(0)
    expect(await anomalia('PAID_WITH_PENDING', venta.orderId)).toBe(0)
  })

  it('🔴 un cobro con saldo sin su REDEEM deja TENDER_WITHOUT_REDEEM', async () => {
    const { orderId } = await crearCuentaDeMercancia({ venueId, staffId, total: 100 })
    await ensureGiftCardTender(prisma, venueId)
    const pago = await prisma.$transaction(
      tx => crearCobroConSaldoEnTx(tx, { venueId, orderId, monto: 100, staffId }),
      ORDER_LOCK_WAIT_BUDGET,
    )
    await noche()
    expect(await anomalia('TENDER_WITHOUT_REDEEM', pago.id)).toBe(1)
  })

  it('🔴 un saldo que no cuadra con su libreta deja BALANCE_MISMATCH (y una segunda noche no lo duplica)', async () => {
    const venta = await sembrarVentaDeTarjetas({ venueId, organizationId, staffId, montos: [500], metodo: 'CASH' })
    await prisma.giftCard.update({ where: { id: venta.giftCardIds[0] }, data: { balance: D(999) } })
    const job = new GiftCardReconciliationJob({ cron: noopCron })
    await job.runNow()
    await job.runNow()
    expect(await anomalia('BALANCE_MISMATCH', venta.giftCardIds[0])).toBe(1)
    expect(await observado('BALANCE_MISMATCH', venta.giftCardIds[0])).toMatchObject({ balance: '999.00', libreta: '500.00' })
  })

  it('regresión: un sobre sano no deja anomalía de saldo', async () => {
    const venta = await sembrarVentaDeTarjetas({ venueId, organizationId, staffId, montos: [300], metodo: 'CASH' })
    await noche()
    expect(await anomalia('BALANCE_MISMATCH', venta.giftCardIds[0])).toBe(0)
  })

  it('🔴 r1 B-1 (F8): abono de $200, se devuelven $100, abono final de $300 ⇒ la cuenta queda PAGADA pero el sobre de $500 NO se activa, ni de noche', async () => {
    // Con los servicios REALES. (Devolver el abono COMPLETO ya no sirve aquí: desde B1 r1 una venta sin pagar que queda en $0 se
    // cancela en la misma transacción del reembolso.)
    const venta = await sembrarVentaDeTarjetasSinPagar({ venueId, organizationId, staffId, montos: [500], abonosEnEfectivo: [200] })
    await issueRefund({ venueId, paymentId: venta.abonos[0].id, amount: 10000, reason: 'RETURNED_GOODS', staffId })
    await payCashOrder(venueId, venta.orderId, { amount: 30000, tip: 0, staffId, idempotencyKey: `b7-f8-final-${venta.orderId}` })
    expect((await prisma.order.findUniqueOrThrow({ where: { id: venta.orderId } })).paymentStatus).toBe('PAID')
    const sigueSinActivar = async () => {
      const sobre = await prisma.giftCard.findUniqueOrThrow({ where: { id: venta.giftCardIds[0] } })
      expect([sobre.status, sobre.balance.toFixed(2)]).toEqual(['PENDING', '0.00'])
      expect(await prisma.giftCardActivity.count({ where: { giftCardId: venta.giftCardIds[0], type: 'ACTIVATE' } })).toBe(0)
    }
    await sigueSinActivar()
    expect(await observado('ACTIVATION_AMOUNT_MISMATCH', venta.orderId)).toMatchObject({ motivo: 'DINERO_DEVUELTO', esperado: '500.00' })

    // La noche (pasada la gracia de 10 min) encuentra la cuenta PAGADA con su sobre PENDING, intenta activarla con la MISMA función
    // y tampoco activa. `PAID_WITH_PENDING` sólo se escribe cuando la noche SÍ activa; lo que queda es la anomalía de la activación,
    // una sola fila aunque la noche lo reintente (`giftcard:<check>:<id>` deduplica, R6).
    await prisma.$executeRaw`UPDATE "Order" SET "updatedAt" = "updatedAt" - interval '1 hour' WHERE id = ${venta.orderId}`
    const r = await noche()
    expect(r.cuentasPagadasConPendientes).toBeGreaterThanOrEqual(1)
    await sigueSinActivar()
    expect(await anomalia('PAID_WITH_PENDING', venta.orderId)).toBe(0)
    expect(await anomalia('ACTIVATION_AMOUNT_MISMATCH', venta.orderId)).toBe(1)
    expect(await anomalia('OPEN_AT_ZERO_WITH_PENDING', venta.orderId)).toBe(0)
  })

  it('🔴 nota 3: una cuenta PAGADA con un sobre PENDING y otro DEACTIVATED no se activa: ningún sobre cambia y queda UNA sola anomalía', async () => {
    const venta = await cuentaPagadaSinActivar([500, 300])
    const [, muerto] = venta.giftCardIds
    await prisma.giftCard.update({ where: { id: muerto }, data: { status: 'DEACTIVATED', deactivatedAt: new Date() } })
    const antes = await estados(venta.giftCardIds)

    await noche()
    await noche()

    expect(await estados(venta.giftCardIds)).toEqual(antes)
    expect(await prisma.giftCardActivity.count({ where: { giftCardId: { in: venta.giftCardIds }, type: 'ACTIVATE' } })).toBe(0)
    const filas = await anomaliasDe(venta.orderId)
    expect(filas.map(f => f.category)).toEqual(['GIFT_CARD_PAID_WITH_DEACTIVATED'])
    expect(filas[0].observedState).toMatchObject({
      motivo: 'REVISION_NOCTURNA',
      cobrado: '800.00',
      reembolsado: '0.00',
      conservado: '800.00',
      respaldo: '500.00',
    })
  })

  describe('nota 1: dinero conservado sin sobres vivos que lo respalden ⇒ PAID_WITH_DEACTIVATED', () => {
    it('🔴 dinero tardío PARCIAL sobre una venta cancelada (queda PARTIAL, A6 no avisa): la noche lo avisa con la llave de A6 y no revive nada', async () => {
      // Abono de $200 devuelto completo (la venta se cancela y su sobre queda DEACTIVATED) y llega tarde un cobro de $150 que nadie
      // devolvió (una terminal que contestó después). El sobre nunca se activó ni canjeó: nada respalda esos $150.
      const venta = await canceladaConDineroTardio(150)

      const r = await noche()

      expect(r.cuentasCanceladasConDinero).toBeGreaterThanOrEqual(1)
      expect(await estados(venta.giftCardIds)).toEqual(['DEACTIVATED'])
      expect(await anomalia('PAID_WITH_DEACTIVATED', venta.orderId)).toBe(1)
      expect(await observado('PAID_WITH_DEACTIVATED', venta.orderId)).toEqual({
        motivo: 'REVISION_NOCTURNA',
        orderId: venta.orderId,
        cobrado: '350.00',
        reembolsado: '200.00',
        conservado: '150.00',
        canjeado: '0.00',
        respaldo: '0.00',
        sobres: [{ id: venta.giftCardIds[0], status: 'DEACTIVATED' }],
      })
    })

    it('🔴 r1 #1 (E1): tarjeta de $500, se gastan $300, la terminal devuelve $200 y la cuenta se desactiva entera ⇒ los $300 ya se entregaron: ni la noche ni el cobro (A6) avisan', async () => {
      const venta = await sembrarVentaDeTarjetas({ venueId, organizationId, staffId, montos: [500], metodo: 'CREDIT_CARD' })
      await sembrarCanje({ venueId, staffId, giftCardIds: venta.giftCardIds, total: 300, conSaldo: 300 })
      const devolucion = await recordRefund(
        venueId,
        {
          venueId,
          originalPaymentId: venta.pagos[0].id,
          amount: 20000,
          reason: 'CUSTOMER_REQUEST',
          authorizationNumber: 'AUT-B7-E1',
          referenceNumber: 'REF-B7-E1',
          isPartialRefund: true,
          currency: 'MXN',
          idempotencyKey: `tpv-b7-e1-${venta.orderId}`,
        },
        staffId,
      )
      expect(await estados(venta.giftCardIds)).toEqual(['DEACTIVATED'])
      expect(await anomalia('REFUND_WITHOUT_CANCEL', devolucion.id)).toBe(1)
      const otroCierre = () =>
        prisma.$transaction(async tx => {
          await lockExistingOrderForPayment(tx, { venueId, orderId: venta.orderId })
          await activarSobresDeCuentaPagadaEnTx(tx, { venueId, orderId: venta.orderId })
        }, ORDER_LOCK_WAIT_BUDGET)

      await noche()
      // A6: un cierre más de la cuenta PAGADA y sin PENDING (terminal, reconciliador) mide con la MISMA función.
      await otroCierre()
      expect(await anomalia('PAID_WITH_DEACTIVATED', venta.orderId)).toBe(0)

      // Y si encima llega un cobro de $100 que nadie devolvió, ESO sí queda sin respaldo: conservado $400 > canjeado $300.
      await pagoDirecto(venta.orderId, 100)
      await otroCierre()
      await noche()
      expect(await anomalia('PAID_WITH_DEACTIVATED', venta.orderId)).toBe(1)
      expect(await observado('PAID_WITH_DEACTIVATED', venta.orderId)).toMatchObject({
        motivo: 'COBRO_CON_SOBRES_DESACTIVADOS',
        cobrado: '600.00',
        reembolsado: '200.00',
        conservado: '400.00',
        canjeado: '300.00',
        respaldo: '300.00',
      })
    })

    it('🔴 r1 M1: una cuenta sin movimiento en los últimos 7 días no se vuelve a medir (notas 1 y 2)', async () => {
      const sinRespaldo = await canceladaConDineroTardio(150)
      const enCero = await enCeroSinCerrar([500])
      await envejecerOchoDias(sinRespaldo.orderId)
      await envejecerOchoDias(enCero.orderId)

      await noche()

      expect(await anomalia('PAID_WITH_DEACTIVATED', sinRespaldo.orderId)).toBe(0)
      expect(await anomalia('OPEN_AT_ZERO_WITH_PENDING', enCero.orderId)).toBe(0)
    })

    it('regresión: la venta cancelada con TODO devuelto, la cancelada que nunca recibió dinero y una cuenta de mercancía cancelada no avisan', async () => {
      const devuelta = await sembrarVentaDeTarjetasSinPagar({ venueId, organizationId, staffId, montos: [500], abonosEnEfectivo: [200] })
      await issueRefund({ venueId, paymentId: devuelta.abonos[0].id, amount: 20000, reason: 'CANCELLED_ORDER', staffId })

      const sinDinero = await sembrarVentaDeTarjetasSinPagar({ venueId, organizationId, staffId, montos: [300] })
      await prisma.$transaction(async tx => {
        await tx.order.update({ where: { id: sinDinero.orderId }, data: { status: 'CANCELLED' } })
        await desactivarSobresPendientesDeCuentaEnTx(tx, { venueId, orderId: sinDinero.orderId, staffId })
      })

      const mercancia = await crearCuentaDeMercancia({ venueId, staffId, total: 100 })
      await pagoDirecto(mercancia.orderId, 100)
      await prisma.order.update({ where: { id: mercancia.orderId }, data: { status: 'CANCELLED' } })

      await noche()

      for (const orderId of [devuelta.orderId, sinDinero.orderId, mercancia.orderId]) {
        expect({ orderId, filas: await anomalia('PAID_WITH_DEACTIVATED', orderId) }).toEqual({ orderId, filas: 0 })
      }
    })
  })

  describe('nota 2: cuenta en $0 que se quedó abierta con sobres PENDING ⇒ OPEN_AT_ZERO_WITH_PENDING', () => {
    it('🔴 sin movimiento en 24 h: la noche la avisa y no la cancela', async () => {
      const venta = await enCeroSinCerrar([500])
      await envejecerPagos(venta.orderId)

      const r = await noche()

      expect(r.cuentasEnCeroAbiertas).toBeGreaterThanOrEqual(1)
      expect(await observado('OPEN_AT_ZERO_WITH_PENDING', venta.orderId)).toEqual({
        motivo: 'REVISION_NOCTURNA',
        orderId: venta.orderId,
        cobrado: '200.00',
        reembolsado: '200.00',
        conservado: '0.00',
      })
      const orden = await prisma.order.findUniqueOrThrow({ where: { id: venta.orderId } })
      expect(orden.status).not.toBe('CANCELLED')
      expect(await estados(venta.giftCardIds)).toEqual(['PENDING'])
    })

    it('regresión: con movimiento reciente, sin dinero nunca recibido, cerrada con todo devuelto, o de mercancía ⇒ no avisa', async () => {
      const reciente = await enCeroSinCerrar([500])

      const sinDinero = await sembrarVentaDeTarjetasSinPagar({ venueId, organizationId, staffId, montos: [300] })

      const cerrada = await sembrarVentaDeTarjetasSinPagar({ venueId, organizationId, staffId, montos: [500], abonosEnEfectivo: [200] })
      await issueRefund({ venueId, paymentId: cerrada.abonos[0].id, amount: 20000, reason: 'CANCELLED_ORDER', staffId })
      await envejecerPagos(cerrada.orderId)

      const mercancia = await crearCuentaDeMercancia({ venueId, staffId, total: 100 })
      const cobro = await pagoDirecto(mercancia.orderId, 100)
      await pagoDirecto(mercancia.orderId, -100, {
        type: 'REFUND',
        splitType: 'FULLPAYMENT',
        netAmount: D(-100),
        processorData: { originalPaymentId: cobro.id },
      })
      await envejecerPagos(mercancia.orderId)

      await noche()

      for (const orderId of [reciente.orderId, sinDinero.orderId, cerrada.orderId, mercancia.orderId]) {
        expect({ orderId, filas: await anomalia('OPEN_AT_ZERO_WITH_PENDING', orderId) }).toEqual({ orderId, filas: 0 })
      }
    })
  })

  describe('r1 M5: los dos avisos de la conciliación encuentran lo sembrado', () => {
    it('🔴 un REFUND del tender de saldo sin su REDEEM_REVERSAL deja REFUND_WITHOUT_REVERSAL', async () => {
      const venta = await sembrarVentaDeTarjetas({ venueId, organizationId, staffId, montos: [500], metodo: 'CASH' })
      const { orderId, pagoConSaldo } = await sembrarCanje({ venueId, staffId, giftCardIds: venta.giftCardIds, total: 200, conSaldo: 200 })
      // La devolución quedó escrita con el tender de sistema pero su reverso al saldo no (lo que el gancho de B1 existe para impedir).
      const devolucion = await pagoDirecto(orderId, -200, {
        type: 'REFUND',
        splitType: 'FULLPAYMENT',
        netAmount: D(-200),
        method: 'OTHER',
        fundsFlow: 'EXTERNAL_RECORDED',
        tenderTypeId: pagoConSaldo.tenderTypeId,
        tenderRevision: pagoConSaldo.tenderRevision,
        tenderLabel: pagoConSaldo.tenderLabel,
        tenderCountsAsCash: pagoConSaldo.tenderCountsAsCash,
        tenderCaptureTip: pagoConSaldo.tenderCaptureTip,
        tenderSatFormaPago: pagoConSaldo.tenderSatFormaPago,
        processorData: { originalPaymentId: pagoConSaldo.id },
      })

      await noche()

      expect(await observado('REFUND_WITHOUT_REVERSAL', devolucion.id)).toEqual({ originalPaymentId: pagoConSaldo.id })
    })

    it('🔴 un sobre BLOCKED por CANCEL_IN_PROGRESS hace más de 24 h deja CANCEL_STUCK (el «incierto» del spec §5.6)', async () => {
      const venta = await sembrarVentaDeTarjetas({ venueId, organizationId, staffId, montos: [500], metodo: 'CASH' })
      const sobreId = venta.giftCardIds[0]
      const bloqueadoEn = new Date(Date.now() - 25 * 60 * 60 * 1000)
      await prisma.giftCard.update({ where: { id: sobreId }, data: { status: 'BLOCKED' } })
      await prisma.giftCardActivity.create({
        data: {
          giftCardId: sobreId,
          venueId,
          type: 'BLOCK',
          amount: D(0),
          balanceAfter: D(500),
          reason: 'CANCEL_IN_PROGRESS',
          orderId: venta.orderId,
          staffId,
          createdAt: bloqueadoEn,
        },
      })

      await noche()

      expect(await observado('CANCEL_STUCK', sobreId)).toEqual({ bloqueadoEn: bloqueadoEn.toISOString() })
    })
  })
})

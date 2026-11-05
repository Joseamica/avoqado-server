/**
 * D6 y D7 (5-nov-2026) contra Postgres real: al reembolsar, el cliente pierde los puntos que ganó con esa venta, y el bono por visita
 * se entrega. El reembolso (`issueRefund`, `recordRefund`) y el trabajador de efectos son los de verdad; sólo se simula el plan.
 * Promesa y mapa de entradas: docs/audit/2026-11-05-puntos-reembolso/promesa.md (workspace).
 *
 * Correr (sólo en una base DESECHABLE, nunca av-db-25): exporta TEST_DATABASE_URL hacia ella y luego
 *   TZ=UTC npx jest --selectProjects=integration --runTestsByPath tests/integration/customers/puntosAlReembolsar.integration.test.ts --runInBand --ci
 */
jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { broadcastToUser: jest.fn(), getBroadcastingService: jest.fn(() => null) },
}))
jest.mock('@/communication/sockets/managers/socketManager', () => {
  const sm = { getServer: jest.fn(), getBroadcastingService: jest.fn(() => null), broadcastToVenue: jest.fn() }
  return { __esModule: true, default: sm, socketManager: sm }
})
jest.mock('@/services/tpv/digitalReceipt.tpv.service', () => ({ generateDigitalReceipt: jest.fn().mockResolvedValue(null) }))
jest.mock('@/services/wallet/notifyPassUpdated.service', () => ({ notifyCustomerPassUpdated: jest.fn() }))
jest.mock('@/services/wallet/firstStampEmail.service', () => ({ sendFirstStampEmailIfDue: jest.fn() }))
jest.mock('@/services/access/basePlan.service', () => ({
  ...jest.requireActual('@/services/access/basePlan.service'),
  venueHasFeatureAccess: jest.fn().mockResolvedValue(true),
}))

import { Prisma } from '@prisma/client'
import cuid from 'cuid'
import prisma from '@/utils/prismaClient'
import { PaymentEffectsJob } from '@/jobs/payment-effects.job'
import { adjustPoints, earnPoints, getLoyaltyTransactions } from '@/services/dashboard/loyalty.dashboard.service'
import { issueRefund } from '@/services/dashboard/refund.dashboard.service'
import { recordRefund } from '@/services/tpv/refund.tpv.service'
import { createManualPayment } from '@/services/dashboard/manualPayment.service'
import { applyDeliveryRefund } from '@/services/delivery-channels/core/applyDeliveryRefund.service'
import * as puntosAlReembolsar from '@/services/shared/puntosAlReembolsar'
import { quitarPuntosPorReembolso } from '@/services/shared/puntosAlReembolsar'
import { abrirTurno, sembrarCobro } from '../dashboard/sembrarCobroParaReembolso'
import { crearNegocioDePrueba, esperarAQueAlguienEspereA, limpiarNegocioDePrueba, pidDe } from '../giftCards/sembrarTarjetasDeRegalo'

const KIND = 'LOYALTY_POINTS_REVERSAL'
let venueId: string
let staffId: string
let n = 0

const conPuntos = (pointsPerVisit = 0) => prisma.loyaltyConfig.update({ where: { venueId }, data: { pointsPerVisit } })

const cliente = async () => {
  const i = ++n
  return (await prisma.customer.create({ data: { venueId, firstName: `Cliente${i}`, phone: `+52556677${String(i).padStart(4, '0')}` } })).id
}

const saldo = async (customerId: string) => (await prisma.customer.findUniqueOrThrow({ where: { id: customerId } })).loyaltyPoints

/** Una venta cobrada que ya le dio sus puntos al cliente, por el camino de siempre. */
async function ventaConPuntos(customerId: string, saleCents: number, tipCents = 0) {
  const { order, pago } = await sembrarCobro({ venueId, staffId, saleCents, tipCents, commissionPercent: null })
  await prisma.order.update({ where: { id: order.id }, data: { customerId } })
  const earn = await earnPoints(venueId, customerId, saleCents / 100, order.id)
  return { orderId: order.id, pago, earn }
}

const reembolsar = (paymentId: string, amount: number, tipRefundCents = 0, idempotencyKey?: string) =>
  issueRefund({
    venueId,
    paymentId,
    amount,
    tipRefundCents,
    reason: 'RETURNED_GOODS',
    staffId,
    ...(idempotencyKey ? { idempotencyKey } : {}),
  })

/** El trabajador de verdad, hasta que el efecto de ESTE reembolso termine. */
async function correrElEfecto(refundPaymentId: string) {
  const job = new PaymentEffectsJob({ cron: { start: jest.fn(), stop: jest.fn() } })
  for (let i = 0; i < 20; i++) {
    await job.runNow()
    const fila = await prisma.paymentEffect.findFirstOrThrow({ where: { paymentId: refundPaymentId, kind: KIND } })
    if (fila.status === 'DONE') return
  }
  throw new Error('el efecto de puntos no terminó')
}

const reversas = (orderId: string) =>
  prisma.loyaltyTransaction.findMany({ where: { orderId, refundPaymentId: { not: null } }, orderBy: { createdAt: 'asc' } })

/** Un cobro o una devolución a mano, para sembrar lo que escribe un cambio de producto. */
function movimiento(orderId: string, pesos: number, extra: Partial<Prisma.PaymentUncheckedCreateInput> = {}) {
  const importe = new Prisma.Decimal(pesos)
  return prisma.payment.create({
    data: {
      venueId,
      orderId,
      amount: importe,
      tipAmount: 0,
      netAmount: importe,
      feePercentage: 0,
      feeAmount: 0,
      method: 'CASH',
      status: 'COMPLETED',
      type: pesos < 0 ? 'REFUND' : 'REGULAR',
      splitType: 'FULLPAYMENT',
      source: 'POS',
      fundsFlow: 'CASH_DRAWER',
      processedById: staffId,
      ...extra,
    },
  })
}

/** El registro del cambio (sin FK a la venta nueva: basta con los ids). */
const registrarCambio = (originalOrderId: string, newOrderId: string = cuid()) =>
  prisma.exchange.create({
    data: {
      venueId,
      idempotencyKey: `cambio-${cuid()}`,
      requestHash: 'a'.repeat(64),
      status: 'COMPLETED',
      originalOrderId,
      originalPaymentId: cuid(),
      newOrderId,
      returnedAmount: 100,
      takenAmount: 70,
      differenceAmount: -30,
      settlementKind: 'PAYOUT',
      settlementMethod: 'CASH',
      lines: [],
      staffId,
    },
  })

const marca = (role: 'CREDIT' | 'DIFFERENCE' | 'CHAIN', raiz: string) => ({
  processorData: { originalPaymentId: raiz, rootPaymentId: raiz, exchange: { exchangeId: cuid(), role, rootPaymentId: raiz } },
})

beforeAll(async () => {
  ;({ venueId, staffId } = await crearNegocioDePrueba('puntos-reembolso'))
  await prisma.loyaltyConfig.create({ data: { venueId, active: true, pointsPerDollar: 1, pointsPerVisit: 0 } })
  await abrirTurno(venueId, staffId)
})

afterAll(async () => {
  if (!venueId) return // Sin negocio no se borra NADA: un filtro con `venueId` indefinido vaciaría tablas enteras.
  await prisma.loyaltyTransaction.deleteMany({ where: { customer: { venueId } } })
  await prisma.exchange.deleteMany({ where: { venueId } })
  await limpiarNegocioDePrueba(venueId)
  await prisma.shift.deleteMany({ where: { venueId } })
  await prisma.customer.deleteMany({ where: { venueId } })
  await prisma.loyaltyConfig.deleteMany({ where: { venueId } })
  await prisma.$disconnect()
})

describe('D6 · al reembolsar se quitan los puntos de esa venta', () => {
  it('reembolso completo: se quitan todos y queda escrito en su historial', async () => {
    const c = await cliente()
    const { orderId, pago } = await ventaConPuntos(c, 10000)
    expect(await saldo(c)).toBe(100)

    const r = await reembolsar(pago.id, 10000)
    await correrElEfecto(r.refundId)

    expect(await saldo(c)).toBe(0)
    const [fila, ...demas] = await reversas(orderId)
    expect(demas).toEqual([])
    expect(fila).toMatchObject({ type: 'ADJUST', points: -100, customerId: c, refundPaymentId: r.refundId })
    expect(fila.reason).toContain('Reembolso completo')
    // Lo que lee el panel: tipo conocido, con descripción y con la venta.
    const { data } = await getLoyaltyTransactions(venueId, c, { type: 'ADJUST' })
    expect(data[0].reason).toContain('100')
    expect(data[0].order?.id).toBe(orderId)
    expect(data[0].refundPaymentId).toBe(r.refundId)
  })

  it('reembolso parcial: proporcional, redondeando hacia abajo lo que se conserva', async () => {
    const c = await cliente()
    const { pago } = await ventaConPuntos(c, 10000)
    const r = await reembolsar(pago.id, 3333)
    await correrElEfecto(r.refundId)
    // Conserva floor(100 × 66.67 / 100) = 66.
    expect(await saldo(c)).toBe(66)
  })

  it('dos parciales que completan la venta: el total quitado es exactamente lo ganado', async () => {
    const c = await cliente()
    const { orderId, pago } = await ventaConPuntos(c, 10000)
    const r1 = await reembolsar(pago.id, 3333)
    await correrElEfecto(r1.refundId)
    const r2 = await reembolsar(pago.id, 6667)
    await correrElEfecto(r2.refundId)
    expect(await saldo(c)).toBe(0)
    expect((await reversas(orderId)).map(f => f.points)).toEqual([-34, -66])
  })

  it('dos parciales que corren a la vez (dos aparatos): suman igual que en fila', async () => {
    const c = await cliente()
    const { orderId, pago } = await ventaConPuntos(c, 10000)
    const r1 = await reembolsar(pago.id, 2500)
    const r2 = await reembolsar(pago.id, 2500)
    await Promise.all([quitarPuntosPorReembolso(venueId, r1.refundId), quitarPuntosPorReembolso(venueId, r2.refundId)])
    expect(await saldo(c)).toBe(50)
    expect(await reversas(orderId)).toHaveLength(2)
  })

  it('sin saldo suficiente: baja a 0, deja rastro y no se cobra después de puntos nuevos', async () => {
    const c = await cliente()
    const { orderId, pago } = await ventaConPuntos(c, 10000)
    await adjustPoints(venueId, c, -90, 'ya los gastó', (await prisma.staffVenue.findFirstOrThrow({ where: { venueId, staffId } })).id)

    const r = await reembolsar(pago.id, 10000)
    await correrElEfecto(r.refundId)

    expect(await saldo(c)).toBe(0)
    const [fila] = await reversas(orderId)
    expect(fila.points).toBe(-10)
    expect(fila.reason).toContain('100')
    expect(fila.reason).toContain('10')

    // Puntos ganados después: un reintento de ESE reembolso no se cobra lo que faltó.
    await ventaConPuntos(c, 5000)
    await quitarPuntosPorReembolso(venueId, r.refundId)
    expect(await saldo(c)).toBe(50)
  })

  it('saldo en 0: la fila queda aunque no se quite nada', async () => {
    const c = await cliente()
    const { orderId, pago } = await ventaConPuntos(c, 10000)
    await prisma.customer.update({ where: { id: c }, data: { loyaltyPoints: 0 } })
    const r = await reembolsar(pago.id, 10000)
    await correrElEfecto(r.refundId)
    expect(await saldo(c)).toBe(0)
    expect((await reversas(orderId)).map(f => f.points)).toEqual([0])
  })

  it('un parcial posterior a uno sin saldo sigue contando desde lo que TOCABA quitar', async () => {
    const c = await cliente()
    const { orderId, pago } = await ventaConPuntos(c, 10000)
    await prisma.customer.update({ where: { id: c }, data: { loyaltyPoints: 10 } })
    const r1 = await reembolsar(pago.id, 5000) // tocaban 50, sólo había 10
    await correrElEfecto(r1.refundId)
    await prisma.customer.update({ where: { id: c }, data: { loyaltyPoints: 200 } })
    const r2 = await reembolsar(pago.id, 5000) // tocan los otros 50, no 90
    await correrElEfecto(r2.refundId)
    expect((await reversas(orderId)).map(f => f.points)).toEqual([-10, -50])
    expect(await saldo(c)).toBe(150)
  })

  it('más de 500 parciales: el acumulado sigue exacto y nunca quita de más', async () => {
    const c = await cliente()
    const { orderId, pago } = await ventaConPuntos(c, 10000)
    // 501 reversas ya escritas por $0.01 cada una ($5.01 → ya tocaron 6 puntos). Sembradas: 501 reembolsos reales tardarían minutos.
    const ids = Array.from({ length: 501 }, () => cuid())
    const base = { venueId, orderId, tipAmount: 0, netAmount: -0.01, feePercentage: 0, feeAmount: 0, processedById: staffId }
    await prisma.payment.createMany({
      data: ids.map(id => ({ ...base, id, amount: -0.01, method: 'CASH' as const, status: 'COMPLETED' as const, type: 'REFUND' as const })),
    })
    await prisma.loyaltyTransaction.createMany({
      data: ids.map(refundPaymentId => ({ customerId: c, type: 'ADJUST' as const, points: 0, orderId, refundPaymentId })),
    })

    const otra = await movimiento(orderId, -0.01, { processorData: { originalPaymentId: pago.id } })
    await quitarPuntosPorReembolso(venueId, otra.id)

    // $5.02 devueltos conservan floor(94.98) = 94, igual que $5.01: no toca quitar nada. Con el acumulado cortado en 500 salía 1 de más.
    expect((await prisma.loyaltyTransaction.findUniqueOrThrow({ where: { refundPaymentId: otra.id } })).points).toBe(0)
  })

  it('reintento: el efecto repetido y el mismo reembolso reenviado no quitan dos veces', async () => {
    const c = await cliente()
    const { orderId, pago } = await ventaConPuntos(c, 10000)
    const llave = `llave-${cuid()}`
    const r = await reembolsar(pago.id, 4000, 0, llave)
    await correrElEfecto(r.refundId)
    await quitarPuntosPorReembolso(venueId, r.refundId)
    await quitarPuntosPorReembolso(venueId, r.refundId)
    const repetido = await reembolsar(pago.id, 4000, 0, llave)
    expect(repetido.refundId).toBe(r.refundId)
    expect(await prisma.paymentEffect.count({ where: { paymentId: r.refundId, kind: KIND } })).toBe(1)
    await correrElEfecto(r.refundId)
    expect(await saldo(c)).toBe(60)
    expect(await reversas(orderId)).toHaveLength(1)
  })

  it('si la reversa falla, el reembolso sigue en pie, queda a la vista y se reintenta sola', async () => {
    const c = await cliente()
    const { pago } = await ventaConPuntos(c, 10000)
    const r = await reembolsar(pago.id, 10000)
    const espia = jest.spyOn(puntosAlReembolsar, 'quitarPuntosPorReembolso').mockRejectedValueOnce(new Error('la base se cayó'))
    await new PaymentEffectsJob({ cron: { start: jest.fn(), stop: jest.fn() } }).runNow()
    espia.mockRestore()

    expect(await prisma.payment.findUniqueOrThrow({ where: { id: r.refundId } })).toMatchObject({ status: 'COMPLETED', type: 'REFUND' })
    expect(await saldo(c)).toBe(100)
    const fila = await prisma.paymentEffect.findFirstOrThrow({ where: { paymentId: r.refundId, kind: KIND } })
    expect(fila).toMatchObject({ status: 'PENDING', attempts: 1, lastError: 'PAYMENT_EFFECT_EXECUTION_FAILED' })

    await prisma.paymentEffect.update({ where: { id: fila.id }, data: { nextAttemptAt: new Date(Date.now() - 1000) } })
    await correrElEfecto(r.refundId)
    expect(await saldo(c)).toBe(0)
  })

  it('la propina no cuenta: devolver sólo la propina no quita puntos, y la parte de venta manda', async () => {
    const c = await cliente()
    const { orderId, pago } = await ventaConPuntos(c, 10000, 2000)
    const soloPropina = await reembolsar(pago.id, 500, 500)
    await correrElEfecto(soloPropina.refundId)
    expect(await saldo(c)).toBe(100)
    expect(await reversas(orderId)).toEqual([])

    // $60 devueltos, $10 de propina: lo que cuenta son los $50 de venta.
    const mitad = await reembolsar(pago.id, 6000, 1000)
    await correrElEfecto(mitad.refundId)
    expect(await saldo(c)).toBe(50)
  })

  it('una venta que no dio puntos no quita nada, aunque el cliente tenga saldo', async () => {
    const c = await cliente()
    await ventaConPuntos(c, 5000)
    const { order, pago } = await sembrarCobro({ venueId, staffId, saleCents: 10000, commissionPercent: null })
    await prisma.order.update({ where: { id: order.id }, data: { customerId: c } })
    const r = await reembolsar(pago.id, 10000)
    await correrElEfecto(r.refundId)
    expect(await saldo(c)).toBe(50)
    expect(await reversas(order.id)).toEqual([])
  })

  it('pago manual con descuento: la proporción sale de lo que dio puntos, no del importe del cobro', async () => {
    const c = await cliente()
    // $100 de importe con $20 de descuento: la venta es de $80 y da 80 puntos, aunque el cobro guarda 100.
    const pago = await createManualPayment(venueId, staffId, {
      amount: '100.00',
      discountAmount: '20.00',
      tipAmount: '0',
      method: 'CASH',
      source: 'POS',
      customerId: c,
    } as Parameters<typeof createManualPayment>[2])
    expect(await saldo(c)).toBe(80)
    const mitad = await reembolsar(pago.id, 4000)
    await correrElEfecto(mitad.refundId)
    expect(await saldo(c)).toBe(40)
    const resto = await reembolsar(pago.id, 4000)
    await correrElEfecto(resto.refundId)
    expect(await saldo(c)).toBe(0)
  })

  it('pago manual con IVA: devolver todo lo devolvible quita todos, aunque la base de los puntos sea mayor', async () => {
    const c = await cliente()
    // $100 + $16 de IVA: da 116 puntos, pero el cobro guarda 100 y es lo único que se puede devolver.
    const pago = await createManualPayment(venueId, staffId, {
      amount: '100.00',
      taxAmount: '16.00',
      tipAmount: '0',
      method: 'CASH',
      source: 'POS',
      customerId: c,
    } as Parameters<typeof createManualPayment>[2])
    expect(await saldo(c)).toBe(116)
    const r = await reembolsar(pago.id, 10000)
    await correrElEfecto(r.refundId)
    expect(await saldo(c)).toBe(0)
  })

  it('un EARN de antes de D6 (sin base guardada) toma la base de su motivo', async () => {
    const c = await cliente()
    const { order, pago } = await sembrarCobro({ venueId, staffId, saleCents: 10000, commissionPercent: null })
    // Como lo dejaba un pago manual con $20 de descuento: el cobro dice 100 y los puntos salieron de 80.
    await prisma.loyaltyTransaction.create({
      data: { customerId: c, type: 'EARN', points: 80, orderId: order.id, reason: 'Earned 80 points for purchase of $80.00' },
    })
    await prisma.customer.update({ where: { id: c }, data: { loyaltyPoints: 80 } })
    const r = await reembolsar(pago.id, 8000)
    await correrElEfecto(r.refundId)
    expect(await saldo(c)).toBe(0)
  })

  it('la terminal también: `recordRefund` encola la reversa', async () => {
    const c = await cliente()
    const { pago } = await ventaConPuntos(c, 10000)
    const r = await recordRefund(
      venueId,
      {
        venueId,
        originalPaymentId: pago.id,
        amount: 10000,
        reason: 'CUSTOMER_REQUEST',
        authorizationNumber: 'AUT-1',
        referenceNumber: `REF-${cuid()}`,
        isPartialRefund: false,
        currency: 'MXN',
      },
      staffId,
    )
    await correrElEfecto(r.id)
    expect(await saldo(c)).toBe(0)
  })

  it('el reembolso de Uber también encola la reversa', async () => {
    const c = await cliente()
    const { orderId } = await ventaConPuntos(c, 10000)
    const externalOrderId = `uber-${cuid()}`
    await prisma.order.update({ where: { id: orderId }, data: { externalId: `UBER_EATS:${externalOrderId}` } })
    expect((await applyDeliveryRefund({ externalOrderId, provider: 'UBER_EATS', montoDevuelto: '25.00', motivo: 'queja' })).outcome).toBe(
      'APPLIED',
    )
    const refund = await prisma.payment.findFirstOrThrow({ where: { orderId, type: 'REFUND' } })
    await correrElEfecto(refund.id)
    expect(await saldo(c)).toBe(75)
  })

  describe('cambio de producto: sólo sobre la diferencia', () => {
    it('el gemelo del crédito no quita nada', async () => {
      const c = await cliente()
      const { orderId, pago } = await ventaConPuntos(c, 10000)
      const gemelo = await movimiento(orderId, -100, marca('CREDIT', pago.id))
      await quitarPuntosPorReembolso(venueId, gemelo.id)
      expect(await saldo(c)).toBe(100)
      expect(await reversas(orderId)).toEqual([])
    })

    it('la diferencia devuelta quita lo proporcional de la venta original', async () => {
      const c = await cliente()
      const { orderId, pago } = await ventaConPuntos(c, 10000)
      await movimiento(orderId, -70, marca('CREDIT', pago.id))
      const diferencia = await movimiento(orderId, -30, marca('DIFFERENCE', pago.id))
      await quitarPuntosPorReembolso(venueId, diferencia.id)
      expect(await saldo(c)).toBe(70)
    })

    it('devolver la venta nueva: lo pagado con crédito sale de la venta original y lo cobrado de más, de la nueva', async () => {
      const c = await cliente()
      const original = await ventaConPuntos(c, 10000)
      // La venta nueva: $130 = $100 de crédito + $30 cobrados. Sólo los $30 dieron puntos.
      const nueva = await ventaConPuntos(c, 3000)
      const tender = await prisma.venueTenderType.create({
        data: {
          venueId,
          name: 'Crédito de cambio',
          normalizedName: `credito-${cuid()}`,
          baseMethod: 'OTHER',
          isSystem: true,
          systemKind: 'EXCHANGE_CREDIT',
          countsAsPhysicalCash: false,
          captureTip: false,
          showOnPos: false,
          posSection: 'MORE',
          displayOrder: 99,
          satFormaPago: '99',
          revision: 1,
        },
      })
      await movimiento(nueva.orderId, 100, { tenderTypeId: tender.id, method: 'OTHER', fundsFlow: 'EXTERNAL_RECORDED' })
      expect(await saldo(c)).toBe(130)

      const cadena = await movimiento(nueva.orderId, -100, marca('CHAIN', original.pago.id))
      await quitarPuntosPorReembolso(venueId, cadena.id)
      expect(await saldo(c)).toBe(30)
      expect(await reversas(original.orderId)).toHaveLength(1)
      expect(await reversas(nueva.orderId)).toEqual([])

      const cobrado = await movimiento(nueva.orderId, -30, { processorData: { originalPaymentId: nueva.pago.id } })
      await quitarPuntosPorReembolso(venueId, cobrado.id)
      expect(await saldo(c)).toBe(0)
      expect(await reversas(nueva.orderId)).toHaveLength(1)
    })
  })

  describe('junto al otorgamiento', () => {
    it('reembolso ANTES de otorgar: no se otorga y nada resta de más', async () => {
      const c = await cliente()
      await ventaConPuntos(c, 2000)
      const { order, pago } = await sembrarCobro({ venueId, staffId, saleCents: 10000, commissionPercent: null })
      const r = await reembolsar(pago.id, 4000)
      await correrElEfecto(r.refundId)
      const earn = await earnPoints(venueId, c, 100, order.id)
      expect(earn.pointsEarned).toBe(0)
      expect(await saldo(c)).toBe(20)
      expect(await prisma.loyaltyTransaction.count({ where: { orderId: order.id } })).toBe(0)
    })

    it('no se cruza con un reembolso que tiene la venta y le abre su primer saldo a favor', async () => {
      const c = await cliente()
      const { orderId, pago } = await ventaConPuntos(c, 10000)
      const r = await reembolsar(pago.id, 2500)

      // El reembolso: la venta tomada `FOR UPDATE` y, ya con ella, la llave foránea de su sobre hacia el cliente.
      let reversa: Promise<void> | undefined
      await prisma.$transaction(
        async tx => {
          await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${orderId} FOR UPDATE`
          reversa = quitarPuntosPorReembolso(venueId, r.refundId)
          await esperarAQueAlguienEspereA(await pidDe(tx))
          await tx.$queryRaw`SELECT id FROM "Customer" WHERE id = ${c} FOR KEY SHARE`
        },
        { timeout: 30_000 },
      )
      await reversa
      expect(await saldo(c)).toBe(75)
    })

    it('reembolso MIENTRAS se otorga: la reversa espera el candado de la venta y ve los puntos', async () => {
      const c = await cliente()
      const { order, pago } = await sembrarCobro({ venueId, staffId, saleCents: 10000, commissionPercent: null })
      const r = await reembolsar(pago.id, 10000)

      let soltar!: () => void
      const hastaSoltar = new Promise<void>(resolve => (soltar = resolve))
      let pidListo!: (pid: number) => void
      const pid = new Promise<number>(resolve => (pidListo = resolve))
      const otorgamiento = prisma.$transaction(
        async tx => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${venueId}), hashtext(${order.id}))`
          await tx.loyaltyTransaction.create({ data: { customerId: c, type: 'EARN', points: 100, orderId: order.id } })
          await tx.customer.update({ where: { id: c }, data: { loyaltyPoints: { increment: 100 } } })
          pidListo(await pidDe(tx))
          await hastaSoltar
        },
        { timeout: 30_000 },
      )
      const reversa = quitarPuntosPorReembolso(venueId, r.refundId)
      await esperarAQueAlguienEspereA(await pid)
      soltar()
      await otorgamiento
      await reversa
      expect(await saldo(c)).toBe(0)
    })

    it('cambio ANTES de otorgar: la diferencia devuelta baja los puntos aunque su reversa ya hubiera corrido', async () => {
      const c = await cliente()
      const { order, pago } = await sembrarCobro({ venueId, staffId, saleCents: 10000, commissionPercent: null })
      await registrarCambio(order.id)
      const gemelo = await movimiento(order.id, -70, marca('CREDIT', pago.id))
      const diferencia = await movimiento(order.id, -30, marca('DIFFERENCE', pago.id))
      await quitarPuntosPorReembolso(venueId, diferencia.id) // corre sin encontrar EARN

      const earn = await earnPoints(venueId, c, 100, order.id)

      expect(earn).toMatchObject({ pointsEarned: 100, newBalance: 70 })
      expect(await saldo(c)).toBe(70)
      expect((await reversas(order.id)).map(f => [f.refundPaymentId, f.points])).toEqual([[diferencia.id, -30]])
      expect(gemelo.id).toBeTruthy()
      // El efecto repetido no quita otra vez.
      await quitarPuntosPorReembolso(venueId, diferencia.id)
      expect(await saldo(c)).toBe(70)
    })

    it('cambio ANTES de otorgar: lo devuelto por la cadena en la venta nueva baja los puntos de la original', async () => {
      const c = await cliente()
      const original = await sembrarCobro({ venueId, staffId, saleCents: 10000, commissionPercent: null })
      const nueva = await sembrarCobro({ venueId, staffId, saleCents: 10000, commissionPercent: null })
      await registrarCambio(original.order.id, nueva.order.id)
      const cadena = await movimiento(nueva.order.id, -100, marca('CHAIN', original.pago.id))
      await quitarPuntosPorReembolso(venueId, cadena.id)

      await earnPoints(venueId, c, 100, original.order.id)

      expect(await saldo(c)).toBe(0)
      expect((await reversas(original.order.id)).map(f => f.refundPaymentId)).toEqual([cadena.id])
    })

    it('cambio ANTES de otorgar con más devoluciones que una página: las pone al corriente todas', async () => {
      const c = await cliente()
      const { order, pago } = await sembrarCobro({ venueId, staffId, saleCents: 10000, commissionPercent: null })
      await registrarCambio(order.id)
      const m = marca('DIFFERENCE', pago.id)
      const fila = { venueId, orderId: order.id, tipAmount: 0, netAmount: -0.01, feePercentage: 0, feeAmount: 0, processedById: staffId }
      await prisma.payment.createMany({
        data: Array.from({ length: 101 }, () => ({
          ...fila,
          id: cuid(),
          amount: -0.01,
          method: 'CASH' as const,
          status: 'COMPLETED' as const,
          type: 'REFUND' as const,
          processorData: m.processorData,
        })),
      })

      await earnPoints(venueId, c, 100, order.id)

      expect(await reversas(order.id)).toHaveLength(101)
      expect(await saldo(c)).toBe(98) // $1.01 devueltos conservan floor(98.99)
    })

    it('un cambio parejo antes de otorgar conserva todos los puntos', async () => {
      const c = await cliente()
      const { order, pago } = await sembrarCobro({ venueId, staffId, saleCents: 10000, commissionPercent: null })
      await registrarCambio(order.id)
      await movimiento(order.id, -100, marca('CREDIT', pago.id))
      await earnPoints(venueId, c, 100, order.id)
      expect(await saldo(c)).toBe(100)
      expect(await reversas(order.id)).toEqual([])
    })

    it('otorgar después de una reversa no regala: un reintento del cobro no vuelve a sumar', async () => {
      const c = await cliente()
      const { orderId, pago } = await ventaConPuntos(c, 10000)
      const r = await reembolsar(pago.id, 10000)
      await correrElEfecto(r.refundId)
      await earnPoints(venueId, c, 100, orderId)
      expect(await saldo(c)).toBe(0)
    })
  })
})

describe('D7 · el bono por visita', () => {
  beforeAll(() => conPuntos(10))
  afterAll(() => conPuntos(0))

  it('una venta suma el bono una sola vez, también con reintentos', async () => {
    const c = await cliente()
    const { orderId, earn } = await ventaConPuntos(c, 5000)
    expect(earn.pointsEarned).toBe(60)
    await earnPoints(venueId, c, 50, orderId)
    expect(await saldo(c)).toBe(60)
    expect(await prisma.loyaltyTransaction.findFirstOrThrow({ where: { orderId, type: 'EARN' } })).toMatchObject({
      points: 60,
      visitBonusPoints: 10,
    })
  })

  it('una venta en $0 no da bono', async () => {
    const c = await cliente()
    const { order } = await sembrarCobro({ venueId, staffId, saleCents: 100, commissionPercent: null })
    expect((await earnPoints(venueId, c, 0, order.id)).pointsEarned).toBe(0)
    expect(await saldo(c)).toBe(0)
  })

  it('parcial: el bono se queda y baja lo proporcional del gasto', async () => {
    const c = await cliente()
    const { pago } = await ventaConPuntos(c, 10000)
    expect(await saldo(c)).toBe(110)
    const r = await reembolsar(pago.id, 5000)
    await correrElEfecto(r.refundId)
    expect(await saldo(c)).toBe(60)
  })

  it('completo: se quita también el bono', async () => {
    const c = await cliente()
    const { pago } = await ventaConPuntos(c, 10000)
    const r1 = await reembolsar(pago.id, 5000)
    await correrElEfecto(r1.refundId)
    const r2 = await reembolsar(pago.id, 5000)
    await correrElEfecto(r2.refundId)
    expect(await saldo(c)).toBe(0)
  })
})

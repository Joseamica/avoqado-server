/**
 * El gemelo del crédito de un cambio escrito por el núcleo del reembolso (`writeRefundInTx` con `moneyAs`), contra un Postgres
 * real (spec `docs/superpowers/specs/2026-10-20-cambio-de-producto-design.md` §6.2):
 * - sobre un cobro con tarjeta, la fila del crédito NO hereda la tarjeta: es `OTHER`, fuera del banco, sin comercio y con el
 *   tender «Crédito de cambio» (forma SAT 17);
 * - no reabre la obligación de costo del cobro con tarjeta (no regresó dinero por el procesador: no hay comisión que revertir);
 * - sí baja la venta del turno vivo, como cualquier devolución: la venta nueva la vuelve a subir con su cobro de crédito;
 * - el ancla de $0 (una pieza que cobró $0) se guarda con sus cantidades y no mueve dinero.
 *
 * Correr (sólo en una base DESECHABLE, nunca av-db-25): exporta TEST_DATABASE_URL hacia ella y luego
 *   TZ=UTC npx jest --selectProjects=integration --runTestsByPath tests/integration/exchanges/writeRefundMoneyAs.integration.test.ts --runInBand --ci
 *
 * Cada corrida usa su propio negocio con nombres únicos y sólo limpia lo de ese negocio.
 */
import { Prisma, type Payment } from '@prisma/client'
import { randomUUID } from 'crypto'
import prisma from '@/utils/prismaClient'

jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { broadcastToUser: jest.fn(), getBroadcastingService: jest.fn(() => null) },
}))
jest.mock('@/services/dashboard/activity-log.service', () => ({ __esModule: true, logAction: jest.fn(async () => undefined) }))

import { writeRefundInTx, type WriteRefundInput } from '@/services/shared/writeRefundInTx'
import type { RefundMoneySemantics } from '@/services/dashboard/refund.dashboard.service'
import { ensureExchangeCreditTender, resolveExchangeCreditTenderInTx } from '@/services/exchanges/exchangeCreditTender'
import { crearNegocioDePrueba, limpiarNegocioDePrueba } from '../giftCards/sembrarTarjetasDeRegalo'

jest.setTimeout(60000)

const D = (pesos: number) => new Prisma.Decimal(pesos)
const SUF = `cambio-moneyas-${process.pid}-${Date.now()}`
let venueId: string
let staffId: string
let ecTenderId: string
let merchantId: string
let shiftId: string
let n = 0

beforeAll(async () => {
  ;({ venueId, staffId } = await crearNegocioDePrueba('cambio-moneyas'))
  ecTenderId = (await ensureExchangeCreditTender(prisma, venueId)).id
  const provider = await prisma.paymentProvider.upsert({
    where: { code: 'ANGELPAY' },
    update: {},
    create: { code: 'ANGELPAY', name: 'AngelPay', type: 'PAYMENT_PROCESSOR', countryCode: ['MX'] },
  })
  merchantId = (
    await prisma.merchantAccount.create({
      data: {
        providerId: provider.id,
        externalMerchantId: `${SUF}-${randomUUID().slice(0, 8)}`,
        alias: 'Tarjeta de prueba',
        credentialsEncrypted: {},
      },
    })
  ).id
  shiftId = (
    await prisma.shift.create({ data: { venueId, staffId, startTime: new Date(), status: 'OPEN', startingCash: 0, totalSales: D(500) } })
  ).id
})

afterAll(async () => {
  // Sin negocio no se borra NADA: un filtro con `venueId` indefinido vaciaría tablas enteras.
  if (!venueId) return
  await limpiarNegocioDePrueba(venueId) // sus cobros, devoluciones y VenueTransaction se van con las órdenes
  await prisma.shift.deleteMany({ where: { venueId } })
  if (merchantId) await prisma.merchantAccount.deleteMany({ where: { id: merchantId } })
  await prisma.$disconnect()
})

/** Un cobro con tarjeta ya liquidado por Avoqado, con su obligación de costo YA cumplida (`TRANSACTION_COST` en DONE). */
async function cobroConTarjeta(pesos: number): Promise<Payment> {
  const orderId = (
    await prisma.order.create({
      data: {
        venueId,
        orderNumber: `${SUF}-${++n}`,
        type: 'TAKEOUT',
        source: 'TPV',
        status: 'COMPLETED',
        completedAt: new Date(),
        subtotal: D(pesos),
        taxAmount: D(0),
        tipAmount: D(0),
        total: D(pesos),
        paidAmount: D(pesos),
        remainingBalance: D(0),
        paymentStatus: 'PAID',
        contratoDePrecio: 'IVA_INCLUIDO',
        createdById: staffId,
      },
    })
  ).id
  const pago = await prisma.payment.create({
    data: {
      venueId,
      orderId,
      amount: D(pesos),
      tipAmount: D(0),
      netAmount: D(pesos),
      feePercentage: 0,
      feeAmount: D(0),
      method: 'CREDIT_CARD',
      status: 'COMPLETED',
      type: 'REGULAR',
      splitType: 'FULLPAYMENT',
      source: 'TPV',
      fundsFlow: 'AVOQADO_PROCESSED',
      merchantAccountId: merchantId,
      processedById: staffId,
    },
  })
  await prisma.paymentEffect.create({
    data: {
      venueId,
      paymentId: pago.id,
      orderId,
      kind: 'TRANSACTION_COST',
      dedupeKey: `transaction-cost:${pago.id}:v1`,
      payload: {},
      status: 'DONE',
      completedAt: new Date(),
    },
  })
  return pago
}

/** La semántica del crédito, resuelta por el servidor dentro de la transacción (como la pasará el cambio). */
async function semanticaDelCredito(tx: Prisma.TransactionClient, original: Payment): Promise<RefundMoneySemantics> {
  const ec = await resolveExchangeCreditTenderInTx(tx, venueId)
  return {
    method: ec.method,
    fundsFlow: ec.fundsFlow,
    merchantAccountId: null,
    source: original.source,
    tenderTypeId: ec.tenderTypeId,
    tenderRevision: ec.tenderRevision,
    tenderLabel: ec.tenderLabel,
    tenderCountsAsCash: ec.tenderCountsAsCash,
    tenderCaptureTip: ec.tenderCaptureTip,
    tenderSatFormaPago: ec.tenderSatFormaPago,
  }
}

const devolucion = (original: Payment, extra: Partial<WriteRefundInput>): WriteRefundInput =>
  ({
    originalPaymentId: original.id,
    venueId,
    salesRefundCents: 12000,
    tipRefundCents: 0,
    refundedItems: [],
    reason: 'RETURNED_GOODS',
    note: 'Cambio de talla',
    staffId,
    tenderCommission: 'NONE',
    shift: 'CLAIM_LIVE',
    provenance: 'MANUAL',
    ...extra,
  }) as WriteRefundInput

const ventaDelTurno = async () => (await prisma.shift.findUniqueOrThrow({ where: { id: shiftId } })).totalSales.toString()
const efectoDeCosto = (paymentId: string) =>
  prisma.paymentEffect.findFirstOrThrow({
    where: { paymentId, kind: 'TRANSACTION_COST' },
    select: { status: true, lastError: true, payload: true },
  })

it('a credit refund over a real card payment leaves no TRANSACTION_COST effect reopened and lowers Shift.totalSales by the credit', async () => {
  const pago = await cobroConTarjeta(200)
  const ventaAntes = await ventaDelTurno()

  const { refundPaymentId } = await prisma.$transaction(async tx =>
    writeRefundInTx(
      tx,
      devolucion(pago, {
        moneyAs: await semanticaDelCredito(tx, pago),
        skipNegativeCostObligation: true,
        exchangeMark: { exchangeId: null, role: 'CREDIT', rootPaymentId: pago.id },
      }),
    ),
  )

  const fila = await prisma.payment.findUniqueOrThrow({ where: { id: refundPaymentId } })
  expect(fila).toMatchObject({
    type: 'REFUND',
    method: 'OTHER',
    fundsFlow: 'EXTERNAL_RECORDED',
    merchantAccountId: null,
    source: 'TPV',
    tenderTypeId: ecTenderId,
    tenderRevision: 1,
    tenderLabel: 'Crédito de cambio',
    tenderCountsAsCash: false,
    tenderCaptureTip: false,
    tenderSatFormaPago: '17',
    tenderCommissionPercent: null,
    tenderCommissionAmount: null,
    shiftId,
  })
  expect(fila.amount.toString()).toBe('-120')
  expect(fila.processorData).toMatchObject({
    originalPaymentId: pago.id,
    originalMethod: 'CREDIT_CARD',
    exchange: { exchangeId: null, role: 'CREDIT', rootPaymentId: pago.id },
  })
  expect(fila.processorData).not.toHaveProperty('rootPaymentId')

  // La obligación de costo del cobro con tarjeta sigue cumplida: el crédito no regresó dinero por el procesador.
  expect(await efectoDeCosto(pago.id)).toEqual({ status: 'DONE', lastError: null, payload: {} })
  // La venta del turno baja por el crédito (la venta nueva la sube con su cobro de crédito).
  expect(ventaAntes).toBe('500')
  expect(await ventaDelTurno()).toBe('380')

  // Lo que el núcleo deja en el libro de VenueTransaction para la fila del crédito (el cambio lo netea con el cobro de crédito).
  const vt = await prisma.venueTransaction.findUniqueOrThrow({ where: { paymentId: refundPaymentId } })
  expect({
    type: vt.type,
    gross: vt.grossAmount.toString(),
    fee: vt.feeAmount.toString(),
    net: vt.netAmount.toString(),
    status: vt.status,
  }).toEqual({
    type: 'REFUND',
    gross: '-120',
    fee: '0',
    net: '-120',
    status: 'SETTLED',
  })

  // Control: una devolución de siempre del mismo tipo de cobro SÍ reabre su obligación (la siembra es la de un cobro real).
  const otro = await cobroConTarjeta(200)
  await prisma.$transaction(tx => writeRefundInTx(tx, devolucion(otro, {})))
  expect(await efectoDeCosto(otro.id)).toMatchObject({ status: 'PENDING', lastError: 'REFUND_COST' })
  expect(await ventaDelTurno()).toBe('260')
})

it('a $0 credit anchor is stored with its quantities and moves no money', async () => {
  const pago = await cobroConTarjeta(150)
  const ventaAntes = await ventaDelTurno()
  const renglon = await prisma.orderItem.create({
    data: { orderId: pago.orderId!, productName: 'Playera cortesía', quantity: 1, unitPrice: D(0), taxAmount: D(0), total: D(0) },
  })

  const { refundPaymentId } = await prisma.$transaction(async tx =>
    writeRefundInTx(
      tx,
      devolucion(pago, {
        salesRefundCents: 0,
        refundedItems: [{ orderItemId: renglon.id, quantity: 1, amountCents: 0 }],
        moneyAs: await semanticaDelCredito(tx, pago),
        skipNegativeCostObligation: true,
        exchangeMark: { exchangeId: null, role: 'CREDIT', rootPaymentId: pago.id },
      }),
    ),
  )

  const fila = await prisma.payment.findUniqueOrThrow({ where: { id: refundPaymentId } })
  expect(fila.amount.isZero()).toBe(true)
  expect(fila.tenderTypeId).toBe(ecTenderId)
  expect(fila.processorData).toMatchObject({ amountCents: 0, refundedItems: [{ orderItemId: renglon.id, quantity: 1, amountCents: 0 }] })
  expect(await ventaDelTurno()).toBe(ventaAntes)
  expect(await efectoDeCosto(pago.id)).toMatchObject({ status: 'DONE' })

  // Fuera del camino del crédito, el $0 se sigue rechazando y no se escribe nada.
  await expect(prisma.$transaction(tx => writeRefundInTx(tx, devolucion(pago, { salesRefundCents: 0 })))).rejects.toThrow(
    'El monto a devolver debe ser mayor que cero.',
  )
  expect(await prisma.payment.count({ where: { type: 'REFUND', orderId: pago.orderId } })).toBe(1)
})
